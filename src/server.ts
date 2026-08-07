import { indexPeople, loadConfig, parseSince } from "./config";
import {
  activityFeed, bugRatio, dailyCounts, hourlyCounts, intakeMix, personStats,
  repositories, reviewWaits, shippedMix, staleIssues, teamStats,
} from "./metrics";
import { SOURCES, type SyncResult, isSource, sync } from "./sync";
import index from "./ui/index.html";

/**
 * Read-only HTTP wrapper around metrics.ts. Every number still comes from the
 * same SQL the CLI prints — this file writes no queries of its own.
 */

const configuration = await loadConfig();
const people = indexPeople(configuration);

/** `?since=` is user input: a bad value is a 400, never a 500. */
function windowOf(url: string): Date | null {
  try {
    return parseSince(new URL(url).searchParams.get("since") ?? "30d");
  } catch {
    return null;
  }
}

/**
 * `?repo=` narrows to one repository. Three distinct cases, on purpose:
 *   absent   — the reader has expressed no preference, so `github.mainRepo` applies
 *   empty    — the reader explicitly asked for every repository
 *   a value  — that repository
 * Resolving the default here rather than in the browser keeps the first page load
 * to a single request, with no flash of the wrong scope.
 */
function repositoryOf(url: string): string | undefined {
  const parameter = new URL(url).searchParams.get("repo");
  if (parameter === null) return configuration.github?.mainRepo || undefined;
  return parameter || undefined;
}

/**
 * `?tz=` is the zone the reader's clock is in — the browser sends its own, so
 * "10:00" on the heat map is ten in the morning where the page is being read.
 * One zone for the whole team, not one per person: everyone in people.yaml
 * shares a country today, and a per-person zone would need a field nobody has
 * asked for yet. Validated here so a bad name is a 400, not a database error.
 */
function timezoneOf(url: string): string | null {
  const parameter = new URL(url).searchParams.get("tz");
  if (!parameter) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: parameter });
    return parameter;
  } catch {
    return null;
  }
}

const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3737),
  development: process.env.NODE_ENV !== "production",
  // A sync holds its request open while it pulls three APIs, well past the
  // 10-second default. 255 is the highest Bun accepts.
  idleTimeout: 255,
  routes: {
    "/": index,

    "/api/team": async (req) => {
      const since = windowOf(req.url);
      if (!since) return bad("bad ?since — use 30d, 12w, 6m or a date");

      const timezone = timezoneOf(req.url);
      if (!timezone) return bad("bad ?tz — use an IANA name like Asia/Jerusalem");

      const repository = repositoryOf(req.url);

      const [stats, waits, days, hours, team, ship, intake, bugs, stale, repos] = await Promise.all([
        personStats(since, repository), reviewWaits(since, repository),
        dailyCounts(since, repository), hourlyCounts(since, timezone, repository),
        teamStats(since, repository),
        shippedMix(since, repository), intakeMix(since, repository),
        bugRatio(since, repository), staleIssues(), repositories(since),
      ]);

      return Response.json({
        since: since.toISOString(),
        timezone,
        repository: repository ?? null,
        mainRepository: configuration.github?.mainRepo ?? null,
        repositories: repos,
        people: configuration.people.map((person) => ({
          id: person.id,
          name: person.name,
          workWeek: person.workWeek,
        })),
        team, stats, waits, days, hours, ship, intake, bugs, stale,
      });
    },

    /**
     * Pulls the sources and returns what each one did. The request is held open
     * for the whole pull — a sync is a foreground action a person just asked
     * for, not a background job, and there is nothing here worth a queue.
     *
     * State-changing and unauthenticated: the server binds localhost, and this
     * needs an auth layer before it is ever exposed beyond it.
     */
    "/api/sync": {
      POST: async (req) => {
        const since = windowOf(req.url);
        if (!since) return bad("bad ?since — use 30d, 12w, 6m or a date");

        const requested = new URL(req.url).searchParams.getAll("source");
        const unknown = requested.filter((source) => !isSource(source));
        if (unknown.length) {
          return bad(`unknown source ${unknown.join(", ")} — use one of: ${SOURCES.join(", ")}`);
        }

        const results: SyncResult[] = await sync(
          since,
          requested.filter(isSource),
        );
        for (const result of results) {
          console.log(
            result.error
              ? `${result.label}: FAILED — ${result.error}`
              : `${result.label}: ${result.collected} events, ${result.saved} new`,
          );
        }
        return Response.json({ results });
      },
    },

    "/api/person/:id": async (req) => {
      const since = windowOf(req.url);
      if (!since) return bad("bad ?since — use 30d, 12w, 6m or a date");

      // Only ids that exist in people.yaml are ever queried.
      const p = people.byId.get(req.params.id);
      if (!p) return bad("unknown person", 404);

      const repository = repositoryOf(req.url);
      const [stats, waits, feed] = await Promise.all([
        personStats(since, repository),
        reviewWaits(since, repository),
        activityFeed({ personId: p.id, since, limit: 40, repository }),
      ]);

      return Response.json({
        person: { id: p.id, name: p.name },
        stats: stats.find((s) => s.person_id === p.id) ?? null,
        wait: waits.find((w) => w.person_id === p.id) ?? null,
        feed,
      });
    },
  },
});

console.log(`teampulse ui → ${server.url}`);
