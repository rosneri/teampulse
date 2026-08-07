import { arrivedViaPullRequest } from "../commitmessage";
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

/**
 * Search takes a scope as a query fragment, but walking commits needs actual
 * repository names. An unscoped config can't produce them — search can ask
 * GitHub "everything this token sees", a commit listing cannot — so that case
 * collects pull requests only.
 */
async function repositoriesOf(cfg: Config): Promise<string[]> {
  const g = cfg.github;
  if (g?.repos?.length) return g.repos;
  if (!g?.org) return [];
  const repositories: any[] = await gh(["api", `orgs/${g.org}/repos`, "--paginate"]);
  return repositories.map((r) => String(r.full_name)).filter(Boolean);
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
    if (!person.githubLogins.length) continue;

    // A person may commit under more than one login. Search each and credit them
    // all to the same canonical id, deduplicating on the event id downstream.
    const authored: any[] = [];
    for (const login of person.githubLogins) {
      authored.push(...(await search(`is:pr author:${login} updated:>=${day} ${scope}`.trim())));
    }

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
    for (const login of person.githubLogins) {
      const reviewed = await search(`is:pr reviewed-by:${login} updated:>=${day} ${scope}`.trim());
      for (const item of reviewed) {
        const repo = repoOf(item);
        if (repo) prs.set(`${repo}#${item.number}`, { repo, number: item.number });
      }
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

  out.push(...(await collectCommits(cfg, people, since)));

  return out;
}

const MAX_COMMIT_PAGES = 50; // 5000 commits per repository per sync

/**
 * Work that reached the default branch without a pull request — on a team that
 * pushes straight to master, this is most of what gets built, and counting only
 * pull requests makes those people look idle.
 *
 * Commits that arrived through a merged pull request are skipped so they are not
 * counted twice alongside the `pr_merged` row for the same work.
 * ponytail: that skip reads the merge's shape and GitHub's default message. A
 * rebase-merged pull request whose commits were rewritten with custom messages
 * leaves no trace to match on and will be counted twice; if that starts
 * mattering, resolve each commit through `repos/{repo}/commits/{sha}/pulls`.
 */
async function collectCommits(cfg: Config, people: People, since: Date): Promise<Activity[]> {
  const out: Activity[] = [];

  for (const repository of await repositoriesOf(cfg)) {
    for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
      let commits: any[];
      try {
        // No `sha` parameter: GitHub defaults to the repository's default branch,
        // which is exactly the "did this ship" line we want.
        commits = await gh([
          "api", "-X", "GET", `repos/${repository}/commits`,
          "-f", `since=${since.toISOString()}`,
          "-f", `per_page=${PER_PAGE}`,
          "-f", `page=${page}`,
        ]);
      } catch {
        break; // empty repository, lost access, transient — one repository is not worth failing the sync
      }

      for (const commit of commits) {
        const message = String(commit.commit?.message ?? "");
        const subject = message.split("\n")[0] ?? "";
        if (arrivedViaPullRequest(subject, commit.parents?.length ?? 0)) continue;

        const login = commit.author?.login?.toLowerCase();
        const personId = login && people.byGithub.get(login);
        if (!personId) continue;

        // Committer date, not author date: it is what `since` filters on, so a
        // rebased commit cannot land in the page yet fall outside the window.
        const ts = commit.commit?.committer?.date ?? commit.commit?.author?.date;
        if (!ts || new Date(ts) < since) continue;

        out.push({
          id: `github:commit_pushed:${repository}@${commit.sha}`,
          source: "github",
          type: "commit_pushed",
          personId,
          workType: classify(subject, []),
          ts,
          url: commit.html_url,
          title: subject,
          meta: { repo: repository, sha: commit.sha },
        });
      }

      if (commits.length < PER_PAGE) break;
    }
  }

  return out;
}
