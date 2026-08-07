import { type Config, type People, indexPeople, loadConfig } from "./config";
import { markSynced, replaceAiUsage, replaceOpenIssues, saveActivities } from "./db";
import { collectAiUsage } from "./sources/anthropic";
import { collectCalendar } from "./sources/calendar";
import { collectGithub } from "./sources/github";
import { collectLinear, collectOpenIssues } from "./sources/linear";
import { collectNotion } from "./sources/notion";
import { collectSlack } from "./sources/slack";
import { collectVercel } from "./sources/vercel";
import type { Activity, Source } from "./types";

type Collector = (configuration: Config, people: People, since: Date) => Promise<Activity[]>;

const COLLECTORS: Record<Source, Collector> = {
  github: (configuration, people, since) => collectGithub(configuration, people, since),
  linear: (_configuration, people, since) => collectLinear(people, since),
  slack: (configuration, people, since) => collectSlack(configuration, people, since),
  notion: (_configuration, people, since) => collectNotion(people, since),
  calendar: (_configuration, people, since) => collectCalendar(people, since),
  vercel: (_configuration, people, since) => collectVercel(people, since),
};

/**
 * What each source needs before it is worth calling. A source whose credential is
 * missing is not a failure — it was never set up, and reporting it as an error
 * teaches the reader to ignore the error line. It is skipped, and says why.
 *
 * Returns the missing thing, or null when the source is ready to run.
 */
const READINESS: Record<Source, (people: People) => string | null> = {
  // The only source with no credential of its own: it borrows an authenticated `gh`.
  github: () => null,
  linear: () => (process.env.LINEAR_API_KEY ? null : "LINEAR_API_KEY not set"),
  slack: () => (process.env.SLACK_USER_TOKEN ? null : "SLACK_USER_TOKEN not set"),
  notion: () => (process.env.NOTION_API_KEY ? null : "NOTION_API_KEY not set"),
  calendar: (people) => {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return "GOOGLE_SERVICE_ACCOUNT_JSON not set";
    // A key with nobody to impersonate reads no calendars at all.
    return people.all.some((person) => person.email)
      ? null
      : "no person in people.yaml has an email";
  },
  vercel: () => (process.env.VERCEL_TOKEN ? null : "VERCEL_TOKEN not set"),
};

export const SOURCES = Object.keys(COLLECTORS) as Source[];

export function isSource(value: unknown): value is Source {
  return typeof value === "string" && (SOURCES as string[]).includes(value);
}

export type SyncResult = {
  /** A source name, or the label of a pass that writes somewhere other than `activity`. */
  label: string;
  collected: number;
  saved: number;
  /** Null on success. A failed source reports here instead of throwing. */
  error: string | null;
  /**
   * Set when the source was never called because it is not configured. Distinct
   * from `error` on purpose: nothing is broken, there is just nothing to ask.
   */
  skipped: string | null;
};

/** Runs one pass and turns a failure into a reported result rather than a thrown one. */
async function attempt(
  label: string,
  run: () => Promise<{ collected: number; saved: number }>,
): Promise<SyncResult> {
  try {
    const { collected, saved } = await run();
    return { label, collected, saved, error: null, skipped: null };
  } catch (cause) {
    // One dead token should not cost you every other source.
    return {
      label,
      collected: 0,
      saved: 0,
      error: cause instanceof Error ? cause.message : String(cause),
      skipped: null,
    };
  }
}

const skip = (label: string, reason: string): SyncResult => ({
  label,
  collected: 0,
  saved: 0,
  error: null,
  skipped: reason,
});

export async function sync(since: Date, only?: Source[]): Promise<SyncResult[]> {
  const configuration = await loadConfig();
  const people = indexPeople(configuration);
  const sources = only?.length ? only : SOURCES;
  const results: SyncResult[] = [];

  for (const source of sources) {
    const missing = READINESS[source](people);
    if (missing) {
      results.push(skip(source, missing));
      continue;
    }

    results.push(
      await attempt(source, async () => {
        const rows = await COLLECTORS[source](configuration, people, since);
        const saved = await saveActivities(rows);
        await markSynced(source);
        return { collected: rows.length, saved };
      }),
    );
  }

  if (sources.includes("linear")) {
    results.push(
      await attempt("linear-open-issues", async () => {
        const open = await collectOpenIssues(people);
        await replaceOpenIssues(open);
        return { collected: open.length, saved: open.length };
      }),
    );
  }

  // Claude Code usage is daily, not an event stream, so it is its own pass into
  // its own table rather than a Source. It is not narrowed by `only`, which names
  // activity sources.
  results.push(
    process.env.ANTHROPIC_ADMIN_KEY
      ? await attempt("anthropic-usage", async () => {
      const usage = await collectAiUsage(people, since);
      const saved = await replaceAiUsage(usage);
      await markSynced("anthropic");
      return { collected: usage.length, saved };
    })
      : skip("anthropic-usage", "ANTHROPIC_ADMIN_KEY not set"),
  );

  return results;
}
