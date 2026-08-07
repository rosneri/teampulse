import { indexPeople, loadConfig, parseSince } from "./config";
import { prisma } from "./db";
import {
  bugRatio, dailyCounts, intakeMix, personStats, reviewWaits,
  shippedMix, staleIssues, teamStats,
} from "./metrics";
import { sync } from "./sync";
import type { Source } from "./types";

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

const since = parseSince(flag("since", "30d")!);
const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(0)}%`);
const hrs = (n: number | null) => (n === null ? "—" : n < 48 ? `${n.toFixed(1)}h` : `${(n / 24).toFixed(1)}d`);
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const rpad = (s: string | number, n: number) => String(s).padStart(n);

function mixLine(rows: { bucket: string; n: number }[]): string {
  const total = rows.reduce((a, r) => a + r.n, 0);
  if (!total) return "  (nothing in window)";
  return rows.map((r) => `  ${pad(r.bucket, 14)} ${rpad(r.n, 4)}  ${rpad(pct(r.n / total), 5)}`).join("\n");
}

async function team() {
  const cfg = await loadConfig();
  const people = indexPeople(cfg);
  const [stats, waits, days, t, ship, intake, bugs, stale] = await Promise.all([
    personStats(since), reviewWaits(since), dailyCounts(since), teamStats(since),
    shippedMix(since), intakeMix(since), bugRatio(since), staleIssues(),
  ]);

  const waitBy = new Map(waits.map((w) => [w.person_id, w]));
  const window = `${since.toISOString().slice(0, 10)} → today`;

  console.log(`\nTEAM · ${window}\n`);
  console.log(`  active people      ${t.people_active}`);
  console.log(`  PRs merged         ${t.prs_merged}   (opened ${t.prs_opened})`);
  console.log(`  reviews given      ${t.reviews}`);
  console.log(`  issues completed   ${t.issues_completed}   (created ${t.issues_created})`);
  console.log(`  messages           ${t.messages}`);
  console.log(`  median review wait ${hrs(t.median_review_hours)}`);

  console.log(`\nSHIPPED — merged PRs by kind`);
  console.log(mixLine(ship));
  console.log(`\nINTAKE — issues created by kind`);
  console.log(mixLine(intake));

  console.log(`\nBUGS`);
  console.log(`  bugs reported        ${bugs.bugs_reported}`);
  console.log(`  PRs merged           ${bugs.shipped}`);
  console.log(`  bugs per delivery    ${bugs.bugs_per_delivery?.toFixed(2) ?? "—"}`);
  console.log(`  fix share of shipped ${pct(bugs.fix_share)}   (${bugs.bug_fixes_shipped} of ${bugs.shipped})`);

  // Sparkline of daily activity per person — the strip from the dashboard design.
  const blocks = " ▁▂▃▄▅▆▇█";
  const byPerson = new Map<string, Map<string, number>>();
  let peak = 1;
  for (const d of days) {
    const key = new Date(d.day).toISOString().slice(0, 10);
    if (!byPerson.has(d.person_id)) byPerson.set(d.person_id, new Map());
    byPerson.get(d.person_id)!.set(key, d.n);
    peak = Math.max(peak, d.n);
  }
  const span: string[] = [];
  for (let t0 = since.getTime(); t0 <= Date.now(); t0 += 86_400_000) {
    span.push(new Date(t0).toISOString().slice(0, 10));
  }

  console.log(`\nPEOPLE`);
  console.log(
    `  ${pad("person", 12)} ${pad("activity", Math.min(span.length, 60))} ` +
      `${rpad("merged", 7)} ${rpad("revw", 5)} ${rpad("done", 5)} ${rpad("msgs", 5)} ${rpad("wait", 7)}`,
  );
  for (const p of people.all) {
    const s = stats.find((x) => x.person_id === p.id);
    const strip = span
      .slice(-60)
      .map((day) => blocks[Math.min(8, Math.ceil(((byPerson.get(p.id)?.get(day) ?? 0) / peak) * 8))])
      .join("");
    console.log(
      `  ${pad(p.name, 12)} ${strip} ${rpad(s?.prs_merged ?? 0, 7)} ${rpad(s?.reviews ?? 0, 5)} ` +
        `${rpad(s?.issues_completed ?? 0, 5)} ${rpad(s?.messages ?? 0, 5)} ${rpad(hrs(waitBy.get(p.id)?.median_hours ?? null), 7)}`,
    );
  }

  if (stale.length) {
    console.log(`\nSTALE — open assignments untouched 14d+`);
    for (const s of stale.slice(0, 15)) {
      console.log(`  ${pad(s.person_id, 12)} ${rpad(s.age_days + "d", 5)}  ${s.identifier} ${s.title.slice(0, 60)}`);
    }
  }
  console.log();
}

async function person(id: string) {
  const cfg = await loadConfig();
  const p = indexPeople(cfg).byId.get(id);
  if (!p) throw new Error(`no person "${id}" in people.yaml`);

  const [stats, waits] = await Promise.all([personStats(since), reviewWaits(since)]);
  const s = stats.find((x) => x.person_id === id);
  const w = waits.find((x) => x.person_id === id);

  console.log(`\n${p.name.toUpperCase()} · ${since.toISOString().slice(0, 10)} → today\n`);
  console.log(`  PRs merged        ${s?.prs_merged ?? 0}`);
  console.log(`  PRs opened        ${s?.prs_opened ?? 0}`);
  console.log(`  reviews given     ${s?.reviews ?? 0}`);
  console.log(`  issues completed  ${s?.issues_completed ?? 0}`);
  console.log(`  issues created    ${s?.issues_created ?? 0}`);
  console.log(`  messages          ${s?.messages ?? 0}`);
  console.log(`  asks from you     ${s?.directives ?? 0}`);
  console.log(`  active days       ${s?.active_days ?? 0}`);
  console.log(`  median review wait ${hrs(w?.median_hours ?? null)}  (${w?.unreviewed ?? 0} PRs never reviewed)`);

  const feed = await prisma.activity.findMany({
    where: { personId: id, ts: { gte: since } },
    orderBy: { ts: "desc" },
    take: 40,
  });
  console.log(`\n  TIMELINE`);
  for (const a of feed) {
    const when = a.ts.toISOString().slice(0, 16).replace("T", " ");
    const text = (a.title ?? a.body ?? "").replace(/\s+/g, " ").slice(0, 70);
    console.log(`  ${when}  ${pad(a.source, 7)} ${pad(a.type, 18)} ${text}`);
  }
  console.log();
}

try {
  switch (cmd) {
    case "sync": {
      const src = flag("source");
      await sync(since, src ? [src as Source] : undefined);
      break;
    }
    case "team":
      await team();
      break;
    case "person":
      await person(args[1]!);
      break;
    default:
      console.log(`teampulse

  sync   [--since 30d] [--source github|linear|slack]
  team   [--since 30d]
  person <id> [--since 30d]`);
  }
} finally {
  await prisma.$disconnect();
}
