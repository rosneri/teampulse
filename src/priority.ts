/**
 * Linear's priority scale, which is a set of names and not an ordering.
 *
 * The API sends 0 for "no priority" and then 1 urgent through 4 low, so sorting
 * on the number alone ranks unprioritised work above urgent work. Anything that
 * orders by priority has to put 0 last — `assignments` in metrics.ts is where
 * that rule is written, and it is written once.
 */
export const PRIORITY_LABELS = ["no priority", "urgent", "high", "medium", "low"] as const;

/** Anything outside the scale reads as unprioritised rather than throwing: it is a number from an API. */
export function priorityLabel(priority: number): string {
  return PRIORITY_LABELS[priority] ?? PRIORITY_LABELS[0];
}
