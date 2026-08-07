import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { indexPeople, loadConfig, parseSince } from "./config";
import { prisma } from "./db";
import {
  activityFeed, bugRatio, dailyCounts, hourlyCounts, intakeMix, personStats,
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
