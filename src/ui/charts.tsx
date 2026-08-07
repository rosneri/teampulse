import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  formatDayLabel, formatDayTick, formatDuration, formatHourOfDay, formatMinuteOfDay,
  formatNumber, formatPercent,
} from "./format";

/**
 * Every colour below is a CSS custom property from index.css, so light and dark
 * resolve from one definition. The categorical slots are assigned in fixed order
 * and follow the entity, never its rank — filtering never repaints a survivor.
 */

export type SeriesMember = { id: string; name: string; color: string };

/** One calendar day, one count per series, plus which series sits on top. */
export type DailyRow = {
  date: string;
  topSeriesId: string;
  [seriesId: string]: string | number;
};

const SEGMENT_GAP = 2;
const CORNER_RADIUS = 4;
const MAXIMUM_BAR_WIDTH = 24;

function roundedTopPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string {
  if (radius <= 0) return `M${x},${y} h${width} v${height} h${-width} Z`;
  return [
    `M${x},${y + height}`,
    `L${x},${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `L${x + width - radius},${y}`,
    `Q${x + width},${y} ${x + width},${y + radius}`,
    `L${x + width},${y + height}`,
    "Z",
  ].join(" ");
}

/** The subset of the shape properties Recharts hands a custom bar renderer. */
type SegmentShapeProperties = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  payload?: DailyRow;
};

/**
 * A stacked segment. The 2px separator between segments is a gap in the surface,
 * not a stroke around the mark, so only segments with something stacked above
 * them give up height — the bar still reads its true total.
 */
function stackedSegment(seriesId: string) {
  return function StackedSegment(properties: SegmentShapeProperties) {
    const { x, y, width, height, fill, payload } = properties;
    if (x === undefined || y === undefined || !width || !height || height <= 0) return null;

    const isTopSegment = payload?.topSeriesId === seriesId;
    const drawnTop = isTopSegment ? y : y + SEGMENT_GAP;
    const drawnHeight = isTopSegment ? height : Math.max(1, height - SEGMENT_GAP);
    const radius = isTopSegment ? Math.min(CORNER_RADIUS, width / 2, drawnHeight) : 0;

    return <path d={roundedTopPath(x, drawnTop, width, drawnHeight, radius)} fill={fill} />;
  };
}

function ActivityTooltip({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean;
  payload?: { payload: DailyRow }[];
  label?: string;
  series?: SeriesMember[];
}) {
  if (!active || !payload?.length || !series) return null;
  const row = payload[0]!.payload;
  const total = series.reduce((sum, member) => sum + Number(row[member.id] ?? 0), 0);

  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-2 shadow-lg">
      <div className="mb-2 text-xs text-ink-muted tabular-nums">{label}</div>
      <div className="space-y-1">
        {series.map((member) => (
          <div key={member.id} className="flex items-baseline gap-2 text-sm">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-3 shrink-0 rounded-full"
              style={{ background: member.color }}
            />
            <span className="font-semibold tabular-nums text-ink-primary">
              {formatNumber(Number(row[member.id] ?? 0))}
            </span>
            <span className="text-ink-secondary">{member.name}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 border-t border-hairline pt-1.5 text-xs text-ink-secondary">
        <span className="font-semibold tabular-nums text-ink-primary">{formatNumber(total)}</span>{" "}
        events that day
      </div>
    </div>
  );
}

export function SeriesLegend({ series }: { series: SeriesMember[] }) {
  if (series.length < 2) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
      {series.map((member) => (
        <span key={member.id} className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: member.color }}
          />
          {member.name}
        </span>
      ))}
    </div>
  );
}

export function ActivityChart({ series, rows }: { series: SeriesMember[]; rows: DailyRow[] }) {
  const hasAnyActivity = rows.some((row) =>
    series.some((member) => Number(row[member.id] ?? 0) > 0),
  );

  if (!hasAnyActivity) {
    return <p className="py-12 text-center text-sm text-ink-muted">No activity in this window.</p>;
  }

  return (
    <>
      {/* Height covers the plot and the axis band, so the card never grows an inner scrollbar. */}
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={0}>
            <CartesianGrid vertical={false} stroke="var(--gridline)" strokeWidth={1} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDayTick}
              tickLine={false}
              axisLine={{ stroke: "var(--axis)" }}
              tick={{ fill: "var(--ink-muted)", fontSize: 11 }}
              minTickGap={28}
            />
            <YAxis
              allowDecimals={false}
              width={34}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--ink-muted)", fontSize: 11 }}
            />
            <Tooltip
              cursor={{ fill: "var(--gridline)", fillOpacity: 0.5 }}
              content={<ActivityTooltip series={series} />}
            />
            {series.map((member) => (
              <Bar
                key={member.id}
                dataKey={member.id}
                name={member.name}
                stackId="activity"
                fill={member.color}
                maxBarSize={MAXIMUM_BAR_WIDTH}
                shape={stackedSegment(member.id)}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <SeriesLegend series={series} />
    </>
  );
}

export type MixSegment = { key: string; label: string; count: number; color: string };

/**
 * Part-to-whole in one horizontal stacked bar. Every value is printed in the row
 * beneath it, so nothing is reachable only by hovering — which is also the
 * relief the light-mode aqua and yellow slots require, both sitting below 3:1
 * against the chart surface.
 */
export function MixBar({ segments, emptyMessage }: { segments: MixSegment[]; emptyMessage: string }) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);

  if (!total) return <p className="py-8 text-center text-sm text-ink-muted">{emptyMessage}</p>;

  const present = segments.filter((segment) => segment.count > 0);

  return (
    <div>
      <div className="flex h-10 w-full gap-0.5 overflow-hidden">
        {present.map((segment, index) => (
          <div
            key={segment.key}
            title={`${segment.label}: ${formatNumber(segment.count)} (${formatPercent(segment.count / total)})`}
            className={[
              "h-full min-w-0.5 transition-opacity hover:opacity-80",
              index === 0 ? "rounded-l" : "",
              index === present.length - 1 ? "rounded-r" : "",
            ].join(" ")}
            style={{ background: segment.color, width: `${(segment.count / total) * 100}%` }}
          />
        ))}
      </div>

      <dl className="mt-4 grid grid-cols-[auto_1fr_auto_auto] items-baseline gap-x-3 gap-y-2">
        {present.map((segment) => (
          <div key={segment.key} className="col-span-4 grid grid-cols-subgrid items-baseline">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: segment.color }}
            />
            <dt className="text-sm text-ink-secondary">{segment.label}</dt>
            <dd className="text-sm font-semibold tabular-nums text-ink-primary">
              {formatNumber(segment.count)}
            </dd>
            <dd className="text-sm tabular-nums text-ink-muted">
              {formatPercent(segment.count / total)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export const HOURS_IN_DAY = 24;

/** One person's day: 24 event counts, midnight first, in the reader's timezone. */
export type HoursRow = { id: string; name: string; hours: number[] };

/** Sequential blue, one hue, five steps. An hour with nothing in it is the gridline,
 *  never the palest step — "no events" and "one event" must not look alike. */
const HEAT_STEPS = ["var(--heat-1)", "var(--heat-2)", "var(--heat-3)", "var(--heat-4)", "var(--heat-5)"];

const AXIS_TICK_EVERY = 3;

function heatFill(count: number, peak: number): string {
  if (count <= 0 || peak <= 0) return "var(--gridline)";
  const step = Math.ceil((count / peak) * HEAT_STEPS.length);
  return HEAT_STEPS[Math.min(step, HEAT_STEPS.length) - 1] ?? "var(--gridline)";
}

const hourColumns = { gridTemplateColumns: `repeat(${HOURS_IN_DAY}, minmax(0, 1fr))` };

function HeatLegend() {
  return (
    <div className="mt-4 flex items-center gap-2 text-xs text-ink-secondary">
      <span>Quiet</span>
      <span className="flex gap-0.5" aria-hidden="true">
        <span className="inline-block h-3 w-3 rounded-[2px]" style={{ background: "var(--gridline)" }} />
        {HEAT_STEPS.map((step) => (
          <span key={step} className="inline-block h-3 w-3 rounded-[2px]" style={{ background: step }} />
        ))}
      </span>
      <span>Busiest hour</span>
    </div>
  );
}

/**
 * When each person works, one row per person, one cell per hour of the day.
 *
 * Every row is shaded against its own busiest hour rather than the team's, so
 * the grid reads as the *shape* of a person's day — a light week does not fade
 * somebody out, and a heavy one does not black them in. Volume is the People
 * table's job; this chart answers "when", not "how much".
 */
export function HoursHeatmap({ rows }: { rows: HoursRow[] }) {
  if (!rows.some((row) => row.hours.some((count) => count > 0))) {
    return <p className="py-12 text-center text-sm text-ink-muted">No activity in this window.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-xl">
        {rows.map((row) => {
          const peak = Math.max(...row.hours);
          const peakHour = row.hours.indexOf(peak);

          return (
            <div key={row.id} className="flex items-center gap-3 py-0.5">
              <div className="w-28 shrink-0 truncate text-xs text-ink-secondary" title={row.name}>
                {row.name}
              </div>
              <div className="grid flex-1 gap-0.5" style={hourColumns}>
                {row.hours.map((count, hour) => (
                  <div
                    key={formatHourOfDay(hour)}
                    className="h-5 rounded-[2px]"
                    style={{ background: heatFill(count, peak) }}
                    title={`${row.name} · ${formatHourOfDay(hour)} — ${formatNumber(count)} events`}
                  />
                ))}
              </div>
              {/* The one number worth reading off the row without hovering. */}
              <div className="w-24 shrink-0 text-right text-xs tabular-nums text-ink-muted">
                {peak > 0 ? `peak ${formatHourOfDay(peakHour)}` : "—"}
              </div>
            </div>
          );
        })}

        <div className="flex items-center gap-3 pt-1">
          <div className="w-28 shrink-0" />
          <div className="grid flex-1" style={hourColumns}>
            {Array.from({ length: HOURS_IN_DAY }, (_, hour) =>
              hour % AXIS_TICK_EVERY === 0 ? (
                <div
                  key={hour}
                  className="text-xs tabular-nums text-ink-muted"
                  style={{ gridColumn: `span ${AXIS_TICK_EVERY}` }}
                >
                  {formatHourOfDay(hour)}
                </div>
              ) : null,
            )}
          </div>
          <div className="w-24 shrink-0" />
        </div>

        <HeatLegend />
      </div>
    </div>
  );
}

/** One person's calendar day: the stretches they were working, in order. */
export type DaySpan = {
  date: string;
  sessions: { startMinute: number; endMinute: number; events: number }[];
};

const MINUTES_IN_DAY = HOURS_IN_DAY * 60;

/** A session of a single event has no width of its own; it still has to be visible. */
const MINIMUM_BLOCK_WIDTH = "3px";

/**
 * One row per day, each session drawn where it actually happened against a 24-hour
 * track. What the eye is meant to catch is the *gaps* — the track showing through
 * between two blocks is a break, and its length is read off the axis.
 *
 * Blocks are the visible edge of the work, not the work: an hour spent reading
 * code emits no events and is indistinguishable from lunch. The card says so.
 */
export function DayShape({ days, breakMinutes }: { days: DaySpan[]; breakMinutes: number }) {
  if (!days.length) {
    return <p className="py-12 text-center text-sm text-ink-muted">No activity in this window.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-xl">
        {days.map((day) => {
          const first = day.sessions[0];
          const last = day.sessions[day.sessions.length - 1];

          return (
            <div key={day.date} className="flex items-center gap-3 py-0.5">
              <div className="w-24 shrink-0 text-xs tabular-nums text-ink-secondary">
                {formatDayLabel(day.date)}
              </div>

              <div className="relative h-5 flex-1 overflow-hidden rounded-[2px]" style={{ background: "var(--gridline)" }}>
                {day.sessions.map((session) => (
                  <div
                    key={session.startMinute}
                    className="absolute inset-y-0 rounded-[2px]"
                    style={{
                      background: "var(--series-1)",
                      left: `${(session.startMinute / MINUTES_IN_DAY) * 100}%`,
                      width: `max(${MINIMUM_BLOCK_WIDTH}, ${((session.endMinute - session.startMinute) / MINUTES_IN_DAY) * 100}%)`,
                    }}
                    title={
                      `${formatMinuteOfDay(session.startMinute)} → ${formatMinuteOfDay(session.endMinute)} · ` +
                      `${formatDuration(session.endMinute - session.startMinute)} · ` +
                      `${formatNumber(session.events)} events`
                    }
                  />
                ))}
              </div>

              <div className="w-44 shrink-0 text-right text-xs tabular-nums text-ink-secondary">
                {first && last ? (
                  <>
                    {formatMinuteOfDay(first.startMinute)} → {formatMinuteOfDay(last.endMinute)}
                    <span className="text-ink-muted">
                      {" "}
                      · {formatDuration(last.endMinute - first.startMinute)}
                    </span>
                  </>
                ) : (
                  <span className="text-ink-muted">no activity</span>
                )}
              </div>
            </div>
          );
        })}

        <div className="flex items-center gap-3 pt-1">
          <div className="w-24 shrink-0" />
          <div className="grid flex-1" style={hourColumns}>
            {Array.from({ length: HOURS_IN_DAY }, (_, hour) =>
              hour % AXIS_TICK_EVERY === 0 ? (
                <div
                  key={formatHourOfDay(hour)}
                  className="text-xs tabular-nums text-ink-muted"
                  style={{ gridColumn: `span ${AXIS_TICK_EVERY}` }}
                >
                  {formatHourOfDay(hour)}
                </div>
              ) : null,
            )}
          </div>
          <div className="w-44 shrink-0" />
        </div>

        <p className="mt-4 text-xs text-ink-muted">
          A gap of more than {formatDuration(breakMinutes)} between events starts a new block.
        </p>
      </div>
    </div>
  );
}

/** A single ratio against its whole. Track is a lighter step of the fill's own ramp. */
export function Meter({ value, caption }: { value: number | null; caption: string }) {
  const share = value === null ? 0 : Math.min(1, Math.max(0, value));

  return (
    <div>
      <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--meter-track)" }}>
        <div
          className="h-full rounded-full"
          style={{ background: "var(--series-1)", width: `${share * 100}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-ink-secondary">{caption}</p>
    </div>
  );
}
