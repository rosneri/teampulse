import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import type { Activity, OpenIssue } from "./types";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL not set — see .env.example");

export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const MAX_BODY = 2000;

function toRow(a: Activity) {
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
    meta: (a.meta ?? null) as never,
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

export async function markSynced(source: string): Promise<void> {
  const lastRun = new Date();
  await prisma.syncRun.upsert({
    where: { source },
    create: { source, lastRun },
    update: { lastRun },
  });
}
