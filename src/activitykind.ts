import type { ActivityType } from "./types";

/**
 * What a person was doing, one level above the event type. The day-shape chart
 * colours by this: "code", "meeting" and "chat" are the distinctions a reader
 * actually makes when they look at somebody's afternoon, and twelve event types
 * are too many hues to tell apart.
 *
 * The order is fixed and meaningful — it is the order the categorical palette
 * slots are assigned in, so a kind keeps its colour no matter which kinds happen
 * to be present in the window.
 */
export const ACTIVITY_KINDS = [
  "code",
  "chat",
  "review",
  "issues",
  "docs",
  "ship",
  "meeting",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * Every event type lands in exactly one kind. Exhaustive on purpose: a new
 * ActivityType that nobody classified is a compile error here, not a silent
 * "other" bucket in the chart.
 */
export const KIND_OF: Record<ActivityType, ActivityKind> = {
  pr_opened: "code",
  pr_merged: "code",
  commit_pushed: "code",
  pr_reviewed: "review",
  pr_commented: "review",
  issue_created: "issues",
  issue_completed: "issues",
  issue_commented: "issues",
  message: "chat",
  thread_reply: "chat",
  mention_received: "chat",
  directive_received: "chat",
  doc_created: "docs",
  doc_edited: "docs",
  deployed: "ship",
  ci_run: "ship",
  meeting: "meeting",
};

export const KIND_LABELS: Record<ActivityKind, string> = {
  code: "Code",
  chat: "Chat",
  review: "Review",
  issues: "Issues",
  docs: "Docs",
  ship: "Ship",
  meeting: "Meetings",
};

export function kindOf(type: string): ActivityKind | null {
  return KIND_OF[type as ActivityType] ?? null;
}
