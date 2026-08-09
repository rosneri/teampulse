import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { indexPeople, loadConfig, parseSince } from "./config";
import { prisma } from "./db";
import { focusBriefs } from "./focus";
import { storedJudgments } from "./judgment";
import {
  DEFAULT_BREAK_MINUTES, activityFeed, aiUsage, assignments, bugRatio, coverage, dailyCounts,
  daySessions, dayMarks, hourlyCounts, intakeMix, lastSyncs, personStats,
  repositories, reviewWaits, shippedMix, staleIssues, teamStats,
} from "./metrics";

/**
 * Read-only MCP surface over the same functions the web UI reads. Every number
 * a model sees here comes from the SQL in metrics.ts, so the model and the
 * dashboard can never disagree — and nothing here can write to `activity`.
 *
 * Deliberately no sync tool: the web UI is the controller, and pulling from
 * GitHub, Linear and Slack is a person's decision, not a model's.
 *
 * The transport owns stdout, so nothing in this file may print to it.
 */

const configuration = await loadConfig();
const people = indexPeople(configuration);

const server = new McpServer({ name: "teampulse", version: "1.0.0" });

const SINCE_DESCRIPTION =
  'Start of the window: "30d", "12w", "6m", or an ISO date like "2026-01-01". Defaults to 30d.';

const REPOSITORY_DESCRIPTION =
  'Narrow the GitHub side to one repository, "owner/name". Linear issues and Slack messages ' +
  "belong to no repository, so they are counted under every one rather than dropped. " +
  "Omit for the unscoped view.";

const windowInput = {
  since: z.string().default("30d").describe(SINCE_DESCRIPTION),
  repository: z.string().optional().describe(REPOSITORY_DESCRIPTION),
};

function asJson(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

/** Every metric tool has the same shape: one scope in, one JSON result out. */
function registerWindowedTool(
  name: string,
  description: string,
  read: (since: Date, repository?: string) => Promise<unknown>,
) {
  server.registerTool(
    name,
    { description, inputSchema: windowInput, annotations: { readOnlyHint: true } },
    async ({ since, repository }) => asJson(await read(parseSince(since), repository)),
  );
}

server.registerTool(
  "people",
  {
    description:
      "The roster from people.yaml: canonical id, name, work week, and the source handles each id maps to. person_id in every other tool is one of these ids.",
    annotations: { readOnlyHint: true },
  },
  async () => asJson(configuration.people),
);

registerWindowedTool(
  "team_stats",
  "Team totals for the window: people active, PRs opened and merged, reviews given, issues created and completed, messages, and the median hours from a PR opening to its first review.",
  teamStats,
);

registerWindowedTool(
  "person_stats",
  "Per-person counts for the window: PRs opened and merged, reviews given, issues created and completed, messages, directives received, and distinct active days.",
  personStats,
);

registerWindowedTool(
  "review_waits",
  "Per-person median hours from opening a PR to its first review, credited to the PR's author — how long they wait to get unblocked — plus how many of their PRs were never reviewed.",
  reviewWaits,
);

registerWindowedTool(
  "shipped_mix",
  "Merged PRs in the window grouped by kind of work. Anything the deterministic classifier could not place stays in the 'unclassified' bucket rather than being folded into another one.",
  shippedMix,
);

registerWindowedTool(
  "intake_mix",
  "Linear issues created in the window grouped by kind of work. Counted over a different event type from shipped_mix on purpose, so a PR and the issue it closes are never both counted as one delivery.",
  intakeMix,
);

registerWindowedTool(
  "bug_ratio",
  "Bugs reported against what shipped: bugs per merged PR, and the share of merged PRs that were fixes rather than new work.",
  bugRatio,
);

registerWindowedTool(
  "daily_counts",
  "One row per person per day with their event count — the raw material for an activity strip.",
  dailyCounts,
);

server.registerTool(
  "hourly_counts",
  {
    description:
      "One row per person per weekday per hour of the day with their event count — when in the day " +
      "somebody works, rather than how much. Weekday 0 is Sunday; which of those days are a weekend " +
      "is per person, from the people tool.",
    inputSchema: {
      ...windowInput,
      timezone: z
        .string()
        .default("UTC")
        .describe('IANA zone the hours are read in, e.g. "Asia/Jerusalem". Hours are stored in UTC.'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ since, repository, timezone }) =>
    asJson(await hourlyCounts(parseSince(since), timezone, repository)),
);

server.registerTool(
  "day_sessions",
  {
    description:
      "Each person's day split into working blocks: when a block started, when it ended, and how many " +
      "events fell inside it. Minutes are counted from local midnight. A block is only the visible edge " +
      "of the work — events are instants, so quiet focus time reads the same as a break.",
    inputSchema: {
      ...windowInput,
      timezone: z
        .string()
        .default("UTC")
        .describe('IANA zone the hours are read in, e.g. "Asia/Jerusalem". Hours are stored in UTC.'),
      break_minutes: z
        .number()
        .int()
        .min(1)
        .default(DEFAULT_BREAK_MINUTES)
        .describe("A silence at least this long starts a new block."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ since, repository, timezone, break_minutes }) =>
    asJson(await daySessions(parseSince(since), timezone, repository, break_minutes)),
);

server.registerTool(
  "day_marks",
  {
    description:
      "Every activity as a span in the reader's day: instants start and end on the same minute, and a " +
      "meeting occupies its real length. Grouped per minute and event type. This is what the coloured " +
      "day-shape chart is drawn from.",
    inputSchema: { ...windowInput, timezone: z
        .string()
        .default("UTC")
        .describe('IANA zone the hours are read in, e.g. "Asia/Jerusalem". Hours are stored in UTC.'), },
    annotations: { readOnlyHint: true },
  },
  async ({ since, repository, timezone }) =>
    asJson(await dayMarks(parseSince(since), timezone, repository)),
);

server.registerTool(
  "coverage",
  {
    description:
      "How many events each source produced per person in the window, plus when each source last ran. " +
      "Use it before trusting a low number anywhere else: a configured source reporting zero is either a " +
      "quiet week or a blind spot, and every other tool here reports them identically.",
    inputSchema: { since: z.string().default("30d").describe(SINCE_DESCRIPTION) },
    annotations: { readOnlyHint: true },
  },
  async ({ since }) =>
    asJson({ coverage: await coverage(parseSince(since)), last_syncs: await lastSyncs() }),
);

server.registerTool(
  "ai_usage",
  {
    description:
      "Claude Code usage per person: sessions, tokens, estimated cost in minor units, lines written, and " +
      "accepted versus rejected edits. Reported by whole calendar day, so it carries no time of day — " +
      "never mix it into an hour-of-day answer. Only actors on API billing appear at all.",
    inputSchema: { since: z.string().default("30d").describe(SINCE_DESCRIPTION) },
    annotations: { readOnlyHint: true },
  },
  async ({ since }) => asJson(await aiUsage(parseSince(since))),
);

server.registerTool(
  "stale_issues",
  {
    description:
      "Open Linear assignments nobody has touched recently, oldest first. Reads the open_issue snapshot, which the last Linear sync replaced wholesale.",
    inputSchema: {
      days: z.number().int().min(1).default(14).describe("Untouched for at least this many days."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ days }) => asJson(await staleIssues(days)),
);

server.registerTool(
  "activity",
  {
    description:
      "Raw activity events, newest first. Every source collapses into this one shape, so a GitHub merge, a Linear issue and a Slack message all read the same way.",
    inputSchema: {
      ...windowInput,
      person_id: z
        .string()
        .optional()
        .describe("Canonical id from the people tool. Omit for the whole team."),
      limit: z.number().int().min(1).max(500).default(40).describe("Most recent N events."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ since, repository, person_id, limit }) => {
    if (person_id !== undefined && !people.byId.has(person_id)) {
      throw new Error(
        `unknown person_id "${person_id}" — call the people tool for the valid ids`,
      );
    }
    return asJson(
      await activityFeed({ personId: person_id, since: parseSince(since), limit, repository }),
    );
  },
);

server.registerTool(
  "judgments",
  {
    description:
      "The AI layer's stored opinions — the newest of each kind per person, from ai_output. This is " +
      "the one tool here whose answers are not facts: a 'summary' is a model's reading of somebody's " +
      "window, a 'work_type' proposal is a guess at what unclassified merged PRs and created " +
      "issues were, and a 'focus' reading is an opinion on how somebody's window lines up with the " +
      "priorities daily_focus lists — an opinion about two lists, never a grade of the person. " +
      "A 'daily_message' is the draft of the update a manager posts to their team, written from " +
      "every brief at once: it is the one row here about the team rather than a person, so its " +
      "person_id is null, and it is a draft nobody has sent. " +
      "Proposals are never written back to activity, so shipped_mix and intake_mix keep " +
      "reporting those items as unclassified — do not add these to a count or reconcile them against " +
      "one. Each row carries the window it judged, which may be narrower or older than the one you " +
      "are asking about, and the run that produced it. Nothing here can be produced by a model: only " +
      "a person, through the dashboard, can spend a judgment call.",
    annotations: { readOnlyHint: true },
  },
  async () => asJson(await storedJudgments()),
);

server.registerTool(
  "assignments",
  {
    description:
      "Every open Linear assignment per person, most important first: priority, state, the project " +
      "and initiative it rolls up to, and how many days since anything touched it. Priority is " +
      "Linear's own scale and is not an ordering — 0 means 'no priority', 1 is urgent through 4 " +
      "low — so the rows arrive sorted and the numbers should not be re-sorted on. Reads the " +
      "open_issue snapshot, which is only as fresh as the last Linear sync.",
    inputSchema: {
      person_id: z
        .string()
        .optional()
        .describe("Canonical id from the people tool. Omit for the whole team."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ person_id }) => {
    if (person_id !== undefined && !people.byId.has(person_id)) {
      throw new Error(`unknown person_id "${person_id}" — call the people tool for the valid ids`);
    }
    return asJson(await assignments(person_id));
  },
);

server.registerTool(
  "daily_focus",
  {
    description:
      "The focus brief per person: what their manager stated they should be on, what Linear has " +
      "them assigned to, and every event they produced in the window — the three lists a reader " +
      "needs side by side to ask whether somebody is on the right thing. " +
      "The stated focus is neither measured nor inferred: it is text a manager typed, it is null " +
      "for anybody nobody has stated one for, and it outranks the tracker when the two disagree. " +
      "Events are instants, so silence against a priority means the work left no trace, never " +
      "that it did not happen — do not read effort, hours or diligence out of this. " +
      "This tool reports the lists; it does not judge how they line up. That reading costs money " +
      "and only a person can spend it, from the dashboard — read it back with the judgments tool.",
    inputSchema: {
      ...windowInput,
      since: z.string().default("1d").describe(SINCE_DESCRIPTION),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ since, repository }) =>
    asJson(
      await focusBriefs({
        people: configuration.people,
        since: parseSince(since),
        repository,
      }),
    ),
);

registerWindowedTool(
  "repositories",
  "Every repository present in the window with its event count, busiest first — the valid values for the repository argument on the other tools.",
  (since) => repositories(since),
);

try {
  await server.connect(new StdioServerTransport());
} catch (cause) {
  await prisma.$disconnect();
  throw cause;
}
