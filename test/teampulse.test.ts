import { afterAll, beforeEach, expect, test } from "bun:test";
import { parseSince } from "../src/config";
import { prisma, saveActivities } from "../src/db";
import { bugRatio, personStats, reviewWaits, shippedMix } from "../src/metrics";
import { classify } from "../src/worktype";

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const SINCE = new Date(Date.now() - 30 * 86_400_000);

beforeEach(async () => {
  await prisma.activity.deleteMany({});
});

afterAll(async () => {
  await prisma.activity.deleteMany({});
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
