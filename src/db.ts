import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "./generated/prisma/client";
import type { AiUsageRow } from "./sources/anthropic";
import type { Activity, OpenIssue } from "./types";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL not set — see .env.example");

export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const MAX_BODY = 2000;

function toRow(a: Activity) {
  // `endsAt` rides inside meta rather than earning a column: one source in one
  // event type has a duration, and the day-shape query is the only reader.
  const meta =
    a.endsAt === undefined
      ? (a.meta ?? null)
      : { ...(a.meta && typeof a.meta === "object" ? a.meta : {}), endsAt: a.endsAt };

  return {
    id: a.id,
    source: a.source,
    type: a.type,
    personId: a.personId,
    workType: a.workType ?? null,
    ts: new Date(a.ts),
    url: a.url ?? null,
    title: a.title?.slice(0, 500) ?? null,
    body: a.body?.slice(0, MAX_BODY) ?? null,
    meta: meta as never,
  };
}

/**
 * Activity rows are immutable facts keyed by a stable id, so a re-sync that sees
 * the same event again can simply skip it.
 * ponytail: skipDuplicates means an edited PR title never refreshes. Swap for a
 * raw INSERT ... ON CONFLICT DO UPDATE if that starts mattering.
 */
export async function saveActivities(rows: Activity[]): Promise<number> {
  if (!rows.length) return 0;
  const res = await prisma.activity.createMany({
    data: rows.map(toRow),
    skipDuplicates: true,
  });
  return res.count;
}

/** Snapshot table: replaced wholesale, never merged. */
export async function replaceOpenIssues(rows: OpenIssue[]): Promise<number> {
  await prisma.$transaction([
    prisma.openIssue.deleteMany({}),
    prisma.openIssue.createMany({
      data: rows.map((i) => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title.slice(0, 500),
        url: i.url,
        personId: i.personId,
        state: i.state,
        workType: i.workType ?? null,
        priority: i.priority,
        updatedAt: new Date(i.updatedAt),
      })),
    }),
  ]);
  return rows.length;
}

/**
 * A day's Claude Code totals grow until the day is over, so these rows are
 * upserted rather than skipped on conflict — unlike activity, which is immutable.
 */
export async function replaceAiUsage(rows: AiUsageRow[]): Promise<number> {
  if (!rows.length) return 0;
  await prisma.$transaction(
    rows.map((row) =>
      prisma.aiUsage.upsert({
        where: {
          personId_day_model: {
            personId: row.personId,
            day: new Date(`${row.day}T00:00:00Z`),
            model: row.model,
          },
        },
        create: { ...row, day: new Date(`${row.day}T00:00:00Z`) },
        update: { ...row, day: new Date(`${row.day}T00:00:00Z`), syncedAt: new Date() },
      }),
    ),
  );
  return rows.length;
}

/** What the AI layer is allowed to have an opinion about. */
export type AiOutputKind = "summary" | "work_type";

export type AiOutputRow = {
  kind: AiOutputKind;
  personId: string;
  windowStart: Date;
  windowEnd: Date;
  /** sha-256 of the exact prompt the model was shown, so a claim can be traced to its input. */
  inputDigest: string;
  payload: Prisma.InputJsonValue;
};

/**
 * Judgment, appended and never updated: two runs over the same window are two
 * rows, and the older one stays readable. Nothing here touches `activity` — a
 * proposed work type lives in this table and in no other.
 */
export async function saveAiOutput(row: AiOutputRow): Promise<void> {
  await prisma.aiOutput.create({ data: row });
}

/**
 * The most recent judgment of this kind made from exactly this input. A hit
 * means the model has already answered this question about this person and
 * asking again would only cost money.
 */
export function findAiOutput(kind: AiOutputKind, personId: string, inputDigest: string) {
  return prisma.aiOutput.findFirst({
    where: { kind, personId, inputDigest },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Judgments, newest first. Two rows per person per run keeps this table small,
 * so the whole recent history is cheaper to fetch than to filter — the caller
 * keeps the newest of each kind and drops the rest.
 */
export function recentAiOutputs(limit = 200) {
  return prisma.aiOutput.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}

export async function markSynced(source: string): Promise<void> {
  const lastRun = new Date();
  await prisma.syncRun.upsert({
    where: { source },
    create: { source, lastRun },
    update: { lastRun },
  });
}
