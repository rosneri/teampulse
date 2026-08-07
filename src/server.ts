import { indexPeople, loadConfig, parseSince } from "./config";
import { judge, storedJudgments } from "./judgment";
import {
  DEFAULT_BREAK_MINUTES, activityFeed, aiUsage, bugRatio, coverage, dailyCounts,
  daySessions, dayMarks, hourlyCounts, intakeMix, lastSyncs, personStats,
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
 * `?repo=` narrows the GitHub side to one repository. Absent or empty means all
 * of them — which default a reader opens on is a browser preference now, so the
 * server holds no opinion about it.
 */
function repositoryOf(url: string): string | undefined {
  return new URL(url).searchParams.get("repo") || undefined;
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
    // Constructing it is the check: an unknown zone throws a RangeError here
    // rather than a hundred lines later inside Postgres.
    const format = new Intl.DateTimeFormat("en", { timeZone: parameter });
    return format.resolvedOptions().timeZone ? parameter : null;
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

      const [
        stats, waits, days, hours, sessions, marks, team, ship, intake, bugs,
        stale, repos, sourceCoverage, syncs, ai, judgments,
      ] = await Promise.all([
        personStats(since, repository), reviewWaits(since, repository),
        dailyCounts(since, repository), hourlyCounts(since, timezone, repository),
        daySessions(since, timezone, repository), dayMarks(since, timezone, repository),
        teamStats(since, repository),
        shippedMix(since, repository), intakeMix(since, repository),
        bugRatio(since, repository), staleIssues(), repositories(since),
        coverage(since), lastSyncs(), aiUsage(since),
        // Read only: judgments are produced by POST /api/judge, never by loading a page.
        storedJudgments(),
      ]);

      return Response.json({
        since: since.toISOString(),
        timezone,
        repository: repository ?? null,
        repositories: repos,
        people: configuration.people.map((person) => ({
          id: person.id,
          name: person.name,
          workWeek: person.workWeek,
          // Which sources this person *could* appear in. A handle nobody filled
          // in is the difference between "quiet" and "not being looked at".
          handles: {
            github: person.githubLogins.length > 0,
            linear: Boolean(person.linear),
            slack: Boolean(person.slack),
            notion: Boolean(person.notion),
            calendar: Boolean(person.email),
            vercel: Boolean(person.vercel || person.email),
            // Claude Code is attributed by work email. Without one the report can
            // never name this person, however much they use it.
            anthropic: Boolean(person.email),
          },
        })),
        breakMinutes: DEFAULT_BREAK_MINUTES,
        team, stats, waits, days, hours, sessions, marks, ship, intake, bugs, stale,
        // Claude Code has its own table, so `coverage` — which reads `activity` —
        // is blind to it. Days used is the same question that table asks of every
        // other source: did we hear anything at all.
        coverage: [
          ...sourceCoverage,
          ...ai.map((row) => ({
            person_id: row.person_id,
            source: "anthropic",
            events: row.days_used,
            last_seen: null,
          })),
        ],
        syncs, ai, judgments,
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
          if (result.skipped) console.log(`${result.label}: skipped — ${result.skipped}`);
          else if (result.error) console.log(`${result.label}: FAILED — ${result.error}`);
          else console.log(`${result.label}: ${result.collected} events, ${result.saved} new`);
        }
        return Response.json({ results });
      },
    },

    /**
     * The judgment layer, run on demand for the current window. Like `/api/sync`
     * this holds the request open and changes state — it appends to `ai_output`,
     * never to `activity` — and it costs money per call, so nothing triggers it
     * but a person asking.
     */
    "/api/judge": {
      POST: async (req) => {
        const since = windowOf(req.url);
        if (!since) return bad("bad ?since — use 30d, 12w, 6m or a date");

        const judgments = await judge({
          personIds: configuration.people.map((person) => person.id),
          since,
          repository: repositoryOf(req.url),
        });
        return Response.json({ since: since.toISOString(), judgments });
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
