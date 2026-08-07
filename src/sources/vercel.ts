import type { People } from "../config";
import type { Activity } from "../types";

/** Deployments, which is the only Vercel event that is somebody's work rather than a build's. */

const API = "https://api.vercel.com";

type Deployment = {
  uid: string;
  name?: string;
  url?: string;
  inspectorUrl?: string;
  created?: number;
  target?: string | null;
  state?: string;
  creator?: { username?: string; email?: string };
};

/** A real id is `team_…`; anything else is the slug the CLI prints. Empty means a personal account. */
export function scopeOf(team: string | undefined, url: URL): URL {
  if (!team) return url;
  url.searchParams.set(team.startsWith("team_") ? "teamId" : "slug", team);
  return url;
}

export async function collectVercel(people: People, since: Date): Promise<Activity[]> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN not set");

  const out: Activity[] = [];
  // A deployment by an unrecognised creator and an empty account both read as
  // "0 events" on the sync line. Name the handles so the gap is fixable.
  const unknownCreators = new Set<string>();
  // Vercel pages backwards in time: `until` is the oldest deployment seen so far.
  let until: number | undefined;

  for (;;) {
    const url = new URL(`${API}/v6/deployments`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("since", String(since.getTime()));
    if (until) url.searchParams.set("until", String(until));
    // `vercel teams ls` prints slugs under a column headed "id", so that is what
    // ends up in .env far more often than a real team_… id. The API takes each
    // under its own parameter, and sending a slug as `teamId` fails with a
    // "team not found" that reads like a permissions problem.
    scopeOf(process.env.VERCEL_TEAM_ID, url);

    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const json = (await response.json()) as any;
    if (!response.ok) throw new Error(`vercel: ${json?.error?.message ?? response.statusText}`);

    const deployments: Deployment[] = json.deployments ?? [];
    for (const deployment of deployments) {
      if (!deployment.created || !deployment.uid) continue;

      // The creator is a username; people.yaml maps that, and falls back to the
      // local part of the person's email, which is what it usually is anyway.
      const handle = (deployment.creator?.username ?? deployment.creator?.email?.split("@")[0] ?? "")
        .toLowerCase();
      const personId = handle && people.byVercel.get(handle);
      if (!personId) {
        if (handle) unknownCreators.add(handle);
        continue;
      }

      out.push({
        id: `vercel:deployed:${deployment.uid}`,
        source: "vercel",
        type: "deployed",
        personId,
        ts: new Date(deployment.created).toISOString(),
        url: deployment.inspectorUrl ?? (deployment.url ? `https://${deployment.url}` : undefined),
        title: `deployed ${deployment.name ?? "project"}${deployment.target === "production" ? " to production" : ""}`,
        meta: {
          project: deployment.name ?? null,
          target: deployment.target ?? null,
          state: deployment.state ?? null,
        },
      });
    }

    const next = json.pagination?.next;
    if (!next || !deployments.length) break;
    until = next;
  }

  if (!out.length && unknownCreators.size) {
    console.warn(
      `  vercel: deployments exist but none belong to anybody in people.yaml — ` +
        `add \`email:\` or \`vercel:\` for these creators: ${[...unknownCreators].sort().join(", ")}`,
    );
  }

  return out;
}
