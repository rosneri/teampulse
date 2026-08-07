export const formatNumber = (value: number) => value.toLocaleString();

/** Share as a whole percent. Null renders as a visible gap, never as 0%. */
export const formatPercent = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;

/** Hours under two days, days past that. Matches the command line output. */
export const formatHours = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "—"
    : value < 48
      ? `${value.toFixed(1)}h`
      : `${(value / 24).toFixed(1)}d`;

/** "2026-07-08" -> "07-08", the axis tick for a daily series. */
export const formatDayTick = (isoDate: string) => isoDate.slice(5, 10);

/** 9 -> "09:00". Always 24-hour: the heat map's axis is hours, not a clock reading. */
export const formatHourOfDay = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

/** "2026-07-08T14:31:02.000Z" -> "2026-07-08 14:31". */
export const formatTimestamp = (isoTimestamp: string) =>
  isoTimestamp.slice(0, 16).replace("T", " ");
