import type { Config, People } from "../config";
import type { Activity } from "../types";
import { classify } from "../worktype";

/** Shells out to the already-authenticated `gh` CLI — no token to manage here. */
async function gh(args: string[]): Promise<any> {
  const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(" ")} failed:\n${err.trim()}`);
  return JSON.parse(out);
}

const PER_PAGE = 100;
const MAX_PAGES = 10; // GitHub search caps at 1000 results regardless

async function search(q: string): Promise<any[]> {
  const items: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await gh([
      "api", "-X", "GET", "search/issues",
      "-f", `q=${q}`,
      // Required since GitHub's 2025 search migration; without it this 404s.
      "-f", "advanced_search=true",
      "-f", `per_page=${PER_PAGE}`,
      "-f", `page=${page}`,
    ]);
    items.push(...(res.items ?? []));
    if ((res.items?.length ?? 0) < PER_PAGE) break;
  }
  return items;
}

function scopeOf(cfg: Config): string {
  const g = cfg.github;
  if (g?.repos?.length) return g.repos.map((r) => `repo:${r}`).join(" ");
  if (g?.org) return `org:${g.org}`;
  return ""; // unscoped: everything the token can see
}

/** "https://api.github.com/repos/acme/web" -> "acme/web" */
function repoOf(item: any): string {
  return String(item.repository_url ?? "").split("/repos/")[1] ?? "";
}

function labelsOf(item: any): string[] {
  return (item.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name)).filter(Boolean);
}

export async function collectGithub(
  cfg: Config,
  people: People,
  since: Date,
): Promise<Activity[]> {
  const day = since.toISOString().slice(0, 10);
  const scope = scopeOf(cfg);
  const out: Activity[] = [];
  const prs = new Map<string, { repo: string; number: number }>();

  for (const person of people.all) {
    if (!person.github) continue;

    const authored = await search(`is:pr author:${person.github} updated:>=${day} ${scope}`.trim());
    for (const item of authored) {
      const repo = repoOf(item);
      if (repo) prs.set(`${repo}#${item.number}`, { repo, number: item.number });

      const workType = classify(item.title, labelsOf(item));
      const base = {
        source: "github" as const,
        personId: person.id,
        workType,
        url: item.html_url,
        title: item.title,
        meta: { repo, number: item.number, draft: item.draft ?? false },
      };

      if (item.created_at && new Date(item.created_at) >= since) {
        out.push({ ...base, id: `github:pr_opened:${item.id}`, type: "pr_opened", ts: item.created_at });
      }
      const mergedAt = item.pull_request?.merged_at;
      if (mergedAt && new Date(mergedAt) >= since) {
        out.push({ ...base, id: `github:pr_merged:${item.id}`, type: "pr_merged", ts: mergedAt });
      }
    }

    // Reviews the team gave on PRs they did not author — discovered here, but the
    // events themselves come from the reviews endpoint below so the timestamps are
    // real submission times rather than the PR's coarse updated_at.
    const reviewed = await search(`is:pr reviewed-by:${person.github} updated:>=${day} ${scope}`.trim());
    for (const item of reviewed) {
      const repo = repoOf(item);
      if (repo) prs.set(`${repo}#${item.number}`, { repo, number: item.number });
    }
  }

  for (const { repo, number } of prs.values()) {
    let reviews: any[];
    try {
      reviews = await gh(["api", `repos/${repo}/pulls/${number}/reviews`, "--paginate"]);
    } catch {
      continue; // deleted repo, lost access, transient — one PR is not worth failing the sync
    }
    for (const r of reviews) {
      const login = r.user?.login?.toLowerCase();
      const personId = login && people.byGithub.get(login);
      if (!personId || !r.submitted_at) continue;
      if (new Date(r.submitted_at) < since) continue;
      out.push({
        id: `github:pr_reviewed:${r.id}`,
        source: "github",
        type: "pr_reviewed",
        personId,
        ts: r.submitted_at,
        url: r.html_url,
        title: `review on ${repo}#${number}`,
        meta: { repo, number, state: r.state },
      });
    }
  }

  return out;
}
