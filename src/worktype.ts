/** The four kinds, in one place: the classifier, the AI schema and the charts all read this list. */
export const WORK_TYPES = ["bug", "feature", "improvement", "chore"] as const;

export type WorkType = (typeof WORK_TYPES)[number];

/**
 * Deterministic classifier: explicit labels beat title conventions, and anything
 * unrecognised stays null. Null is reported as "unclassified" rather than being
 * quietly folded into a bucket — a wrong ratio is worse than a visible gap.
 * The AI layer may later propose types for the null tail; it writes to ai_output,
 * never to activity.work_type.
 */

// Conventional-commit style prefixes: "fix: ...", "feat(api): ...".
const PREFIX: Record<string, WorkType> = {
  fix: "bug",
  bugfix: "bug",
  hotfix: "bug",
  bug: "bug",
  revert: "bug",
  feat: "feature",
  feature: "feature",
  perf: "improvement",
  refactor: "improvement",
  improvement: "improvement",
  enhancement: "improvement",
  style: "improvement",
  chore: "chore",
  docs: "chore",
  doc: "chore",
  test: "chore",
  tests: "chore",
  build: "chore",
  ci: "chore",
  deps: "chore",
};

// Label matching is word-boundary, not substring — "debug" must not read as "bug".
const LABEL_RULES: [RegExp, WorkType][] = [
  [/\b(bug|bugs|defect|regression|incident|hotfix)\b/, "bug"],
  [/\b(feature|features|epic|new)\b/, "feature"],
  [/\b(improvement|enhancement|perf|performance|refactor|polish)\b/, "improvement"],
  [/\b(chore|docs?|documentation|maintenance|tech.?debt|infra|ci)\b/, "chore"],
];

export function classify(title?: string | null, labels: string[] = []): WorkType | null {
  for (const label of labels) {
    const norm = label.toLowerCase().replace(/[_\-/]+/g, " ");
    for (const [re, type] of LABEL_RULES) if (re.test(norm)) return type;
  }

  const m = /^\s*([a-z]+)(\([^)]*\))?!?\s*:/i.exec(title ?? "");
  if (m) {
    const hit = PREFIX[m[1]!.toLowerCase()];
    if (hit) return hit;
  }

  return null;
}
