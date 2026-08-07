import {
  Dialog,
  DialogPanel,
  DialogTitle,
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
  Field,
  Label,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Radio,
  RadioGroup,
  Switch,
} from "@headlessui/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BugRatio, Bucket, PersonStats, ReviewWait, TeamStats } from "../metrics";
import { WORK_WEEK_LABELS, type WorkWeek, isWeekend, weekendDays } from "../workweek";
import {
  ActivityChart, type DailyRow, HOURS_IN_DAY, HoursHeatmap, type HoursRow, Meter, MixBar,
  type MixSegment, type SeriesMember,
} from "./charts";
import { formatHourOfDay, formatHours, formatNumber, formatPercent, formatTimestamp } from "./format";

/* ------------------------------------------------------------------ payloads */

type PersonReference = { id: string; name: string; workWeek: WorkWeek };

type StaleIssue = {
  person_id: string;
  identifier: string;
  title: string;
  url: string;
  age_days: number;
};

type RepositoryOption = { repo: string; events: number };

type TeamPayload = {
  since: string;
  /** The IANA zone the server bucketed the hours in — the browser's own. */
  timezone: string;
  /** Null when the reader has asked for every repository. */
  repository: string | null;
  /** github.mainRepo from people.yaml — what the page opens on. */
  mainRepository: string | null;
  repositories: RepositoryOption[];
  people: PersonReference[];
  team: TeamStats;
  stats: PersonStats[];
  waits: ReviewWait[];
  days: { person_id: string; day: string; n: number }[];
  hours: { person_id: string; day_of_week: number; hour: number; n: number }[];
  ship: Bucket[];
  intake: Bucket[];
  bugs: BugRatio;
  stale: StaleIssue[];
};

type TimelineEntry = {
  id: string;
  source: string;
  type: string;
  ts: string;
  url: string | null;
  title: string | null;
  body: string | null;
};

type PersonPayload = {
  person: PersonReference;
  stats: PersonStats | null;
  wait: ReviewWait | null;
  feed: TimelineEntry[];
};

/* -------------------------------------------------------------------- colour */

/**
 * Categorical slots in the fixed order the palette was validated in. A person
 * keeps the slot their position in people.yaml gives them, so narrowing the
 * window never repaints anybody. Past the eighth person the tail folds into a
 * neutral "Other" rather than generating a ninth hue.
 */
const CATEGORICAL_SLOTS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
  "var(--series-8)",
];

const OTHER_SERIES_ID = "__other";

const WORK_TYPE_ORDER: { key: string; label: string; color: string }[] = [
  { key: "unclassified", label: "Unclassified", color: "var(--series-none)" },
  { key: "feature", label: "Feature", color: "var(--series-1)" },
  { key: "bug", label: "Bug", color: "var(--series-2)" },
  { key: "improvement", label: "Improvement", color: "var(--series-3)" },
  { key: "chore", label: "Chore", color: "var(--series-4)" },
];

function assignSeries(people: PersonReference[]): SeriesMember[] {
  const members: SeriesMember[] = people
    .slice(0, CATEGORICAL_SLOTS.length)
    .map((person, index) => ({ id: person.id, name: person.name, color: CATEGORICAL_SLOTS[index]! }));

  if (people.length > CATEGORICAL_SLOTS.length) {
    members.push({ id: OTHER_SERIES_ID, name: "Other", color: "var(--series-none)" });
  }
  return members;
}

function toMixSegments(buckets: Bucket[]): MixSegment[] {
  const counts = new Map(buckets.map((bucket) => [bucket.bucket, bucket.n]));
  return WORK_TYPE_ORDER.map((workType) => ({
    key: workType.key,
    label: workType.label,
    color: workType.color,
    count: counts.get(workType.key) ?? 0,
  }));
}

/* ---------------------------------------------------------------------- data */

const DAY_IN_MILLISECONDS = 86_400_000;

/**
 * Which work weeks feed each series. A series is usually one person, but the
 * folded "Other" bucket can hold several, and they need not share a weekend.
 */
function workWeeksBySeries(people: PersonReference[]): Map<string, WorkWeek[]> {
  const bySeries = new Map<string, WorkWeek[]>();

  people.forEach((person, index) => {
    const seriesId = index < CATEGORICAL_SLOTS.length ? person.id : OTHER_SERIES_ID;
    const workWeeks = bySeries.get(seriesId) ?? [];
    workWeeks.push(person.workWeek);
    bySeries.set(seriesId, workWeeks);
  });

  return bySeries;
}

/**
 * One row per calendar day across the whole window, including days nobody
 * touched — a missing day should read as a gap, not close up the axis.
 *
 * With `hideWeekends` on, a day is dropped from a person's series when it is a
 * weekend under *their* work week, and dropped from the axis only when it is a
 * weekend for everybody. A Friday off in Tel Aviv is a working day elsewhere.
 */
function buildDailyRows(
  sinceIso: string,
  days: TeamPayload["days"],
  series: SeriesMember[],
  people: PersonReference[],
  hideWeekends: boolean,
): DailyRow[] {
  const knownSeriesIds = new Set(series.map((member) => member.id));
  const countsByDate = new Map<string, Record<string, number>>();

  for (const entry of days) {
    const date = entry.day.slice(0, 10);
    const seriesId = knownSeriesIds.has(entry.person_id) ? entry.person_id : OTHER_SERIES_ID;
    const row = countsByDate.get(date) ?? {};
    row[seriesId] = (row[seriesId] ?? 0) + entry.n;
    countsByDate.set(date, row);
  }

  const workWeeks = workWeeksBySeries(people);
  const isRestDay = (date: string, seriesId: string): boolean => {
    if (!hideWeekends) return false;
    const seriesWorkWeeks = workWeeks.get(seriesId);
    if (!seriesWorkWeeks?.length) return false;
    return seriesWorkWeeks.every((workWeek) => isWeekend(date, workWeek));
  };

  const firstDay = Date.parse(`${sinceIso.slice(0, 10)}T00:00:00Z`);
  const lastDay = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const rows: DailyRow[] = [];

  for (let time = firstDay; time <= lastDay; time += DAY_IN_MILLISECONDS) {
    const date = new Date(time).toISOString().slice(0, 10);
    if (series.length && series.every((member) => isRestDay(date, member.id))) continue;

    const counts = countsByDate.get(date) ?? {};
    const row: DailyRow = { date, topSeriesId: "" };

    for (const member of series) {
      row[member.id] = isRestDay(date, member.id) ? 0 : (counts[member.id] ?? 0);
    }

    // The topmost stacked segment keeps square corners off the baseline and the
    // 4px rounded cap; everything below it gives up 2px to the surface gap.
    for (const member of series) if (Number(row[member.id]) > 0) row.topSeriesId = member.id;

    rows.push(row);
  }

  return rows;
}

/**
 * One row per person, always all 24 hours — an hour nobody worked is a cell that
 * reads as empty, not a column that disappears.
 *
 * With `hideWeekends` on, a person's weekend days drop out of *their* row under
 * their own work week, the same rule the activity strip applies. Everybody is
 * listed, including people with nothing in the window: an empty row is the
 * honest answer, and folding them away would hide it.
 */
function buildHourRows(
  hours: TeamPayload["hours"],
  people: PersonReference[],
  hideWeekends: boolean,
): HoursRow[] {
  const countsByPerson = new Map<string, number[]>(
    people.map((person) => [person.id, Array.from({ length: HOURS_IN_DAY }, () => 0)]),
  );
  const restDaysByPerson = new Map(
    people.map((person) => [person.id, new Set(weekendDays(person.workWeek))]),
  );

  for (const entry of hours) {
    const counts = countsByPerson.get(entry.person_id);
    if (!counts) continue; // Somebody who left people.yaml but kept their history.
    if (hideWeekends && restDaysByPerson.get(entry.person_id)?.has(entry.day_of_week)) continue;
    counts[entry.hour] = (counts[entry.hour] ?? 0) + entry.n;
  }

  return people.map((person) => ({
    id: person.id,
    name: person.name,
    hours: countsByPerson.get(person.id) ?? Array.from({ length: HOURS_IN_DAY }, () => 0),
  }));
}

function useJson<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [pending, setPending] = useState(url !== null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (url === null) return;
    let cancelled = false;
    setPending(true);

    fetch(url)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error ?? response.statusText);
        return payload as T;
      })
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  // `data` is deliberately kept across a refetch so charts hold their frame.
  return { data, pending, error };
}

/* ---------------------------------------------------------------- primitives */

function Card({
  title,
  description,
  children,
  tableView,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  tableView?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-hairline bg-surface p-5">
      <h2 className="text-sm font-semibold text-ink-primary">{title}</h2>
      {description ? <p className="mt-0.5 text-xs text-ink-muted">{description}</p> : null}
      <div className="mt-4">{children}</div>

      {tableView ? (
        <Disclosure>
          <DisclosureButton className="mt-4 cursor-pointer text-xs text-ink-secondary underline decoration-hairline underline-offset-4 hover:text-ink-primary data-[focus]:outline-2 data-[focus]:outline-offset-2 data-[focus]:outline-[var(--series-1)]">
            Table view
          </DisclosureButton>
          <DisclosurePanel className="mt-3 max-h-80 overflow-auto rounded-lg border border-hairline">
            {tableView}
          </DisclosurePanel>
        </Disclosure>
      ) : null}
    </section>
  );
}

function StatTile({
  label,
  value,
  caption,
}: {
  label: string;
  value: ReactNode;
  caption?: string;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <div className="text-xs text-ink-secondary">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink-primary">{value}</div>
      {caption ? <div className="mt-1 text-xs text-ink-muted">{caption}</div> : null}
    </div>
  );
}

/** The one number the dashboard leads with. Exactly one per view. */
function HeroFigure({ label, value, caption }: { label: string; value: string; caption: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-6">
      <div className="text-xs text-ink-secondary">{label}</div>
      <div className="mt-1 text-6xl leading-none font-semibold text-ink-primary">{value}</div>
      <div className="mt-2 text-xs text-ink-muted">{caption}</div>
    </div>
  );
}

/* ------------------------------------------------------------------- filters */

const RANGES = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

function RangeFilter({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <RadioGroup
      value={value}
      onChange={onChange}
      aria-label="Date range"
      className="flex flex-wrap gap-1 rounded-full border border-hairline bg-surface p-1"
    >
      {RANGES.map((range) => (
        <Radio
          key={range.value}
          value={range.value}
          className="cursor-pointer rounded-full px-3 py-1.5 text-sm text-ink-secondary select-none hover:text-ink-primary data-[checked]:bg-[var(--series-1)] data-[checked]:text-white data-[focus]:outline-2 data-[focus]:outline-offset-2 data-[focus]:outline-[var(--series-1)]"
        >
          {range.label}
        </Radio>
      ))}
    </RadioGroup>
  );
}

const ALL_REPOSITORIES = "";

function RepositoryFilter({
  value,
  options,
  onChange,
}: {
  value: string;
  options: RepositoryOption[];
  onChange: (next: string) => void;
}) {
  // The selected repository stays listed even when the current window has no
  // events from it, so the control never silently drops the reader's choice.
  const listed = options.some((option) => option.repo === value);
  const choices = [
    { repo: ALL_REPOSITORIES, events: 0 },
    ...(value && !listed ? [{ repo: value, events: 0 }] : []),
    ...options,
  ];
  const labelOf = (repo: string) => (repo === ALL_REPOSITORIES ? "All repositories" : repo);

  return (
    <Listbox value={value} onChange={onChange}>
      <div className="relative">
        <ListboxButton className="cursor-pointer rounded-full border border-hairline bg-surface px-4 py-2 text-sm text-ink-primary hover:border-[var(--series-1)] data-[focus]:outline-2 data-[focus]:outline-offset-2 data-[focus]:outline-[var(--series-1)]">
          {labelOf(value)}
        </ListboxButton>
        <ListboxOptions
          anchor="bottom end"
          className="z-50 mt-1 max-h-80 w-72 overflow-auto rounded-xl border border-hairline bg-surface p-1 shadow-lg [--anchor-gap:4px]"
        >
          {choices.map((choice) => (
            <ListboxOption
              key={choice.repo || "all"}
              value={choice.repo}
              className="flex cursor-pointer items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-sm text-ink-secondary select-none data-[focus]:bg-[var(--gridline)] data-[selected]:font-semibold data-[selected]:text-ink-primary"
            >
              <span className="truncate">{labelOf(choice.repo)}</span>
              {choice.events ? (
                <span className="shrink-0 text-xs tabular-nums text-ink-muted">
                  {formatNumber(choice.events)}
                </span>
              ) : null}
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}

function WeekendToggle({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <Field className="flex items-center gap-2">
      <Switch
        checked={checked}
        onChange={onChange}
        className="group relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border border-hairline bg-surface p-0.5 transition-colors data-[checked]:bg-[var(--series-1)] data-[focus]:outline-2 data-[focus]:outline-offset-2 data-[focus]:outline-[var(--series-1)]"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none inline-block h-4.5 w-4.5 translate-x-0 rounded-full bg-[var(--ink-muted)] transition-transform group-data-[checked]:translate-x-5 group-data-[checked]:bg-white"
        />
      </Switch>
      <Label className="cursor-pointer text-sm text-ink-secondary select-none">Hide weekends</Label>
    </Field>
  );
}

/* ---------------------------------------------------------------------- sync */

type SyncResult = { label: string; collected: number; saved: number; error: string | null };

/**
 * The UI is the only controller, so pulling the sources lives here. The request
 * is held open for the whole pull, which can run for a minute on a wide window.
 */
function SyncButton({ range, onFinished }: { range: string; onFinished: () => void }) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SyncResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runSync() {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(`/api/sync?since=${encodeURIComponent(range)}`, {
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? response.statusText);
      setResults(payload.results as SyncResult[]);
      onFinished();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={runSync}
        disabled={running}
        className="cursor-pointer rounded-full border border-hairline bg-surface px-4 py-2 text-sm text-ink-primary hover:border-[var(--series-1)] disabled:cursor-progress disabled:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]"
      >
        {running ? "Syncing…" : "Sync now"}
      </button>

      {error ? <p className="text-xs text-critical">{error}</p> : null}

      {results ? (
        <ul className="text-xs text-ink-muted">
          {results.map((result) => (
            <li key={result.label} className={result.error ? "text-critical" : undefined}>
              {result.error
                ? `${result.label}: ${result.error}`
                : `${result.label}: ${formatNumber(result.collected)} events, ${formatNumber(result.saved)} new`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- tables */

function ActivityTableView({ rows, series }: { rows: DailyRow[]; series: SeriesMember[] }) {
  return (
    <table className="w-full text-left text-xs tabular-nums">
      <thead className="sticky top-0 bg-surface text-ink-secondary">
        <tr className="border-b border-hairline">
          <th className="px-3 py-2 font-medium">Day</th>
          {series.map((member) => (
            <th key={member.id} className="px-3 py-2 text-right font-medium">
              {member.name}
            </th>
          ))}
          <th className="px-3 py-2 text-right font-medium">Total</th>
        </tr>
      </thead>
      <tbody className="text-ink-primary">
        {rows.map((row) => {
          const total = series.reduce((sum, member) => sum + Number(row[member.id] ?? 0), 0);
          return (
            <tr key={row.date} className="border-b border-hairline last:border-0">
              <td className="px-3 py-1.5 text-ink-secondary">{row.date}</td>
              {series.map((member) => (
                <td key={member.id} className="px-3 py-1.5 text-right">
                  {formatNumber(Number(row[member.id] ?? 0))}
                </td>
              ))}
              <td className="px-3 py-1.5 text-right font-semibold">{formatNumber(total)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function HoursTableView({ rows }: { rows: HoursRow[] }) {
  return (
    <table className="w-full text-left text-xs tabular-nums">
      <thead className="sticky top-0 bg-surface text-ink-secondary">
        <tr className="border-b border-hairline">
          <th className="px-3 py-2 font-medium">Person</th>
          {Array.from({ length: HOURS_IN_DAY }, (_, hour) => (
            <th key={hour} className="px-2 py-2 text-right font-medium">
              {formatHourOfDay(hour).slice(0, 2)}
            </th>
          ))}
          <th className="px-3 py-2 text-right font-medium">Total</th>
        </tr>
      </thead>
      <tbody className="text-ink-primary">
        {rows.map((row) => (
          <tr key={row.id} className="border-b border-hairline last:border-0">
            <td className="px-3 py-1.5 text-ink-secondary">{row.name}</td>
            {row.hours.map((count, hour) => (
              <td key={hour} className={`px-2 py-1.5 text-right ${count ? "" : "text-ink-muted"}`}>
                {formatNumber(count)}
              </td>
            ))}
            <td className="px-3 py-1.5 text-right font-semibold">
              {formatNumber(row.hours.reduce((sum, count) => sum + count, 0))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PeopleTable({
  people,
  series,
  stats,
  waits,
  onSelect,
}: {
  people: PersonReference[];
  series: SeriesMember[];
  stats: PersonStats[];
  waits: ReviewWait[];
  onSelect: (personId: string) => void;
}) {
  const statsByPerson = new Map(stats.map((row) => [row.person_id, row]));
  const waitsByPerson = new Map(waits.map((row) => [row.person_id, row]));
  const colorByPerson = new Map(series.map((member) => [member.id, member.color]));

  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs text-ink-secondary">
        <tr className="border-b border-hairline">
          <th className="py-2 pr-3 font-medium">Person</th>
          <th className="px-3 py-2 text-right font-medium">Merged</th>
          <th className="px-3 py-2 text-right font-medium">Opened</th>
          <th className="px-3 py-2 text-right font-medium">Commits</th>
          <th className="px-3 py-2 text-right font-medium">Reviews</th>
          <th className="px-3 py-2 text-right font-medium">Completed</th>
          <th className="px-3 py-2 text-right font-medium">Messages</th>
          <th className="px-3 py-2 text-right font-medium">Active days</th>
          <th className="py-2 pl-3 text-right font-medium">Review wait</th>
        </tr>
      </thead>
      <tbody className="tabular-nums text-ink-primary">
        {people.map((person) => {
          const personStats = statsByPerson.get(person.id);
          const personWait = waitsByPerson.get(person.id);
          return (
            <tr key={person.id} className="border-b border-hairline last:border-0">
              <td className="py-2 pr-3">
                <button
                  type="button"
                  onClick={() => onSelect(person.id)}
                  className="flex cursor-pointer items-center gap-2 rounded text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ background: colorByPerson.get(person.id) ?? "var(--series-none)" }}
                  />
                  {person.name}
                </button>
              </td>
              <td className="px-3 py-2 text-right">{formatNumber(personStats?.prs_merged ?? 0)}</td>
              <td className="px-3 py-2 text-right text-ink-secondary">
                {formatNumber(personStats?.prs_opened ?? 0)}
              </td>
              <td className="px-3 py-2 text-right">
                {formatNumber(personStats?.commits_pushed ?? 0)}
              </td>
              <td className="px-3 py-2 text-right">{formatNumber(personStats?.reviews ?? 0)}</td>
              <td className="px-3 py-2 text-right">
                {formatNumber(personStats?.issues_completed ?? 0)}
              </td>
              <td className="px-3 py-2 text-right">{formatNumber(personStats?.messages ?? 0)}</td>
              <td className="px-3 py-2 text-right">{formatNumber(personStats?.active_days ?? 0)}</td>
              <td className="py-2 pl-3 text-right">{formatHours(personWait?.median_hours)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const STALE_ISSUES_SHOWN = 15;

function StaleIssuesTable({ issues }: { issues: StaleIssue[] }) {
  // Oldest first, capped: a list of ninety is a wall, not a signal. The count of
  // what was left out is printed rather than silently dropped.
  const shown = issues.slice(0, STALE_ISSUES_SHOWN);
  const hidden = issues.length - shown.length;

  return (
    <>
    <table className="w-full text-left text-sm">
      <thead className="text-xs text-ink-secondary">
        <tr className="border-b border-hairline">
          <th className="py-2 pr-3 font-medium">Person</th>
          <th className="px-3 py-2 font-medium">Issue</th>
          <th className="py-2 pl-3 text-right font-medium">Untouched</th>
        </tr>
      </thead>
      <tbody className="text-ink-primary">
        {shown.map((issue) => (
          <tr key={issue.identifier} className="border-b border-hairline last:border-0">
            <td className="py-2 pr-3 text-ink-secondary">{issue.person_id}</td>
            <td className="px-3 py-2">
              <a
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                className="hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]"
              >
                <span className="text-ink-secondary tabular-nums">{issue.identifier}</span>{" "}
                {issue.title}
              </a>
            </td>
            <td className="py-2 pl-3 text-right tabular-nums">{issue.age_days}d</td>
          </tr>
        ))}
      </tbody>
    </table>
    {hidden > 0 ? (
      <p className="mt-3 text-xs text-ink-muted">
        {formatNumber(hidden)} more not shown.
      </p>
    ) : null}
    </>
  );
}

/* -------------------------------------------------------------- person panel */

function PersonDialog({
  personId,
  range,
  repository,
  onClose,
}: {
  personId: string | null;
  range: string;
  /** Null while no preference has been expressed; the server then applies its default. */
  repository: string | null;
  onClose: () => void;
}) {
  const url = personId
    ? `/api/person/${encodeURIComponent(personId)}?since=${encodeURIComponent(range)}` +
      (repository === null ? "" : `&repo=${encodeURIComponent(repository)}`)
    : null;
  const { data, pending, error } = useJson<PersonPayload>(url);
  const shown = personId ? data : null;

  return (
    <Dialog open={personId !== null} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 flex justify-end">
        <DialogPanel className="h-full w-full max-w-xl overflow-y-auto border-l border-hairline bg-surface p-6">
          <div className="flex items-start justify-between gap-4">
            <DialogTitle className="text-lg font-semibold text-ink-primary">
              {shown?.person.name ?? "Loading…"}
            </DialogTitle>
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded px-2 py-1 text-sm text-ink-secondary hover:text-ink-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]"
            >
              Close
            </button>
          </div>

          {error ? <p className="mt-6 text-sm text-critical">{error}</p> : null}

          {shown ? (
            <div className={pending ? "opacity-60" : undefined}>
              <dl className="mt-6 grid grid-cols-2 gap-3">
                {[
                  ["PRs merged", formatNumber(shown.stats?.prs_merged ?? 0)],
                  ["PRs opened", formatNumber(shown.stats?.prs_opened ?? 0)],
                  ["Commits pushed", formatNumber(shown.stats?.commits_pushed ?? 0)],
                  ["Reviews given", formatNumber(shown.stats?.reviews ?? 0)],
                  ["Issues completed", formatNumber(shown.stats?.issues_completed ?? 0)],
                  ["Issues created", formatNumber(shown.stats?.issues_created ?? 0)],
                  ["Messages", formatNumber(shown.stats?.messages ?? 0)],
                  ["Asks from you", formatNumber(shown.stats?.directives ?? 0)],
                  ["Active days", formatNumber(shown.stats?.active_days ?? 0)],
                  ["Median review wait", formatHours(shown.wait?.median_hours)],
                  ["Never reviewed", formatNumber(shown.wait?.unreviewed ?? 0)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-hairline p-3">
                    <dt className="text-xs text-ink-secondary">{label}</dt>
                    <dd className="mt-0.5 text-lg font-semibold text-ink-primary">{value}</dd>
                  </div>
                ))}
              </dl>

              <h3 className="mt-8 text-sm font-semibold text-ink-primary">Timeline</h3>
              <ul className="mt-3 space-y-2">
                {shown.feed.map((entry) => (
                  <li key={entry.id} className="border-b border-hairline pb-2 last:border-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-muted">
                      <span className="tabular-nums">{formatTimestamp(entry.ts)}</span>
                      <span>{entry.source}</span>
                      <span>{entry.type}</span>
                    </div>
                    <div className="mt-0.5 text-sm text-ink-primary">
                      {entry.url ? (
                        <a
                          href={entry.url}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--series-1)]"
                        >
                          {entry.title ?? entry.body ?? entry.type}
                        </a>
                      ) : (
                        (entry.title ?? entry.body ?? entry.type)
                      )}
                    </div>
                  </li>
                ))}
                {shown.feed.length === 0 ? (
                  <li className="text-sm text-ink-muted">Nothing in this window.</li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </DialogPanel>
      </div>
    </Dialog>
  );
}

/* ----------------------------------------------------------------------- app */

function App() {
  const [range, setRange] = useState("30d");
  const [hideWeekends, setHideWeekends] = useState(true);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Null means "no preference yet", so the server applies github.mainRepo and
  // tells us what it picked. Once the reader chooses, the parameter is always
  // sent — an empty string being the explicit "all repositories".
  const [repository, setRepository] = useState<string | null>(null);
  const repositoryParameter =
    repository === null ? "" : `&repo=${encodeURIComponent(repository)}`;

  // The heat map's hours are bucketed in the reader's own zone, so the browser
  // says which one that is — the database stores UTC and knows nothing about it.
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // `reload` is ignored by the server and only exists to re-key the fetch after
  // a sync writes new rows.
  const { data, pending, error } = useJson<TeamPayload>(
    `/api/team?since=${encodeURIComponent(range)}${repositoryParameter}` +
      `&tz=${encodeURIComponent(timezone)}&reload=${reloadToken}`,
  );

  const activeRepository = repository ?? data?.repository ?? ALL_REPOSITORIES;

  const series = useMemo(() => (data ? assignSeries(data.people) : []), [data]);
  const dailyRows = useMemo(
    () => (data ? buildDailyRows(data.since, data.days, series, data.people, hideWeekends) : []),
    [data, series, hideWeekends],
  );
  const hourRows = useMemo(
    () => (data ? buildHourRows(data.hours, data.people, hideWeekends) : []),
    [data, hideWeekends],
  );

  // Name the calendars in play, so "weekend" is never left to the reader to guess.
  const workWeeksInUse = data
    ? [...new Set(data.people.map((person) => person.workWeek))]
        .map((workWeek) => WORK_WEEK_LABELS[workWeek])
        .join(" · ")
    : "";

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">teampulse</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            {data ? `${data.since.slice(0, 10)} → today` : "Loading…"}
          </p>
          {data?.repository ? (
            <p className="mt-1 max-w-prose text-xs text-ink-muted">
              GitHub activity scoped to {data.repository}. Linear issues and Slack messages
              happen in no repository, so they are counted under every one.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-start gap-4">
          <WeekendToggle checked={hideWeekends} onChange={setHideWeekends} />
          <RepositoryFilter
            value={activeRepository}
            options={data?.repositories ?? []}
            onChange={setRepository}
          />
          <RangeFilter value={range} onChange={setRange} />
          <SyncButton range={range} onFinished={() => setReloadToken((token) => token + 1)} />
        </div>
      </header>

      {error ? (
        <p className="mt-10 rounded-xl border border-hairline bg-surface p-5 text-sm text-critical">
          {error}
        </p>
      ) : null}

      {data ? (
        <main className={`mt-8 space-y-6 ${pending ? "opacity-60" : ""}`}>
          <div className="grid gap-4 md:grid-cols-3">
            <HeroFigure
              label="PRs merged"
              value={formatNumber(data.team.prs_merged)}
              caption={`${formatNumber(data.team.prs_opened)} opened · ${formatNumber(data.team.people_active)} people active`}
            />
            <div className="grid gap-4 sm:grid-cols-2 md:col-span-2">
              <StatTile
                label="Commits pushed"
                value={formatNumber(data.team.commits_pushed)}
                caption="landed outside any pull request"
              />
              <StatTile label="Reviews given" value={formatNumber(data.team.reviews)} />
              <StatTile
                label="Median review wait"
                value={formatHours(data.team.median_review_hours)}
                caption="PR opened → first review"
              />
              <StatTile
                label="Issues completed"
                value={formatNumber(data.team.issues_completed)}
                caption={`${formatNumber(data.team.issues_created)} created`}
              />
              <StatTile label="Messages" value={formatNumber(data.team.messages)} />
            </div>
          </div>

          <Card
            title="Activity"
            description={
              hideWeekends
                ? `Events per day, stacked by person, weekends hidden per person. ${workWeeksInUse}`
                : "Events per day, stacked by person. Every source counted together."
            }
            tableView={<ActivityTableView rows={dailyRows} series={series} />}
          >
            <ActivityChart series={series} rows={dailyRows} />
          </Card>

          <Card
            title="Work hours"
            description={
              `When each person is active, by hour of the day in ${data.timezone}. ` +
              "Each row is shaded against that person's own busiest hour, so the grid shows " +
              "the shape of their day rather than how much they did." +
              (hideWeekends ? " Weekend days are excluded, per person." : "")
            }
            tableView={<HoursTableView rows={hourRows} />}
          >
            <HoursHeatmap rows={hourRows} />
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            <Card title="Shipped" description="Merged pull requests by kind of work.">
              <MixBar
                segments={toMixSegments(data.ship)}
                emptyMessage="No pull requests merged in this window."
              />
            </Card>
            <Card title="Intake" description="Linear issues created by kind of work.">
              <MixBar
                segments={toMixSegments(data.intake)}
                emptyMessage="No issues created in this window."
              />
            </Card>
          </div>

          <Card
            title="Delivery quality"
            description="Bugs reported against what shipped. Rising means quality is outrunning delivery."
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <StatTile label="Bugs reported" value={formatNumber(data.bugs.bugs_reported)} />
              <StatTile
                label="Bugs per delivery"
                value={data.bugs.bugs_per_delivery?.toFixed(2) ?? "—"}
                caption={`over ${formatNumber(data.bugs.shipped)} merged PRs`}
              />
              <StatTile
                label="Fix share of shipped"
                value={formatPercent(data.bugs.fix_share)}
                caption={`${formatNumber(data.bugs.bug_fixes_shipped)} of ${formatNumber(data.bugs.shipped)}`}
              />
            </div>
            <div className="mt-5">
              <Meter
                value={data.bugs.fix_share}
                caption={`${formatPercent(data.bugs.fix_share)} of merged pull requests were fixes rather than new work.`}
              />
            </div>
          </Card>

          <Card title="People" description="Select a person for their stats and timeline.">
            <PeopleTable
              people={data.people}
              series={series}
              stats={data.stats}
              waits={data.waits}
              onSelect={setSelectedPersonId}
            />
          </Card>

          {data.stale.length ? (
            <Card
              title="Stale"
              description={`Open assignments untouched for 14 days or more. ${formatNumber(data.stale.length)} in total, oldest first.`}
            >
              <StaleIssuesTable issues={data.stale} />
            </Card>
          ) : null}
        </main>
      ) : null}

      <PersonDialog
        personId={selectedPersonId}
        range={range}
        repository={repository}
        onClose={() => setSelectedPersonId(null)}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
