import type { WorkType } from "./worktype";

export type Source = "github" | "linear" | "slack";

export type ActivityType =
  // github
  | "pr_opened"
  | "pr_merged"
  | "pr_reviewed"
  // linear
  | "issue_created"
  | "issue_completed"
  | "issue_commented"
  // slack
  | "message"
  | "thread_reply"
  | "mention_received"
  | "directive_received";

/**
 * The single shape every source collapses into. Metrics, AI prompts and the
 * dashboard read only this — nothing downstream knows what GitHub or Slack is.
 */
export type Activity = {
  /** Stable across re-syncs: "<source>:<type>:<source-native-id>" */
  id: string;
  source: Source;
  type: ActivityType;
  /** Canonical person id from people.yaml, never a source handle. */
  personId: string;
  /** Deterministically classified; null when nothing said what kind of work it is. */
  workType?: WorkType | null;
  /** ISO 8601 UTC. */
  ts: string;
  url?: string;
  title?: string;
  body?: string;
  meta?: unknown;
};

export type OpenIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  personId: string;
  state: string;
  workType?: WorkType | null;
  priority: number;
  updatedAt: string;
};
