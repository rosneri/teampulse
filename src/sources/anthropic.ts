import type { People } from "../config";

/**
 * Claude Code usage, from the Anthropic Admin API's analytics report.
 *
 * Deliberately *not* an Activity. The report buckets by calendar day and carries
 * no time of day, so writing it into `activity` would put a full day's tokens at
 * midnight and quietly corrupt both the work-hours heat map and the day-shape
 * chart. It gets its own table, the way `open_issue` does, and the dashboard
 * reads it as a daily total — which is the honest granularity.
 *
 * Attribution is by work email: the report names a `user_actor` by address, and
 * people.yaml already maps that address to a canonical id. Rows for an
 * `api_actor` (a shared key rather than a person) are counted as skipped rather
 * than credited to anybody.
 */

const API = "https://api.anthropic.com/v1/organizations/usage_report/claude_code";
const ANTHROPIC_VERSION = "2023-06-01";

export type AiUsageRow = {
  personId: string;
  /** Calendar day, "2026-08-06". */
  day: string;
  model: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costAmount: number;
  currency: string;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  pullRequests: number;
  toolsAccepted: number;
  toolsRejected: number;
};

type Report = {
  data: {
    actor: { type: string; email_address?: string; api_key_name?: string };
    date: string;
    core_metrics?: {
      num_sessions?: number;
      commits_by_claude_code?: number;
      pull_requests_by_claude_code?: number;
      lines_of_code?: { added?: number; removed?: number };
    };
    model_breakdown?: {
      model: string;
      estimated_cost?: { amount?: number; currency?: string };
      tokens?: { input?: number; output?: number; cache_read?: number; cache_creation?: number };
    }[];
    tool_actions?: Record<string, { accepted?: number; rejected?: number }>;
  }[];
  has_more: boolean;
  next_page: string | null;
};

async function report(day: string, page?: string): Promise<Report> {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) throw new Error("ANTHROPIC_ADMIN_KEY not set — needs an admin key, not a normal API key");

  const url = new URL(API);
  url.searchParams.set("starting_at", day);
  url.searchParams.set("limit", "1000");
  if (page) url.searchParams.set("page", page);

  const response = await fetch(url, {
    headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
  });
  const json = (await response.json()) as any;
  if (!response.ok) {
    throw new Error(`anthropic usage report: ${json?.error?.message ?? response.statusText}`);
  }
  return json as Report;
}

/** Every calendar day from `since` through today, inclusive — the report takes one day per call. */
function daysSince(since: Date): string[] {
  const days: string[] = [];
  const day = 86_400_000;
  const first = Date.parse(`${since.toISOString().slice(0, 10)}T00:00:00Z`);
  const last = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  for (let time = first; time <= last; time += day) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

export async function collectAiUsage(people: People, since: Date): Promise<AiUsageRow[]> {
  const out: AiUsageRow[] = [];
  // Kept by address, not just counted: the fix is to paste these into people.yaml,
  // and a bare number leaves the reader guessing which colleague is missing.
  const unattributed = new Set<string>();
  let apiKeyActors = 0;

  for (const day of daysSince(since)) {
    let page: string | undefined;
    do {
      const body = await report(day, page);

      for (const record of body.data ?? []) {
        const email = record.actor?.email_address?.toLowerCase();
        const personId = email && people.byEmail.get(email);
        if (!personId) {
          if (email) unattributed.add(email);
          else apiKeyActors++;
          continue;
        }

        const core = record.core_metrics ?? {};
        const tools = Object.values(record.tool_actions ?? {});
        const accepted = tools.reduce((sum, action) => sum + (action.accepted ?? 0), 0);
        const rejected = tools.reduce((sum, action) => sum + (action.rejected ?? 0), 0);

        // The report gives one row per actor per day with a per-model breakdown;
        // this table keys on the model, so the day's own counts (sessions,
        // commits, tool actions) are attached to the first model only. Splitting
        // them evenly would invent numbers the API never reported.
        (record.model_breakdown ?? []).forEach((breakdown, index) => {
          const tokens = breakdown.tokens ?? {};
          out.push({
            personId,
            day: record.date.slice(0, 10),
            model: breakdown.model,
            sessions: index === 0 ? (core.num_sessions ?? 0) : 0,
            inputTokens: tokens.input ?? 0,
            outputTokens: tokens.output ?? 0,
            cacheReadTokens: tokens.cache_read ?? 0,
            cacheCreationTokens: tokens.cache_creation ?? 0,
            costAmount: breakdown.estimated_cost?.amount ?? 0,
            currency: breakdown.estimated_cost?.currency ?? "USD",
            linesAdded: index === 0 ? (core.lines_of_code?.added ?? 0) : 0,
            linesRemoved: index === 0 ? (core.lines_of_code?.removed ?? 0) : 0,
            commits: index === 0 ? (core.commits_by_claude_code ?? 0) : 0,
            pullRequests: index === 0 ? (core.pull_requests_by_claude_code ?? 0) : 0,
            toolsAccepted: index === 0 ? accepted : 0,
            toolsRejected: index === 0 ? rejected : 0,
          });
        });
      }

      page = body.has_more ? (body.next_page ?? undefined) : undefined;
    } while (page);
  }

  if (unattributed.size) {
    console.warn(
      `  anthropic: no person in people.yaml has these addresses — ` +
        `add them as \`email:\` to credit their usage: ${[...unattributed].sort().join(", ")}`,
    );
  }
  if (apiKeyActors) {
    console.warn(
      `  anthropic: ${apiKeyActors} rows came from a shared API key rather than a person — not credited`,
    );
  }

  return out;
}
