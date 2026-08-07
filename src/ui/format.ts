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

/** 639 -> "10:39". Minutes counted from local midnight, as the day-shape rows carry them. */
export const formatMinuteOfDay = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** 222 -> "3h 42m". Under an hour keeps minutes alone rather than printing "0h". */
export const formatDuration = (minutes: number) => {
  const whole = Math.round(minutes);
  return whole < 60 ? `${whole}m` : `${Math.floor(whole / 60)}h ${String(whole % 60).padStart(2, "0")}m`;
};

/** 186 cents -> "$1.86". Minor units in, because that is what the usage report reports. */
export const formatMoney = (minorUnits: number, currency: string) =>
  (minorUnits / 100).toLocaleString(undefined, { style: "currency", currency });

/** "2026-07-27" -> "Mon 07-27". Read in UTC: the string is a calendar date, not an instant. */
export const formatDayLabel = (isoDate: string) => {
  const weekday = new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
  return `${weekday} ${isoDate.slice(5)}`;
};

/** "2026-07-08T14:31:02.000Z" -> "2026-07-08 14:31". */
export const formatTimestamp = (isoTimestamp: string) =>
  isoTimestamp.slice(0, 16).replace("T", " ");
