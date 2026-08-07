/**
 * Which days of the week a person works. Weekends differ by country, so the
 * activity strip can only hide them per person — a Friday that is a day off in
 * Tel Aviv is an ordinary working day almost everywhere else.
 *
 * Named after the working days rather than a country, because the calendar is
 * the fact and the country is only the usual reason for it.
 */
export const WORK_WEEKS = ["sunday-thursday", "monday-friday"] as const;

export type WorkWeek = (typeof WORK_WEEKS)[number];

/** Israel and much of the Middle East. Everyone in people.yaml today. */
export const DEFAULT_WORK_WEEK: WorkWeek = "sunday-thursday";

export const WORK_WEEK_LABELS: Record<WorkWeek, string> = {
  "sunday-thursday": "Sunday–Thursday (weekend: Friday, Saturday)",
  "monday-friday": "Monday–Friday (weekend: Saturday, Sunday)",
};

/** Non-working days as JavaScript day numbers, where 0 is Sunday. */
export function weekendDays(workWeek: WorkWeek): readonly number[] {
  return workWeek === "sunday-thursday" ? [5, 6] : [6, 0];
}

export function isWorkWeek(value: unknown): value is WorkWeek {
  return typeof value === "string" && (WORK_WEEKS as readonly string[]).includes(value);
}

/** `isoDate` is a calendar date, "2026-07-08" — read in UTC, as the database stores it. */
export function isWeekend(isoDate: string, workWeek: WorkWeek): boolean {
  const dayOfWeek = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return weekendDays(workWeek).includes(dayOfWeek);
}
