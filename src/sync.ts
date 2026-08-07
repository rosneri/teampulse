import { type Config, type People, indexPeople, loadConfig } from "./config";
import { markSynced, replaceOpenIssues, saveActivities } from "./db";
import { collectGithub } from "./sources/github";
import { collectLinear, collectOpenIssues } from "./sources/linear";
import { collectSlack } from "./sources/slack";
import type { Activity, Source } from "./types";

type Collector = (configuration: Config, people: People, since: Date) => Promise<Activity[]>;

const COLLECTORS: Record<Source, Collector> = {
  github: (configuration, people, since) => collectGithub(configuration, people, since),
  linear: (_configuration, people, since) => collectLinear(people, since),
  slack: (configuration, people, since) => collectSlack(configuration, people, since),
};

export const SOURCES = Object.keys(COLLECTORS) as Source[];

export function isSource(value: unknown): value is Source {
  return typeof value === "string" && (SOURCES as string[]).includes(value);
}

export type SyncResult = {
  /** A source name, or "linear-open-issues" for the snapshot pass. */
  label: string;
  collected: number;
  saved: number;
  /** Null on success. A failed source reports here instead of throwing. */
  error: string | null;
};

export async function sync(since: Date, only?: Source[]): Promise<SyncResult[]> {
  const configuration = await loadConfig();
  const people = indexPeople(configuration);
  const sources = only?.length ? only : SOURCES;
  const results: SyncResult[] = [];

  for (const source of sources) {
    try {
      const rows = await COLLECTORS[source](configuration, people, since);
      const saved = await saveActivities(rows);
      await markSynced(source);
      results.push({ label: source, collected: rows.length, saved, error: null });
    } catch (cause) {
      // One dead token should not cost you the other two sources.
      results.push({
        label: source,
        collected: 0,
        saved: 0,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  if (sources.includes("linear")) {
    try {
      const open = await collectOpenIssues(people);
      await replaceOpenIssues(open);
      results.push({
        label: "linear-open-issues",
        collected: open.length,
        saved: open.length,
        error: null,
      });
    } catch (cause) {
      results.push({
        label: "linear-open-issues",
        collected: 0,
        saved: 0,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return results;
}
