import { prisma } from "./db";
import { Prisma } from "./generated/prisma/client";

/**
 * Everything here is plain SQL over the activity table — deterministic,
 * reproducible, and free. No model is involved in producing any number below.
 */

/**
 * Narrows a query to one repository. Only GitHub events carry `meta.repo`;
 * Linear issues and Slack messages did not happen in a repository at all, so
 * they are kept under every repository rather than dropped — otherwise picking
 * a repository would zero out intake, bug counts and conversation, and the
 * dashboard would read as if the team had stopped talking. Pass nothing for
 * the whole team.
 */
function inRepository(repository?: string) {
  return repository
    ? Prisma.sql`and (meta ->> 'repo' = ${repository} or meta ->> 'repo' is null)`
    : Prisma.empty;
}

export type Repository = { repo: string; events: number };

/** Every repository present in the window, busiest first — the filter's options. */
export function repositories(since: Date) {
  return prisma.$queryRaw<Repository[]>`
    select meta ->> 'repo' as repo, count(*)::int as events
    from activity
    where ts >= ${since} and meta ? 'repo'
    group by 1
    order by events desc, repo asc`;
}

export type PersonStats = {
  person_id: string;
  prs_opened: number;
  prs_merged: number;
  /** Landed on a default branch outside any pull request, so never also a `prs_merged`. */
  commits_pushed: number;
  reviews: number;
  issues_created: number;
  issues_completed: number;
  messages: number;
  directives: number;
  active_days: number;
};

export function personStats(since: Date, repository?: string) {
  return prisma.$queryRaw<PersonStats[]>`
    select person_id,
      count(*) filter (where type = 'pr_opened')::int       as prs_opened,
      count(*) filter (where type = 'pr_merged')::int       as prs_merged,
      count(*) filter (where type = 'commit_pushed')::int   as commits_pushed,
      count(*) filter (where type = 'pr_reviewed')::int     as reviews,
      count(*) filter (where type = 'issue_created')::int   as issues_created,
      count(*) filter (where type = 'issue_completed')::int as issues_completed,
      count(*) filter (where type in ('message', 'thread_reply'))::int as messages,
      count(*) filter (where type = 'directive_received')::int        as directives,
      count(distinct date_trunc('day', ts))::int            as active_days
    from activity
    where ts >= ${since} ${inRepository(repository)}
    group by person_id
    order by person_id`;
}

/**
 * Time from PR opened to its first review, attributed to the PR's author —
 * i.e. "how long this person waits to get unblocked". Attributing to reviewers
 * instead would need review-request data we do not collect.
 */
export type ReviewWait = { person_id: string; median_hours: number | null; reviewed: number; unreviewed: number };

export function reviewWaits(since: Date, repository?: string) {
  return prisma.$queryRaw<ReviewWait[]>`
    with opened as (
      select person_id, meta ->> 'repo' as repo, (meta ->> 'number')::int as num, ts
      from activity
      where type = 'pr_opened' and ts >= ${since} and meta ? 'repo' ${inRepository(repository)}
    ),
    first_review as (
      select meta ->> 'repo' as repo, (meta ->> 'number')::int as num, min(ts) as ts
      from activity
      where type = 'pr_reviewed' and meta ? 'repo' ${inRepository(repository)}
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
export function shippedMix(since: Date, repository?: string) {
  return prisma.$queryRaw<Bucket[]>`
    select coalesce(work_type, 'unclassified') as bucket, count(*)::int as n
    from activity
    where type = 'pr_merged' and ts >= ${since} ${inRepository(repository)}
    group by 1
    order by n desc`;
}

/** What comes in, by kind — created Linear issues. */
export function intakeMix(since: Date, repository?: string) {
  return prisma.$queryRaw<Bucket[]>`
    select coalesce(work_type, 'unclassified') as bucket, count(*)::int as n
    from activity
    where type = 'issue_created' and ts >= ${since} ${inRepository(repository)}
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

export async function bugRatio(since: Date, repository?: string): Promise<BugRatio> {
  const [row] = await prisma.$queryRaw<
    { bugs_reported: number; shipped: number; bug_fixes_shipped: number }[]
  >`
    select
      count(*) filter (where type = 'issue_created' and work_type = 'bug')::int as bugs_reported,
      count(*) filter (where type = 'pr_merged')::int                           as shipped,
      count(*) filter (where type = 'pr_merged' and work_type = 'bug')::int     as bug_fixes_shipped
    from activity
    where ts >= ${since} ${inRepository(repository)}`;

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
  /** Landed on a default branch outside any pull request, so never also a `prs_merged`. */
  commits_pushed: number;
  reviews: number;
  issues_created: number;
  issues_completed: number;
  messages: number;
  median_review_hours: number | null;
};

export async function teamStats(since: Date, repository?: string): Promise<TeamStats> {
  const [totals] = await prisma.$queryRaw<Omit<TeamStats, "median_review_hours">[]>`
    select
      count(distinct person_id)::int                        as people_active,
      count(*) filter (where type = 'pr_opened')::int       as prs_opened,
      count(*) filter (where type = 'pr_merged')::int       as prs_merged,
      count(*) filter (where type = 'commit_pushed')::int   as commits_pushed,
      count(*) filter (where type = 'pr_reviewed')::int     as reviews,
      count(*) filter (where type = 'issue_created')::int   as issues_created,
      count(*) filter (where type = 'issue_completed')::int as issues_completed,
      count(*) filter (where type in ('message', 'thread_reply'))::int as messages
    from activity
    where ts >= ${since} ${inRepository(repository)}`;

  const [wait] = await prisma.$queryRaw<{ median_hours: number | null }[]>`
    with opened as (
      select meta ->> 'repo' as repo, (meta ->> 'number')::int as num, ts
      from activity
      where type = 'pr_opened' and ts >= ${since} and meta ? 'repo' ${inRepository(repository)}
    ),
    first_review as (
      select meta ->> 'repo' as repo, (meta ->> 'number')::int as num, min(ts) as ts
      from activity
      where type = 'pr_reviewed' and meta ? 'repo' ${inRepository(repository)}
      group by 1, 2
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

export function dailyCounts(since: Date, repository?: string) {
  return prisma.$queryRaw<DayCount[]>`
    select person_id, date_trunc('day', ts)::date as day, count(*)::int as n
    from activity
    where ts >= ${since} ${inRepository(repository)}
    group by 1, 2
    order by 1, 2`;
}

/**
 * One row per person per weekday per hour — the work-hours heat map.
 *
 * `timezone` is an IANA name, applied in the database so daylight saving is the
 * zone's own rather than a fixed offset applied afterwards. The weekday comes
 * back raw (0 is Sunday, as `weekendDays` reads it) because which days are a
 * weekend is a property of the person, and people.yaml — not this table — knows it.
 */
export type HourCount = { person_id: string; day_of_week: number; hour: number; n: number };

export function hourlyCounts(since: Date, timezone: string, repository?: string) {
  return prisma.$queryRaw<HourCount[]>`
    select person_id,
      extract(dow  from ts at time zone ${timezone})::int as day_of_week,
      extract(hour from ts at time zone ${timezone})::int as hour,
      count(*)::int as n
    from activity
    where ts >= ${since} ${inRepository(repository)}
    group by 1, 2, 3
    order by 1, 2, 3`;
}

/**
 * A stretch of one person's day with no long silence in it. Minutes are counted
 * from local midnight, so the reader's clock and the axis agree without either
 * side re-deriving a timezone from a timestamp.
 */
export type DaySession = {
  person_id: string;
  day: string;
  started_minute: number;
  ended_minute: number;
  events: number;
};

/**
 * How long a silence has to be before it reads as a break rather than a person
 * thinking. Events are instants — a commit, a merge, a message — so a session is
 * only ever the visible edge of the work: an hour spent reading code produces
 * nothing and looks exactly like lunch. Sixty minutes is the knob to turn when a
 * team's rhythm makes it wrong; it is a parameter, not a constant, for that reason.
 */
export const DEFAULT_BREAK_MINUTES = 60;

/**
 * Each person's day broken into sessions: when they started, when they stopped,
 * and how many events fell in between. Sessions never cross midnight — the
 * calendar day is the unit being asked about, so a night that runs past it is
 * two short days rather than one long session.
 */
/**
 * Every activity as a span in the reader's day: the instant ones start and end at
 * the same minute, and a meeting occupies the real length it ran for. This is the
 * one query that reads `meta.endsAt`, and the reason it exists — a two-hour
 * meeting is two hours of a person's day, not a dot at the hour it started.
 *
 * A span that runs past local midnight is clamped to the end of its own day: the
 * day-shape chart is a 24-hour track, and an evening call that finishes at 00:30
 * belongs to the evening it started in.
 */
export function daySessions(
  since: Date,
  timezone: string,
  repository?: string,
  breakMinutes: number = DEFAULT_BREAK_MINUTES,
) {
  return prisma.$queryRaw<DaySession[]>`
    with local as (
      select person_id,
        ts at time zone ${timezone} as started,
        least(
          coalesce((meta ->> 'endsAt')::timestamptz, ts) at time zone ${timezone},
          date_trunc('day', ts at time zone ${timezone}) + interval '1 day' - interval '1 minute'
        ) as ended,
        (ts at time zone ${timezone})::date as day
      from activity
      where ts >= ${since} ${inRepository(repository)}
    ),
    bounded as (
      select person_id, day, started, ended,
        -- The furthest anything has run to so far today. A new block opens only
        -- when the silence since *everything* before it is long enough, so an
        -- event inside a meeting never splits the meeting in two.
        max(ended) over (
          partition by person_id, day order by started
          rows between unbounded preceding and 1 preceding
        ) as prior_end
      from local
    ),
    sessioned as (
      select person_id, day, started, ended,
        sum(
          case
            when prior_end is null then 0
            when started - prior_end > make_interval(mins => ${breakMinutes}::int) then 1
            else 0
          end
        ) over (partition by person_id, day order by started) as session
      from bounded
    )
    select person_id,
      to_char(sessioned.day, 'YYYY-MM-DD') as day,
      (extract(hour from min(started)) * 60 + extract(minute from min(started)))::int as started_minute,
      (extract(hour from max(ended)) * 60 + extract(minute from max(ended)))::int as ended_minute,
      count(*)::int as events
    from sessioned
    group by person_id, sessioned.day, session
    order by person_id, day, started_minute`;
}

/**
 * One mark per kind of work per minute — what the coloured blocks in the day
 * shape are drawn from. Grouped by minute rather than returned per row so a
 * burst of twenty commits in one minute is one mark carrying a count, not twenty
 * overlapping rectangles.
 *
 * The event `type` is returned raw: which kinds exist and what colour they wear
 * is the presentation layer's business, and it already owns that table.
 */
export type DayMark = {
  person_id: string;
  day: string;
  type: string;
  started_minute: number;
  ended_minute: number;
  n: number;
};

export function dayMarks(since: Date, timezone: string, repository?: string) {
  return prisma.$queryRaw<DayMark[]>`
    with local as (
      select person_id, type,
        ts at time zone ${timezone} as started,
        least(
          coalesce((meta ->> 'endsAt')::timestamptz, ts) at time zone ${timezone},
          date_trunc('day', ts at time zone ${timezone}) + interval '1 day' - interval '1 minute'
        ) as ended
      from activity
      where ts >= ${since} ${inRepository(repository)}
    )
    select person_id,
      to_char(started::date, 'YYYY-MM-DD') as day,
      type,
      (extract(hour from started) * 60 + extract(minute from started))::int as started_minute,
      (extract(hour from ended) * 60 + extract(minute from ended))::int as ended_minute,
      count(*)::int as n
    from local
    group by 1, 2, 3, 4, 5
    order by 1, 2, 4`;
}

export type FeedRow = {
  id: string;
  source: string;
  type: string;
  personId: string;
  workType: string | null;
  ts: Date;
  url: string | null;
  title: string | null;
  body: string | null;
};

/**
 * Raw events, newest first. The one place anything reads individual rows.
 * Raw SQL rather than a Prisma filter so the repository scope is the same
 * `inRepository` every other query uses — two spellings of one rule is how they
 * drift apart.
 */
export function activityFeed(options: {
  personId?: string;
  since: Date;
  limit?: number;
  repository?: string;
}) {
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 500);
  const person = options.personId
    ? Prisma.sql`and person_id = ${options.personId}`
    : Prisma.empty;
  return prisma.$queryRaw<FeedRow[]>`
    select id, source, type, person_id as "personId", work_type as "workType",
           ts, url, title, body
    from activity
    where ts >= ${options.since} ${person} ${inRepository(options.repository)}
    order by ts desc
    limit ${limit}`;
}

export type UnclassifiedItem = {
  id: string;
  person_id: string;
  type: string;
  ts: Date;
  title: string | null;
  body: string | null;
};

/**
 * The null tail: merged pull requests and created issues whose kind of work
 * neither a label nor a title prefix stated, and which every mix therefore
 * reports as unclassified. Restricted to those two event types because they are
 * the only ones a work type moves a ratio for.
 */
export function unclassifiedWork(since: Date, repository?: string) {
  return prisma.$queryRaw<UnclassifiedItem[]>`
    select id, person_id, type, ts, title, body
    from activity
    where work_type is null
      and type in ('pr_merged', 'issue_created')
      and ts >= ${since} ${inRepository(repository)}
    order by ts desc`;
}

/**
 * How much each source actually produced, per person, in the window.
 *
 * This is the answer to "are we really seeing everything they do": a person with
 * a Slack handle and zero Slack rows is either quiet or invisible, and those two
 * look identical in every other chart on the page. It cannot prove coverage —
 * nothing can, from inside — but it makes silence visible instead of letting it
 * pass for calm.
 */
export type SourceCoverage = { person_id: string; source: string; events: number; last_seen: Date | null };

export function coverage(since: Date) {
  return prisma.$queryRaw<SourceCoverage[]>`
    select person_id, source, count(*)::int as events, max(ts) as last_seen
    from activity
    where ts >= ${since}
    group by 1, 2
    order by 1, 2`;
}

/** When each source last ran, whatever it found. A stale source is its own kind of gap. */
export function lastSyncs() {
  return prisma.$queryRaw<{ source: string; last_run: Date }[]>`
    select source, last_run from sync_run order by source`;
}

/**
 * Claude Code usage per person over the window. Daily by nature — the analytics
 * API reports whole days — so this is a total, never a time of day.
 */
export type AiUsage = {
  person_id: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** Minor units, as the API reports it: cents for USD. */
  cost_amount: number;
  currency: string;
  lines_added: number;
  lines_removed: number;
  commits: number;
  pull_requests: number;
  tools_accepted: number;
  tools_rejected: number;
  days_used: number;
};

export function aiUsage(since: Date) {
  return prisma.$queryRaw<AiUsage[]>`
    select person_id,
      sum(sessions)::int                as sessions,
      sum(input_tokens)::int            as input_tokens,
      sum(output_tokens)::int           as output_tokens,
      sum(cache_read_tokens)::int       as cache_read_tokens,
      sum(cache_creation_tokens)::int   as cache_creation_tokens,
      sum(cost_amount)::int             as cost_amount,
      min(currency)                     as currency,
      sum(lines_added)::int             as lines_added,
      sum(lines_removed)::int           as lines_removed,
      sum(commits)::int                 as commits,
      sum(pull_requests)::int           as pull_requests,
      sum(tools_accepted)::int          as tools_accepted,
      sum(tools_rejected)::int          as tools_rejected,
      count(distinct day)::int          as days_used
    from ai_usage
    where day >= ${since}
    group by person_id
    order by person_id`;
}

/** One row per person per day — the Claude Code strip. */
export type AiUsageDay = { person_id: string; day: string; tokens: number; cost_amount: number };

export function aiUsageDaily(since: Date) {
  return prisma.$queryRaw<AiUsageDay[]>`
    select person_id,
      to_char(day, 'YYYY-MM-DD') as day,
      sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens)::int as tokens,
      sum(cost_amount)::int as cost_amount
    from ai_usage
    where day >= ${since}
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
