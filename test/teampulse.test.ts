import { afterAll, beforeEach, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexPeople, loadConfig, parseSince } from "../src/config";
import {
  clearPersonFocus, findAiOutput, markSynced, personFocus, prisma, recentAiOutputs,
  replaceAiUsage, replaceOpenIssues, saveActivities, saveAiOutput, setPersonFocus,
} from "../src/db";
import {
  DEFAULT_BREAK_MINUTES, activityFeed, aiUsage, aiUsageDaily, assignments, bugRatio, dailyCounts, coverage, daySessions, dayMarks, hourlyCounts,
  intakeMix, personStats, repositories, reviewWaits, shippedMix, staleIssues, teamStats,
  lastSyncs, unclassifiedWork,
} from "../src/metrics";
import { focusBriefs } from "../src/focus";
import { priorityLabel } from "../src/priority";
import { arrivedViaPullRequest } from "../src/commitmessage";
import {
  BUILT_IN_VIEW, clearSavedView, readSavedView, sameView, writeSavedView,
} from "../src/ui/preferences";
import { isWeekend } from "../src/workweek";
import { classify } from "../src/worktype";
import { collectVercel, scopeOf } from "../src/sources/vercel";
import { KIND_OF, kindOf } from "../src/activitykind";
import type { ActivityType } from "../src/types";

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const SINCE = new Date(Date.now() - 30 * 86_400_000);

beforeEach(async () => {
  await prisma.activity.deleteMany({});
  await prisma.aiUsage.deleteMany({});
  await prisma.aiOutput.deleteMany({});
});

afterAll(async () => {
  await prisma.activity.deleteMany({});
  await prisma.aiUsage.deleteMany({});
  await prisma.aiOutput.deleteMany({});
  await prisma.$disconnect();
});

test("classify: labels beat title, word boundaries respected", () => {
  expect(classify("fix: null deref")).toBe("bug");
  expect(classify("feat(api): add webhooks")).toBe("feature");
  expect(classify("perf: cache the thing")).toBe("improvement");
  expect(classify("chore(deps): bump")).toBe("chore");
  expect(classify("add webhooks")).toBeNull();

  // An explicit label overrides whatever the title prefix says.
  expect(classify("feat: add retry", ["Bug"])).toBe("bug");
  // "debug" must not read as "bug".
  expect(classify("add logging", ["debug-tooling"])).toBeNull();
});

test("parseSince accepts relative and absolute", () => {
  const d = parseSince("7d");
  expect(Math.round((Date.now() - d.getTime()) / 86_400_000)).toBe(7);
  expect(parseSince("2w").getTime()).toBeLessThan(parseSince("7d").getTime());
  expect(parseSince("2026-01-01").getFullYear()).toBe(2026);
  expect(() => parseSince("nonsense")).toThrow();
});

test("review wait is measured to the first review, not the last", async () => {
  const pr = { repo: "acme/web", number: 1 };
  await saveActivities([
    { id: "a1", source: "github", type: "pr_opened", personId: "maya", ts: ago(10), meta: pr },
    { id: "a2", source: "github", type: "pr_reviewed", personId: "dan", ts: ago(9), meta: pr },
    { id: "a3", source: "github", type: "pr_reviewed", personId: "leo", ts: ago(2), meta: pr },
    // A second PR that nobody ever reviewed.
    { id: "a4", source: "github", type: "pr_opened", personId: "maya", ts: ago(5), meta: { repo: "acme/web", number: 2 } },
  ]);

  const [maya] = await reviewWaits(SINCE);
  expect(maya!.person_id).toBe("maya");
  expect(maya!.median_hours).toBeCloseTo(24, 0); // first review, 1 day — not 8 days
  expect(maya!.reviewed).toBe(1);
  expect(maya!.unreviewed).toBe(1);
});

test("bug ratio separates what was reported from what shipped", async () => {
  await saveActivities([
    { id: "b1", source: "linear", type: "issue_created", personId: "maya", workType: "bug", ts: ago(3) },
    { id: "b2", source: "linear", type: "issue_created", personId: "maya", workType: "bug", ts: ago(2) },
    { id: "b3", source: "linear", type: "issue_created", personId: "dan", workType: "feature", ts: ago(2) },
    { id: "b4", source: "github", type: "pr_merged", personId: "dan", workType: "bug", ts: ago(1) },
    { id: "b5", source: "github", type: "pr_merged", personId: "dan", workType: "feature", ts: ago(1) },
    { id: "b6", source: "github", type: "pr_merged", personId: "leo", workType: null, ts: ago(1) },
  ]);

  const r = await bugRatio(SINCE);
  expect(r.bugs_reported).toBe(2);
  expect(r.shipped).toBe(3);
  expect(r.bug_fixes_shipped).toBe(1);
  expect(r.bugs_per_delivery).toBeCloseTo(2 / 3, 5);
  expect(r.fix_share).toBeCloseTo(1 / 3, 5);

  // Unclassified stays visible instead of being folded into a bucket.
  const mix = await shippedMix(SINCE);
  expect(mix.find((m) => m.bucket === "unclassified")?.n).toBe(1);
  expect(mix.reduce((a, m) => a + m.n, 0)).toBe(3);
});

test("events outside the window are excluded", async () => {
  await saveActivities([
    { id: "c1", source: "github", type: "pr_merged", personId: "dan", ts: ago(5) },
    { id: "c2", source: "github", type: "pr_merged", personId: "dan", ts: ago(90) },
  ]);
  const [dan] = await personStats(SINCE);
  expect(dan!.prs_merged).toBe(1);
});

test("isWeekend: the calendar follows the person, not the date", () => {
  // 2026-08-07 is a Friday, 2026-08-08 a Saturday, 2026-08-09 a Sunday.
  expect(isWeekend("2026-08-07", "sunday-thursday")).toBe(true);
  expect(isWeekend("2026-08-08", "sunday-thursday")).toBe(true);
  expect(isWeekend("2026-08-09", "sunday-thursday")).toBe(false);

  expect(isWeekend("2026-08-07", "monday-friday")).toBe(false);
  expect(isWeekend("2026-08-08", "monday-friday")).toBe(true);
  expect(isWeekend("2026-08-09", "monday-friday")).toBe(true);
});

test("loadConfig: workWeek defaults, and an unknown one is rejected", async () => {
  const path = join(tmpdir(), `teampulse-people-${process.pid}.yaml`);

  await Bun.write(
    path,
    "people:\n  - id: maya\n    name: Maya\n  - id: sam\n    name: Sam\n    workWeek: monday-friday\n",
  );
  const configuration = await loadConfig(path);
  expect(configuration.people[0]!.workWeek).toBe("sunday-thursday");
  expect(configuration.people[1]!.workWeek).toBe("monday-friday");

  await Bun.write(path, "people:\n  - id: maya\n    name: Maya\n    workWeek: friday-only\n");
  expect(loadConfig(path)).rejects.toThrow(/friday-only/);

  await unlink(path);
});

test("loadConfig: a missing file and a nameless person both fail loudly", async () => {
  expect(loadConfig(join(tmpdir(), "teampulse-does-not-exist.yaml"))).rejects.toThrow(/not found/);

  const path = join(tmpdir(), `teampulse-invalid-${process.pid}.yaml`);
  await Bun.write(path, "people:\n  - id: maya\n");
  expect(loadConfig(path)).rejects.toThrow(/missing id or name/);

  await Bun.write(path, "people: []\n");
  expect(loadConfig(path)).rejects.toThrow(/no people/);

  await unlink(path);
});

test("arrivedViaPullRequest: only work that reached the branch on its own is counted", () => {
  // Skipped — a `pr_merged` row already covers these.
  expect(arrivedViaPullRequest("Merge pull request #12 from acme/fix-login", 2)).toBe(true);
  expect(arrivedViaPullRequest("Fix the login redirect (#12)", 1)).toBe(true);
  expect(arrivedViaPullRequest("Anything at all", 2)).toBe(true);

  // Kept — pushed straight to the default branch.
  expect(arrivedViaPullRequest("fix: login redirect", 1)).toBe(false);
  expect(arrivedViaPullRequest("", 1)).toBe(false);
  // A number mid-subject is an issue reference, not a merge marker.
  expect(arrivedViaPullRequest("Revert (#12) and try again", 1)).toBe(false);
});

test("indexPeople: every handle resolves to the canonical id", () => {
  const people = indexPeople({
    people: [
      {
        id: "maya",
        name: "Maya",
        githubLogins: ["MayaGH", "maya-personal"],
        linear: "6b1f",
        // Two Slack accounts, the way two GitHub logins work above.
        slack: ["U01", "U07"],
        workWeek: "sunday-thursday",
      },
      { id: "sam", name: "Sam", githubLogins: [], workWeek: "monday-friday" },
    ],
  });

  expect(people.all).toHaveLength(2);
  expect(people.byId.get("maya")?.name).toBe("Maya");
  // GitHub logins are case-insensitive, so the index lowercases them.
  expect(people.byGithub.get("mayagh")).toBe("maya");
  // A second account resolves to the same canonical id as the first.
  expect(people.byGithub.get("maya-personal")).toBe("maya");
  expect(people.byLinear.get("6b1f")).toBe("maya");
  expect(people.bySlack.get("U01")).toBe("maya");
  expect(people.bySlack.get("U07")).toBe("maya");
  // A person with no handles is still addressable by canonical id.
  expect(people.byId.get("sam")?.workWeek).toBe("monday-friday");
  expect(people.byGithub.size).toBe(2);
});

test("indexPeople: vercel takes one handle or several, alongside the email fallback", () => {
  const people = indexPeople({
    people: [
      { id: "maya", name: "Maya", githubLogins: [], vercel: "Maya-V", workWeek: "sunday-thursday" },
      {
        id: "doron",
        name: "Doron",
        githubLogins: [],
        // Two seats, neither on the work address the calendar uses.
        vercel: ["doron-a", "doron-b"],
        email: "Doron@acme.com",
        workWeek: "sunday-thursday",
      },
    ],
  });

  expect(people.byVercel.get("maya-v")).toBe("maya");
  expect(people.byVercel.get("doron-a")).toBe("doron");
  expect(people.byVercel.get("doron-b")).toBe("doron");
  // The email's local part still resolves, so an unlisted seat is not lost.
  expect(people.byVercel.get("doron")).toBe("doron");
});

test("loadConfig: github accepts one login or several, and rejects junk", async () => {
  const path = join(tmpdir(), `teampulse-github-${process.pid}.yaml`);

  await Bun.write(
    path,
    "people:\n" +
      "  - id: maya\n    name: Maya\n    github: mayagh\n" +
      "  - id: sam\n    name: Sam\n    github: [sam-work, sam-personal]\n" +
      "  - id: lee\n    name: Lee\n",
  );
  const configuration = await loadConfig(path);
  expect(configuration.people[0]!.githubLogins).toEqual(["mayagh"]);
  expect(configuration.people[1]!.githubLogins).toEqual(["sam-work", "sam-personal"]);
  // No GitHub presence at all is a valid state, not a missing field.
  expect(configuration.people[2]!.githubLogins).toEqual([]);

  await Bun.write(path, "people:\n  - id: maya\n    name: Maya\n    github: [maya, 7]\n");
  expect(loadConfig(path)).rejects.toThrow(/use a login/);

  await Bun.write(path, "people:\n  - id: maya\n    name: Maya\n    github: []\n");
  expect(loadConfig(path)).rejects.toThrow(/use a login/);

  await unlink(path);
});

test("teamStats and dailyCounts: totals, and one row per person per day", async () => {
  await saveActivities([
    { id: "t1", source: "github", type: "pr_opened", personId: "maya", ts: ago(6),
      meta: { repo: "acme/web", number: 1 } },
    { id: "t2", source: "github", type: "pr_merged", personId: "maya", ts: ago(4) },
    { id: "t3", source: "github", type: "pr_reviewed", personId: "sam", ts: ago(4),
      meta: { repo: "acme/web", number: 1 } },
    { id: "t4", source: "linear", type: "issue_created", personId: "sam", ts: ago(4) },
    { id: "t5", source: "linear", type: "issue_completed", personId: "sam", ts: ago(3) },
    { id: "t6", source: "slack", type: "message", personId: "maya", ts: ago(3) },
    { id: "t7", source: "slack", type: "thread_reply", personId: "maya", ts: ago(3) },
  ]);

  const team = await teamStats(SINCE);
  expect(team.people_active).toBe(2);
  expect(team.prs_opened).toBe(1);
  expect(team.prs_merged).toBe(1);
  expect(team.reviews).toBe(1);
  expect(team.issues_created).toBe(1);
  expect(team.issues_completed).toBe(1);
  // Replies count as messages alongside top-level messages.
  expect(team.messages).toBe(2);
  // PR opened six days ago, first reviewed four days ago.
  expect(team.median_review_hours).toBeCloseTo(48, 0);

  const days = await dailyCounts(SINCE);
  const mayaOnDayThree = days.find(
    (row) => row.person_id === "maya" && row.day.toISOString().startsWith(ago(3).slice(0, 10)),
  );
  expect(mayaOnDayThree?.n).toBe(2);
  expect(days.reduce((total, row) => total + row.n, 0)).toBe(7);
});

test("unclassifiedWork: the null tail the AI layer is asked about, and nothing else", async () => {
  await saveActivities([
    { id: "u1", source: "github", type: "pr_merged", personId: "maya", ts: ago(2), title: "Rework the exporter" },
    { id: "u2", source: "linear", type: "issue_created", personId: "sam", ts: ago(2), title: "Exports look wrong" },
    // Already classified: the deterministic layer answered, so nobody asks a model.
    { id: "u3", source: "github", type: "pr_merged", personId: "maya", ts: ago(2), workType: "bug" },
    // Unclassified but not a delivery — no mix counts it, so no work type would move a number.
    { id: "u4", source: "slack", type: "message", personId: "maya", ts: ago(2), title: "morning" },
  ]);

  const items = await unclassifiedWork(SINCE);
  expect(items.map((item) => item.id).toSorted()).toEqual(["u1", "u2"]);
  expect(items.find((item) => item.id === "u1")?.title).toBe("Rework the exporter");
});

test("ai_output: judgment is found again by the hash of what it was shown", async () => {
  const window = { windowStart: SINCE, windowEnd: new Date() };
  await saveAiOutput({
    kind: "work_type",
    personId: "maya",
    ...window,
    inputDigest: "digest-one",
    payload: { proposals: [{ activityId: "u1", workType: "improvement" }] },
  });

  const found = await findAiOutput("work_type", "maya", "digest-one");
  expect(found?.payload).toEqual({ proposals: [{ activityId: "u1", workType: "improvement" }] });

  // A different input is a different question: the stored answer must not be reused for it.
  expect(await findAiOutput("work_type", "maya", "digest-two")).toBeNull();
  // Nor may one kind of judgment answer for another.
  expect(await findAiOutput("summary", "maya", "digest-one")).toBeNull();

  // A second run over the same person is a second row: judgment is appended,
  // never updated, so the reading it replaced stays readable.
  await saveAiOutput({
    kind: "work_type",
    personId: "maya",
    ...window,
    inputDigest: "digest-two",
    payload: { proposals: [] },
  });

  const recent = await recentAiOutputs();
  expect(recent).toHaveLength(2);
  expect(recent[0]?.inputDigest).toBe("digest-two");
});

test("teamStats: an empty window reports zeros, not nulls", async () => {
  const team = await teamStats(SINCE);
  expect(team.prs_merged).toBe(0);
  expect(team.median_review_hours).toBeNull();

  // A ratio over nothing is a visible gap rather than a misleading zero.
  const bugs = await bugRatio(SINCE);
  expect(bugs.bugs_per_delivery).toBeNull();
  expect(bugs.fix_share).toBeNull();
});

test("intakeMix: created issues by kind, unclassified kept visible", async () => {
  await saveActivities([
    { id: "i1", source: "linear", type: "issue_created", personId: "maya", ts: ago(2), workType: "bug" },
    { id: "i2", source: "linear", type: "issue_created", personId: "maya", ts: ago(2), workType: "bug" },
    { id: "i3", source: "linear", type: "issue_created", personId: "sam", ts: ago(2) },
    // A merged PR must not leak into intake — the two mixes count different events.
    { id: "i4", source: "github", type: "pr_merged", personId: "sam", ts: ago(2), workType: "feature" },
  ]);

  const mix = await intakeMix(SINCE);
  expect(mix.find((bucket) => bucket.bucket === "bug")?.n).toBe(2);
  expect(mix.find((bucket) => bucket.bucket === "unclassified")?.n).toBe(1);
  expect(mix.find((bucket) => bucket.bucket === "feature")).toBeUndefined();
});

test("activityFeed: newest first, optionally scoped to one person", async () => {
  await saveActivities([
    { id: "f1", source: "github", type: "pr_merged", personId: "maya", ts: ago(9), title: "older" },
    { id: "f2", source: "github", type: "pr_merged", personId: "maya", ts: ago(1), title: "newer" },
    { id: "f3", source: "slack", type: "message", personId: "sam", ts: ago(2), title: "sam speaks" },
  ]);

  const everyone = await activityFeed({ since: SINCE });
  expect(everyone.map((row) => row.id)).toEqual(["f2", "f3", "f1"]);

  const justMaya = await activityFeed({ personId: "maya", since: SINCE });
  expect(justMaya.map((row) => row.id)).toEqual(["f2", "f1"]);

  // The limit is clamped into range rather than trusted.
  expect(await activityFeed({ since: SINCE, limit: 1 })).toHaveLength(1);
  expect(await activityFeed({ since: SINCE, limit: 9_000 })).toHaveLength(3);
});

test("open issues: the snapshot is replaced wholesale, and stale ones surface", async () => {
  const openIssue = (id: string, updatedDaysAgo: number) => ({
    id,
    identifier: `ENG-${id}`,
    title: `issue ${id}`,
    url: `https://linear.app/${id}`,
    personId: "maya",
    state: "In Progress",
    priority: 2,
    updatedAt: ago(updatedDaysAgo),
  });

  expect(await replaceOpenIssues([openIssue("1", 30), openIssue("2", 1)])).toBe(2);
  let stale = await staleIssues(14);
  expect(stale.map((row) => row.identifier)).toEqual(["ENG-1"]);
  expect(stale[0]!.age_days).toBeGreaterThanOrEqual(29);

  // Replacing the snapshot drops whatever the previous sync wrote.
  expect(await replaceOpenIssues([openIssue("3", 20)])).toBe(1);
  stale = await staleIssues(14);
  expect(stale.map((row) => row.identifier)).toEqual(["ENG-3"]);

  // A shorter horizon widens the net.
  expect(await staleIssues(1)).toHaveLength(1);
  await prisma.openIssue.deleteMany({});
});

test("assignments: Linear's 0 means no priority, so it sorts last and not first", async () => {
  const assigned = (id: string, priority: number, extra: Record<string, unknown> = {}) => ({
    id,
    identifier: `ENG-${id}`,
    title: `issue ${id}`,
    url: `https://linear.app/${id}`,
    personId: "maya",
    state: "In Progress",
    priority,
    updatedAt: ago(1),
    ...extra,
  });

  await replaceOpenIssues([
    assigned("none", 0),
    assigned("low", 4),
    assigned("urgent", 1, { projectName: "Billing", initiativeName: "Revenue" }),
    { ...assigned("other", 1), personId: "sam" },
  ]);

  const mine = await assignments("maya");
  // Urgent first, then low, and the unprioritised one last despite carrying the
  // smallest number — this is the whole reason the query does not sort on it.
  expect(mine.map((row) => row.identifier)).toEqual(["ENG-urgent", "ENG-low", "ENG-none"]);
  expect(mine[0]!.project_name).toBe("Billing");
  expect(mine[0]!.initiative_name).toBe("Revenue");
  // A project and an initiative are both optional, and absent is null, not "".
  expect(mine[1]!.project_name).toBeNull();
  expect(mine[1]!.initiative_name).toBeNull();

  // Unscoped covers the whole team; scoped covers one person.
  expect(await assignments()).toHaveLength(4);
  await prisma.openIssue.deleteMany({});
});

test("priorityLabel: names the scale, and never throws on a number from an API", () => {
  expect(priorityLabel(0)).toBe("no priority");
  expect(priorityLabel(1)).toBe("urgent");
  expect(priorityLabel(4)).toBe("low");
  // Outside the scale reads as unprioritised rather than crashing a brief.
  expect(priorityLabel(9)).toBe("no priority");
  expect(priorityLabel(-1)).toBe("no priority");
});

test("person focus: one current statement per person, replaced rather than logged", async () => {
  await setPersonFocus("maya", "Ship the billing migration");
  await setPersonFocus("sam", "Unblock the API review queue");

  let stated = await personFocus();
  expect(stated.map((row) => row.personId)).toEqual(["maya", "sam"]);
  expect(stated[0]!.focus).toBe("Ship the billing migration");

  // Setting again supersedes rather than appending: a stale instruction is not history.
  await setPersonFocus("maya", "Pair with Sam on the API");
  stated = await personFocus();
  expect(stated).toHaveLength(2);
  expect(stated[0]!.focus).toBe("Pair with Sam on the API");

  // Clearing means they have none again, and touches nobody else.
  await clearPersonFocus("maya");
  stated = await personFocus();
  expect(stated.map((row) => row.personId)).toEqual(["sam"]);

  // Clearing somebody who never had one is not an error.
  await clearPersonFocus("nobody");
  await prisma.personFocus.deleteMany({});
});

const person = (id: string, name: string) => ({
  id,
  name,
  githubLogins: [],
  workWeek: "sunday-thursday" as const,
});

test("focusBriefs: three lists per person, and an absent focus stays absent", async () => {
  await setPersonFocus("maya", "Ship the billing migration");
  await replaceOpenIssues([
    {
      id: "1",
      identifier: "ENG-1",
      title: "Billing migration",
      url: "https://linear.app/1",
      personId: "maya",
      state: "In Progress",
      priority: 1,
      updatedAt: ago(1),
    },
  ]);
  await saveActivities([
    { id: "f1", source: "github", type: "pr_merged", personId: "maya", ts: ago(1), title: "Migrate billing" },
    { id: "f2", source: "github", type: "pr_merged", personId: "sam", ts: ago(1), title: "Something else" },
  ]);

  const briefs = await focusBriefs({
    people: [person("maya", "Maya"), person("sam", "Sam")],
    since: SINCE,
  });

  const maya = briefs.find((brief) => brief.personId === "maya")!;
  expect(maya.declared?.focus).toBe("Ship the billing migration");
  expect(maya.assignments.map((row) => row.identifier)).toEqual(["ENG-1"]);
  expect(maya.events.map((row) => row.id)).toEqual(["f1"]);

  // Nobody stated anything about Sam, and he is assigned nothing. That is a real
  // answer — he still gets a brief, with the absence visible rather than filled in.
  const sam = briefs.find((brief) => brief.personId === "sam")!;
  expect(sam.declared).toBeNull();
  expect(sam.assignments).toEqual([]);
  expect(sam.events.map((row) => row.id)).toEqual(["f2"]);

  await prisma.openIssue.deleteMany({});
  await prisma.personFocus.deleteMany({});
});

test("markSynced: records the run, then updates it in place", async () => {
  await prisma.syncRun.deleteMany({});

  await markSynced("github");
  const first = await prisma.syncRun.findUnique({ where: { source: "github" } });
  expect(first).not.toBeNull();

  await markSynced("github");
  expect(await prisma.syncRun.count()).toBe(1);
  const second = await prisma.syncRun.findUnique({ where: { source: "github" } });
  expect(second!.lastRun.getTime()).toBeGreaterThanOrEqual(first!.lastRun.getTime());

  await prisma.syncRun.deleteMany({});
});

test("saveActivities: nothing in, nothing written; duplicates skipped", async () => {
  expect(await saveActivities([])).toBe(0);

  const row = {
    id: "d1",
    source: "github" as const,
    type: "pr_merged" as const,
    personId: "maya",
    ts: ago(1),
    body: "x".repeat(3000),
    title: "y".repeat(600),
  };
  expect(await saveActivities([row])).toBe(1);
  // The id is stable across re-syncs, so seeing the same event again is a no-op.
  expect(await saveActivities([row])).toBe(0);

  const [saved] = await activityFeed({ since: SINCE });
  expect(saved!.body).toHaveLength(2000);
  expect(saved!.title).toHaveLength(500);
});

test("repository filter: scopes GitHub events, and keeps everything that has no repository", async () => {
  await saveActivities([
    { id: "r1", source: "github", type: "pr_merged", personId: "maya", ts: ago(2),
      meta: { repo: "acme/web", number: 1 } },
    { id: "r2", source: "github", type: "pr_merged", personId: "maya", ts: ago(2),
      meta: { repo: "acme/api", number: 2 } },
    { id: "r3", source: "github", type: "pr_opened", personId: "maya", ts: ago(3),
      meta: { repo: "acme/web", number: 3 } },
    { id: "r4", source: "github", type: "pr_reviewed", personId: "sam", ts: ago(2),
      meta: { repo: "acme/web", number: 3 } },
    // Nothing from Slack or Linear happened in a repository, so both survive
    // every repository scope rather than being filtered away.
    { id: "r5", source: "slack", type: "message", personId: "sam", ts: ago(2) },
    { id: "r6", source: "linear", type: "issue_created", personId: "sam", ts: ago(2),
      workType: "bug" },
  ]);

  expect(await repositories(SINCE)).toEqual([
    { repo: "acme/web", events: 3 },
    { repo: "acme/api", events: 1 },
  ]);

  const web = await teamStats(SINCE, "acme/web");
  expect(web.prs_merged).toBe(1);
  expect(web.prs_opened).toBe(1);
  expect(web.reviews).toBe(1);
  expect(web.median_review_hours).toBeCloseTo(24, 0);
  // The Slack message belongs to no repository, so every repository keeps it.
  expect(web.messages).toBe(1);
  expect((await teamStats(SINCE)).messages).toBe(1);
  expect((await teamStats(SINCE, "acme/api")).messages).toBe(1);

  const [maya] = await personStats(SINCE, "acme/api");
  expect(maya!.prs_merged).toBe(1);

  const shipped = await shippedMix(SINCE, "acme/web");
  expect(shipped.reduce((total, bucket) => total + bucket.n, 0)).toBe(1);
  // Linear intake is not repository-scoped work, so it is reported under any repository.
  expect(await intakeMix(SINCE, "acme/web")).toEqual([{ bucket: "bug", n: 1 }]);

  expect((await bugRatio(SINCE, "acme/web")).shipped).toBe(1);
  expect(await reviewWaits(SINCE, "acme/web")).toHaveLength(1);

  // Three events in acme/web, plus the Slack message and Linear issue that
  // belong to no repository.
  const days = await dailyCounts(SINCE, "acme/web");
  expect(days.reduce((total, row) => total + row.n, 0)).toBe(5);

  const apiFeed = await activityFeed({ since: SINCE, repository: "acme/api" });
  expect(apiFeed.map((row) => row.id).sort()).toEqual(["r2", "r5", "r6"]);
});

test("hourlyCounts: bucketed by weekday and hour in the reader's zone", async () => {
  // 09:30 UTC on Wednesday 2026-07-15, and 23:30 UTC the same day.
  await saveActivities([
    { id: "h1", source: "github", type: "pr_merged", personId: "maya",
      ts: "2026-07-15T09:30:00.000Z", meta: { repo: "acme/web", number: 1 } },
    { id: "h2", source: "github", type: "pr_merged", personId: "maya",
      ts: "2026-07-15T09:45:00.000Z", meta: { repo: "acme/web", number: 2 } },
    { id: "h3", source: "slack", type: "message", personId: "sam",
      ts: "2026-07-15T23:30:00.000Z" },
  ]);
  const since = new Date("2026-07-01T00:00:00.000Z");

  const utc = await hourlyCounts(since, "UTC");
  // 3 is Wednesday, counting from 0 = Sunday.
  expect(utc).toEqual([
    { person_id: "maya", day_of_week: 3, hour: 9, n: 2 },
    { person_id: "sam", day_of_week: 3, hour: 23, n: 1 },
  ]);

  // Asia/Jerusalem is UTC+3 in July, so 23:30 UTC has already rolled into Thursday.
  const local = await hourlyCounts(since, "Asia/Jerusalem");
  expect(local).toEqual([
    { person_id: "maya", day_of_week: 3, hour: 12, n: 2 },
    { person_id: "sam", day_of_week: 4, hour: 2, n: 1 },
  ]);

  // The repository scope keeps events that belong to no repository, as everywhere else.
  const scoped = await hourlyCounts(since, "UTC", "acme/web");
  expect(scoped).toEqual([
    { person_id: "maya", day_of_week: 3, hour: 9, n: 2 },
    { person_id: "sam", day_of_week: 3, hour: 23, n: 1 },
  ]);
  expect(await hourlyCounts(since, "UTC", "acme/other")).toEqual([
    { person_id: "sam", day_of_week: 3, hour: 23, n: 1 },
  ]);
});

/** The parts of Storage the preferences module touches, with failure on demand. */
function fakeStorage(options: { throwOn?: "get" | "set" | "remove" } = {}): Storage {
  const entries = new Map<string, string>();
  return {
    getItem(key) {
      if (options.throwOn === "get") throw new Error("blocked");
      return entries.get(key) ?? null;
    },
    setItem(key, value) {
      if (options.throwOn === "set") throw new Error("quota exceeded");
      entries.set(key, value);
    },
    removeItem(key) {
      if (options.throwOn === "remove") throw new Error("blocked");
      entries.delete(key);
    },
    clear: () => entries.clear(),
    key: (index) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
  } as Storage;
}

test("saved view: a round trip, and a reset", () => {
  const storage = fakeStorage();
  const view = { range: "7d", repository: "acme/web", hideWeekends: false };

  expect(readSavedView(storage)).toBeNull();
  expect(writeSavedView(storage, view)).toBe(true);
  expect(readSavedView(storage)).toEqual(view);

  clearSavedView(storage);
  expect(readSavedView(storage)).toBeNull();
});

test("saved view: anything malformed falls back rather than half-applying", () => {
  const storage = fakeStorage();
  const stored = (value: string) => {
    storage.setItem("teampulse.defaultView", value);
    return readSavedView(storage);
  };

  expect(stored("not json at all")).toBeNull();
  expect(stored("null")).toBeNull();
  expect(stored('"a string"')).toBeNull();
  // Every field is required, and of the right type.
  expect(stored('{"repository":"","hideWeekends":true}')).toBeNull();
  expect(stored('{"range":"","repository":"","hideWeekends":true}')).toBeNull();
  expect(stored('{"range":"30d","hideWeekends":true}')).toBeNull();
  expect(stored('{"range":"30d","repository":"","hideWeekends":"yes"}')).toBeNull();
  // Unknown extras are dropped rather than carried through.
  expect(stored('{"range":"30d","repository":"","hideWeekends":true,"extra":1}')).toEqual({
    range: "30d",
    repository: "",
    hideWeekends: true,
  });
});

test("saved view: storage that is absent or blocked never breaks the page", () => {
  const view = { range: "30d", repository: "", hideWeekends: true };

  // No storage at all — server-side render, or a browser without it.
  expect(readSavedView(undefined)).toBeNull();
  expect(writeSavedView(undefined, view)).toBe(false);
  expect(clearSavedView(undefined)).toBeUndefined();

  // Private browsing throws on access rather than returning null.
  expect(readSavedView(fakeStorage({ throwOn: "get" }))).toBeNull();
  expect(writeSavedView(fakeStorage({ throwOn: "set" }), view)).toBe(false);
  expect(clearSavedView(fakeStorage({ throwOn: "remove" }))).toBeUndefined();
});

test("sameView and the built-in default", () => {
  expect(BUILT_IN_VIEW).toEqual({ range: "30d", repository: "", hideWeekends: true });

  expect(sameView(BUILT_IN_VIEW, { ...BUILT_IN_VIEW })).toBe(true);
  expect(sameView(BUILT_IN_VIEW, { ...BUILT_IN_VIEW, range: "7d" })).toBe(false);
  expect(sameView(BUILT_IN_VIEW, { ...BUILT_IN_VIEW, repository: "acme/web" })).toBe(false);
  expect(sameView(BUILT_IN_VIEW, { ...BUILT_IN_VIEW, hideWeekends: false })).toBe(false);
});

test("daySessions: a long enough silence splits the day, midnight always does", async () => {
  await saveActivities([
    // Morning session: three events, none more than an hour apart.
    { id: "s1", source: "github", type: "commit_pushed", personId: "maya",
      ts: "2026-07-15T06:00:00.000Z" },
    { id: "s2", source: "github", type: "commit_pushed", personId: "maya",
      ts: "2026-07-15T06:40:00.000Z" },
    { id: "s3", source: "slack", type: "message", personId: "maya",
      ts: "2026-07-15T07:30:00.000Z" },
    // Back after a two-hour gap: a second session, not a longer first one.
    { id: "s4", source: "github", type: "commit_pushed", personId: "maya",
      ts: "2026-07-15T09:30:00.000Z" },
    // Just before and just after local midnight: two days, never one session.
    { id: "s5", source: "slack", type: "message", personId: "sam",
      ts: "2026-07-15T23:50:00.000Z" },
    { id: "s6", source: "slack", type: "message", personId: "sam",
      ts: "2026-07-16T00:10:00.000Z" },
  ]);
  const since = new Date("2026-07-01T00:00:00.000Z");

  const sessions = await daySessions(since, "UTC");
  expect(sessions).toEqual([
    { person_id: "maya", day: "2026-07-15", started_minute: 360, ended_minute: 450, events: 3 },
    { person_id: "maya", day: "2026-07-15", started_minute: 570, ended_minute: 570, events: 1 },
    { person_id: "sam", day: "2026-07-15", started_minute: 1430, ended_minute: 1430, events: 1 },
    { person_id: "sam", day: "2026-07-16", started_minute: 10, ended_minute: 10, events: 1 },
  ]);

  // A wider break threshold folds the two-hour gap back into one session.
  const relaxed = await daySessions(since, "UTC", undefined, 180);
  expect(relaxed.filter((row) => row.person_id === "maya")).toEqual([
    { person_id: "maya", day: "2026-07-15", started_minute: 360, ended_minute: 570, events: 4 },
  ]);

  // The default threshold is the one the no-argument call uses.
  expect(DEFAULT_BREAK_MINUTES).toBe(60);
  expect(await daySessions(since, "UTC", undefined, DEFAULT_BREAK_MINUTES)).toEqual(sessions);

  // The zone shifts both the clock and which calendar day an event lands on.
  const local = await daySessions(since, "Asia/Jerusalem");
  expect(local[0]).toEqual({
    person_id: "maya", day: "2026-07-15", started_minute: 540, ended_minute: 630, events: 3,
  });

  // Repository scope reaches here too, and events with no repository survive it.
  expect(await daySessions(since, "UTC", "acme/web")).toEqual(sessions);
});

test("KIND_OF covers every activity type exactly once", () => {
  // The taxonomy is what the day-shape colours mean. A type nobody classified
  // would silently vanish from the chart rather than draw in the wrong colour.
  const types: ActivityType[] = [
    "pr_opened", "pr_merged", "pr_reviewed", "pr_commented", "commit_pushed",
    "deployed", "ci_run", "issue_created", "issue_completed", "issue_commented",
    "message", "thread_reply", "mention_received", "directive_received",
    "doc_created", "doc_edited", "meeting",
  ];
  for (const type of types) expect(kindOf(type)).not.toBeNull();
  expect(Object.keys(KIND_OF).toSorted()).toEqual(types.toSorted());
  expect(kindOf("something_new")).toBeNull();
});

test("daySessions: a meeting occupies its real length, and swallows events inside it", async () => {
  await saveActivities([
    // A 90-minute meeting, and a commit pushed in the middle of it.
    { id: "m1", source: "calendar", type: "meeting", personId: "maya",
      ts: "2026-07-15T09:00:00.000Z", endsAt: "2026-07-15T10:30:00.000Z" },
    { id: "m2", source: "github", type: "commit_pushed", personId: "maya",
      ts: "2026-07-15T09:40:00.000Z" },
    // Well after the meeting ends: a separate block.
    { id: "m3", source: "github", type: "commit_pushed", personId: "maya",
      ts: "2026-07-15T12:00:00.000Z" },
  ]);
  const since = new Date("2026-07-01T00:00:00.000Z");

  expect(await daySessions(since, "UTC")).toEqual([
    // 09:00 → 10:30, not 09:00 → 09:40: the meeting's own end is what closed it.
    { person_id: "maya", day: "2026-07-15", started_minute: 540, ended_minute: 630, events: 2 },
    { person_id: "maya", day: "2026-07-15", started_minute: 720, ended_minute: 720, events: 1 },
  ]);
});

test("dayMarks: instants and meetings, grouped per minute and kind", async () => {
  await saveActivities([
    { id: "k1", source: "calendar", type: "meeting", personId: "maya",
      ts: "2026-07-15T09:00:00.000Z", endsAt: "2026-07-15T10:00:00.000Z" },
    { id: "k2", source: "github", type: "commit_pushed", personId: "maya",
      ts: "2026-07-15T11:05:00.000Z" },
    { id: "k3", source: "github", type: "pr_merged", personId: "maya",
      ts: "2026-07-15T11:05:30.000Z", meta: { repo: "acme/web", number: 9 } },
    { id: "k4", source: "slack", type: "message", personId: "maya",
      ts: "2026-07-15T11:05:45.000Z" },
  ]);
  const since = new Date("2026-07-01T00:00:00.000Z");

  const marks = await dayMarks(since, "UTC");
  expect(marks).toEqual([
    { person_id: "maya", day: "2026-07-15", type: "meeting",
      started_minute: 540, ended_minute: 600, n: 1 },
    // Two different types in the same minute stay two marks; two events of the
    // same type in one minute collapse into one carrying a count.
    { person_id: "maya", day: "2026-07-15", type: "commit_pushed",
      started_minute: 665, ended_minute: 665, n: 1 },
    { person_id: "maya", day: "2026-07-15", type: "message",
      started_minute: 665, ended_minute: 665, n: 1 },
    { person_id: "maya", day: "2026-07-15", type: "pr_merged",
      started_minute: 665, ended_minute: 665, n: 1 },
  ].toSorted((a, b) => a.started_minute - b.started_minute || a.type.localeCompare(b.type)));
});

test("coverage: counts per person per source, and says when each source last ran", async () => {
  await saveActivities([
    { id: "c1", source: "github", type: "commit_pushed", personId: "maya", ts: ago(1) },
    { id: "c2", source: "github", type: "commit_pushed", personId: "maya", ts: ago(2) },
    { id: "c3", source: "slack", type: "message", personId: "sam", ts: ago(1) },
  ]);
  await markSynced("notion");

  const rows = await coverage(SINCE);
  expect(rows.map((row) => [row.person_id, row.source, row.events])).toEqual([
    ["maya", "github", 2],
    ["sam", "slack", 1],
  ]);
  // A source that ran and found nothing still reports a run — silence and
  // never-ran are different problems.
  expect((await lastSyncs()).map((row) => row.source)).toContain("notion");
});

test("aiUsage: daily Claude Code rows are upserted, then summed per person", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const row = {
    personId: "maya", day, model: "claude-opus-5",
    sessions: 3, inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 50, cacheCreationTokens: 10,
    costAmount: 186, currency: "USD",
    linesAdded: 40, linesRemoved: 5, commits: 2, pullRequests: 1,
    toolsAccepted: 9, toolsRejected: 1,
  };
  await replaceAiUsage([row]);
  // A day's totals grow until the day is over, so the same key must overwrite
  // rather than accumulate — the second write is the whole day, not a delta.
  await replaceAiUsage([{ ...row, sessions: 4, outputTokens: 25 }]);

  const [summary] = await aiUsage(SINCE);
  expect(summary).toMatchObject({
    person_id: "maya", sessions: 4, input_tokens: 100, output_tokens: 25,
    cost_amount: 186, currency: "USD", commits: 2, tools_accepted: 9, days_used: 1,
  });

  expect(await aiUsageDaily(SINCE)).toEqual([
    { person_id: "maya", day, tokens: 185, cost_amount: 186 },
  ]);
});

test("vercel scope: a slug and a real team id go in different parameters", () => {
  // `vercel teams ls` prints slugs under a column headed "id", so both shapes
  // reach .env — and sending a slug as teamId fails as "team not found".
  const slug = scopeOf("acme-team", new URL("https://api.vercel.com/v6/deployments"));
  expect(slug.searchParams.get("slug")).toBe("acme-team");
  expect(slug.searchParams.get("teamId")).toBeNull();

  const id = scopeOf("team_abc123", new URL("https://api.vercel.com/v6/deployments"));
  expect(id.searchParams.get("teamId")).toBe("team_abc123");

  // A personal account has no scope at all.
  expect([...scopeOf(undefined, new URL("https://api.vercel.com/v6/deployments")).searchParams]).toEqual([]);
});

test("collectVercel: pages through deployments, credits by username then email", async () => {
  const people = indexPeople({
    people: [
      { id: "maya", name: "Maya", githubLogins: [], vercel: "maya-v", workWeek: "sunday-thursday" },
      { id: "sam", name: "Sam", githubLogins: [], email: "Sam@acme.com", workWeek: "monday-friday" },
    ],
  });

  const pages = [
    {
      deployments: [
        { uid: "d1", name: "web", url: "web.vercel.app", created: 1_760_000_000_000,
          target: "production", state: "READY", creator: { username: "maya-v" } },
        // No handle anywhere in people.yaml: a build by a bot or a stranger.
        { uid: "d2", name: "web", created: 1_760_000_100_000, creator: { username: "ci-bot" } },
      ],
      pagination: { next: 1_759_000_000_000 },
    },
    {
      deployments: [
        // Only an email: the local part is the fallback handle, case-insensitively.
        { uid: "d3", name: "api", created: 1_759_500_000_000, creator: { email: "Sam@acme.com" } },
      ],
      pagination: { next: null },
    },
  ];

  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  // Bun's fetch carries a `preconnect` property the stubs do not; the cast is
  // over a value only this test ever calls, and it is restored in `finally`.
  const stub = (handler: (input: string | URL) => Promise<Response>) =>
    Object.assign(handler, { preconnect: realFetch.preconnect }) as typeof fetch;
  process.env.VERCEL_TOKEN = "test-token";
  process.env.VERCEL_TEAM_ID = "acme-team";
  globalThis.fetch = stub(async (input) => {
    requested.push(String(input));
    return new Response(JSON.stringify(pages.shift() ?? { deployments: [] }), { status: 200 });
  });

  try {
    const rows = await collectVercel(people, new Date("2026-07-01T00:00:00.000Z"));
    expect(rows.map((row) => [row.id, row.personId, row.type])).toEqual([
      ["vercel:deployed:d1", "maya", "deployed"],
      ["vercel:deployed:d3", "sam", "deployed"],
    ]);
    expect(rows[0]?.title).toBe("deployed web to production");
    expect(rows[0]?.url).toBe("https://web.vercel.app");
    // The second request walks backwards from the first page's cursor.
    expect(requested[0]).toContain("slug=acme-team");
    expect(requested[1]).toContain("until=1759000000000");

    // A failed call is loud rather than an empty sync that reads as a quiet week.
    globalThis.fetch = stub(async () =>
      new Response(JSON.stringify({ error: { message: "not authorized" } }), { status: 403 }));
    expect(collectVercel(people, new Date())).rejects.toThrow(/not authorized/);

    // Deployments exist but nobody matches: the sync line would read "0 events",
    // so the collector has to name the handles instead of shrugging.
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    globalThis.fetch = stub(async () =>
      new Response(
        JSON.stringify({
          deployments: [
            { uid: "d9", name: "web", created: 1_760_000_000_000, creator: { username: "ci-bot" } },
          ],
          pagination: { next: null },
        }),
        { status: 200 },
      ));
    try {
      expect(await collectVercel(people, new Date("2026-07-01T00:00:00.000Z"))).toEqual([]);
      expect(warnings.join(" ")).toContain("ci-bot");
    } finally {
      console.warn = realWarn;
    }

    process.env.VERCEL_TOKEN = "";
    expect(collectVercel(people, new Date())).rejects.toThrow(/VERCEL_TOKEN not set/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
