import type { WorkType } from "./worktype";

export type Source = "github" | "linear" | "slack" | "notion" | "calendar" | "vercel";

export type ActivityType =
  // github
  | "pr_opened"
  | "pr_merged"
  | "pr_reviewed"
  /** A comment on a pull request — review threads and the conversation tab alike. */
  | "pr_commented"
  /** Landed on a repository's default branch. Excludes anything that got there via a merged pull request. */
  | "commit_pushed"
  /** A deployment reached an environment. GitHub Deployments and Vercel both land here. */
  | "deployed"
  /** A workflow a person started by hand — a dispatch or a re-run, never an automatic push build. */
  | "ci_run"
  // linear and github issues alike: an issue is an issue, the source says which tracker
  | "issue_created"
  | "issue_completed"
  | "issue_commented"
  // slack
  | "message"
  | "thread_reply"
  | "mention_received"
  | "directive_received"
  // notion
  | "doc_created"
  | "doc_edited"
  // calendar
  /** A meeting the person was in. The only event that owns a real duration. */
  | "meeting";

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
  /** ISO 8601 UTC. When the thing happened, or when it started if it has a length. */
  ts: string;
  /**
   * ISO 8601 UTC end, for the events that genuinely occupy time — a meeting, and
   * nothing else today. Everything else is an instant: a commit is not "an hour
   * of work", it is the moment the work surfaced. Stored in `meta.endsAt` so the
   * activity table needs no column, and read back by the day-shape query.
   */
  endsAt?: string;
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
