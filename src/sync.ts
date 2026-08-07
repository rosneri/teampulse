import { indexPeople, loadConfig, type Config, type People } from "./config";
import { markSynced, replaceOpenIssues, saveActivities } from "./db";
import { collectGithub } from "./sources/github";
import { collectLinear, collectOpenIssues } from "./sources/linear";
import { collectSlack } from "./sources/slack";
import type { Activity, Source } from "./types";

type Collector = (cfg: Config, people: People, since: Date) => Promise<Activity[]>;

const COLLECTORS: Record<Source, Collector> = {
  github: (cfg, people, since) => collectGithub(cfg, people, since),
  linear: (_cfg, people, since) => collectLinear(people, since),
  slack: (cfg, people, since) => collectSlack(cfg, people, since),
};

export async function sync(since: Date, only?: Source[]) {
  const cfg = await loadConfig();
  const people = indexPeople(cfg);
  const sources = (only?.length ? only : (Object.keys(COLLECTORS) as Source[]));

  for (const source of sources) {
    try {
      const rows = await COLLECTORS[source](cfg, people, since);
      const saved = await saveActivities(rows);
      await markSynced(source);
      console.log(`${source}: ${rows.length} events, ${saved} new`);
    } catch (err) {
      // One dead token should not cost you the other two sources.
      console.error(`${source}: FAILED — ${(err as Error).message}`);
    }
  }

  if (sources.includes("linear")) {
    try {
      const open = await collectOpenIssues(people);
      await replaceOpenIssues(open);
      console.log(`linear: ${open.length} open assignments snapshotted`);
    } catch (err) {
      console.error(`linear open issues: FAILED — ${(err as Error).message}`);
    }
  }
}
