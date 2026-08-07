import { prisma } from "./db";

/**
 * Everything here is plain SQL over the activity table — deterministic,
 * reproducible, and free. No model is involved in producing any number below.
 */

export type PersonStats = {
  person_id: string;
  prs_opened: number;
  prs_merged: number;
  reviews: number;
  issues_created: number;
  issues_completed: number;
  messages: number;
  directives: number;
  active_days: number;
};

export function personStats(since: Date) {
  return prisma.$queryRaw<PersonStats[]>`
    select person_id,
      count(*) filter (where type = 'pr_opened')::int       as prs_opened,
      count(*) filter (where type = 'pr_merged')::int       as prs_merged,
      count(*) filter (where type = 'pr_reviewed')::int     as reviews,
      count(*) filter (where type = 'issue_created')::int   as issues_created,
      count(*) filter (where type = 'issue_completed')::int as issues_completed,
      count(*) filter (where type in ('message', 'thread_reply'))::int as messages,
      count(*) filter (where type = 'directive_received')::int        as directives,
      count(distinct date_trunc('day', ts))::int            as active_days
    from activity
    where ts >= ${since}
    group by person_id
    order by person_id`;
}

/**
 * Time from PR opened to its first review, attributed to the PR's author —
 * i.e. "how long this person waits to get unblocked". Attributing to reviewers
 * instead would need review-request data we do not collect.
 */
export type ReviewWait = { person_id: string; median_hours: number | null; reviewed: number; unreviewed: number };

export function reviewWaits(since: Date) {
  return prisma.$queryRaw<ReviewWait[]>`
    with opened as (
      select person_id, meta ->> 'repo' as repo, (meta ->> 'number')::int as num, ts
      from activity
      where type = 'pr_opened' and ts >= ${since} and meta ? 'repo'
    ),
    first_review as (
      select meta ->> 'repo' as repo, (meta ->> 'number')::int as num, min(ts) as ts
      from activity
      where type = 'pr_reviewed' and meta ? 'repo'
      group by 1, 2
    )
    select o.person_id,
      percentile_cont(0.5) within group (
        order by extract(epoch from (f.ts - o.ts)) / 3600.0
      ) filter (where f.ts > o.ts) as median_hours,
      count(f.ts)::int                        as reviewed,
      count(*) filter (where f.ts is null)::int as unreviewed
    from opened o
    left join first_review f on f.repo = o.repo and f.num = o.num
    group by o.person_id
    order by median_hours desc nulls last`;
}

export type Bucket = { bucket: string; n: number };

/** What we ship, by kind. Computed over merged PRs only — Linear issues are
 *  counted separately below so nothing is double-counted. */
export function shippedMix(since: Date) {
  return prisma.$queryRaw<Bucket[]>`
    select coalesce(work_type, 'unclassified') as bucket, count(*)::int as n
    from activity
    where type = 'pr_merged' and ts >= ${since}
    group by 1
    order by n desc`;
}

/** What comes in, by kind — created Linear issues. */
export function intakeMix(since: Date) {
  return prisma.$queryRaw<Bucket[]>`
    select coalesce(work_type, 'unclassified') as bucket, count(*)::int as n
    from activity
    where type = 'issue_created' and ts >= ${since}
    group by 1
    order by n desc`;
}

export type BugRatio = {
  bugs_reported: number;
  shipped: number;
  bug_fixes_shipped: number;
  /** bugs reported per merged PR — rising means quality is outrunning delivery */
  bugs_per_delivery: number | null;
  /** share of shipped PRs that were fixes rather than new work */
  fix_share: number | null;
};

export async function bugRatio(since: Date): Promise<BugRatio> {
  const [row] = await prisma.$queryRaw<
    { bugs_reported: number; shipped: number; bug_fixes_shipped: number }[]
  >`
    select
      count(*) filter (where type = 'issue_created' and work_type = 'bug')::int as bugs_reported,
      count(*) filter (where type = 'pr_merged')::int                           as shipped,
      count(*) filter (where type = 'pr_merged' and work_type = 'bug')::int     as bug_fixes_shipped
    from activity
    where ts >= ${since}`;

  const r = row ?? { bugs_reported: 0, shipped: 0, bug_fixes_shipped: 0 };
  return {
    ...r,
    bugs_per_delivery: r.shipped ? r.bugs_reported / r.shipped : null,
    fix_share: r.shipped ? r.bug_fixes_shipped / r.shipped : null,
  };
}

export type TeamStats = {
  people_active: number;
  prs_opened: number;
  prs_merged: number;
  reviews: number;
  issues_created: number;
  issues_completed: number;
  messages: number;
  median_review_hours: number | null;
};

export async function teamStats(since: Date): Promise<TeamStats> {
  const [totals] = await prisma.$queryRaw<Omit<TeamStats, "median_review_hours">[]>`
    select
      count(distinct person_id)::int                        as people_active,
      count(*) filter (where type = 'pr_opened')::int       as prs_opened,
      count(*) filter (where type = 'pr_merged')::int       as prs_merged,
      count(*) filter (where type = 'pr_reviewed')::int     as reviews,
      count(*) filter (where type = 'issue_created')::int   as issues_created,
      count(*) filter (where type = 'issue_completed')::int as issues_completed,
      count(*) filter (where type in ('message', 'thread_reply'))::int as messages
    from activity
    where ts >= ${since}`;

  const [wait] = await prisma.$queryRaw<{ median_hours: number | null }[]>`
    with opened as (
      select meta ->> 'repo' as repo, (meta ->> 'number')::int as num, ts
      from activity where type = 'pr_opened' and ts >= ${since} and meta ? 'repo'
    ),
    first_review as (
      select meta ->> 'repo' as repo, (meta ->> 'number')::int as num, min(ts) as ts
      from activity where type = 'pr_reviewed' and meta ? 'repo' group by 1, 2
    )
    select percentile_cont(0.5) within group (
      order by extract(epoch from (f.ts - o.ts)) / 3600.0
    ) as median_hours
    from opened o join first_review f on f.repo = o.repo and f.num = o.num
    where f.ts > o.ts`;

  return { ...(totals as any), median_review_hours: wait?.median_hours ?? null };
}

/** One row per person per day — the activity strip on the team board. */
export type DayCount = { person_id: string; day: Date; n: number };

export function dailyCounts(since: Date) {
  return prisma.$queryRaw<DayCount[]>`
    select person_id, date_trunc('day', ts)::date as day, count(*)::int as n
    from activity
    where ts >= ${since}
    group by 1, 2
    order by 1, 2`;
}

/** Open assignments nobody has touched in a while. */
export function staleIssues(days = 14) {
  return prisma.$queryRaw<
    { person_id: string; identifier: string; title: string; url: string; age_days: number }[]
  >`
    select person_id, identifier, title, url,
      extract(day from (now() - updated_at))::int as age_days
    from open_issue
    where updated_at < now() - make_interval(days => ${days})
    order by updated_at asc`;
}
