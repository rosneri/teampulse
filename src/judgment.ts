import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { type AiOutputKind, findAiOutput, recentAiOutputs, saveAiOutput } from "./db";
import type { FocusBrief } from "./focus";
import { activityFeed, unclassifiedWork } from "./metrics";
import { priorityLabel } from "./priority";
import { WORK_TYPES } from "./worktype";

/**
 * The judgment layer. Everything in `metrics.ts` is SQL over facts; everything
 * here is a model's opinion about those facts, and it writes to `ai_output` and
 * nowhere else. A proposed work type never becomes `activity.work_type`, so a
 * chart can always be traced back to something a person or an API actually said.
 *
 * Every call is stamped with a hash of the exact prompt text it was shown. That
 * is what makes a stored claim auditable, and it doubles as the cache key: the
 * same events asked about twice are answered once and paid for once.
 */

const MODEL = anthropic("claude-opus-5");

/** The window's events are the whole input, so a very long window is truncated rather than sent. */
const FEED_LIMIT = 200;

const SUMMARY_SCHEMA = z.object({
  headline: z
    .string()
    .describe(
      "One sentence saying what this person spent the window on. Describe the work, " +
        "never the person, and never compare them to anybody else.",
    ),
  themes: z
    .array(
      z
        .string()
        .describe("One strand of work, named the way the events name it, in under twelve words."),
    )
    .max(4)
    .describe("The distinct strands of work visible in the events, most substantial first."),
  concerns: z
    .array(
      z
        .string()
        .describe("Something a reader should look at, and the events that make it visible."),
    )
    .describe(
      "Patterns worth a second look — work that opened and never closed, a strand that " +
        "stopped mid-window, review requests that went unanswered. Empty when nothing " +
        "stands out; an empty list is a better answer than a manufactured worry.",
    ),
});

const WORK_TYPE_SCHEMA = z.object({
  proposals: z
    .array(
      z.object({
        activityId: z
          .string()
          .describe("The id of the item being classified, copied exactly from the list."),
        workType: z
          .enum(WORK_TYPES)
          .describe(
            "bug: restores behaviour that was broken. feature: adds a capability that did not " +
              "exist. improvement: makes existing behaviour better without adding a capability. " +
              "chore: documentation, tests, dependencies, build and infrastructure.",
          ),
        confidence: z
          .enum(["low", "medium", "high"])
          .describe("high only when the title states the kind of work outright."),
        reason: z
          .string()
          .describe("The words in the title or body that decided it, in one sentence."),
      }),
    )
    .describe(
      "One entry per item you can classify. Leave an item out entirely when its title and " +
        "body do not say enough — an omission is a correct answer and a guess is not.",
    ),
});

const FOCUS_SCHEMA = z.object({
  alignment: z
    .enum(["on_priorities", "mixed", "off_priorities", "not_enough_signal"])
    .describe(
      "How the window's events line up with the priorities stated above them. " +
        "not_enough_signal whenever there is no stated priority to compare against, or too " +
        "little activity to say — it is the honest answer far more often than it looks, and " +
        "it is always better than a verdict built out of two events.",
    ),
  workingOn: z
    .string()
    .describe(
      "One sentence on what the events show them working on. Describe the work, not the person.",
    ),
  matched: z
    .array(
      z.object({
        priority: z.string().describe("The stated priority, copied closely enough to be recognised."),
        evidence: z.string().describe("The events that show work on it, named as the list names them."),
      }),
    )
    .describe("Stated priorities the events show visible work on."),
  untouched: z
    .array(z.string().describe("A stated priority with nothing visible against it in this window."))
    .describe(
      "Stated priorities the events say nothing about. This means the work left no trace, " +
        "which is not the same as it not happening — reading code, thinking and pairing all " +
        "emit nothing at all.",
    ),
  unexplained: z
    .array(z.string().describe("Work visible in the events that no stated priority accounts for."))
    .describe(
      "Activity that maps to none of the priorities. An empty list is a fine answer. Do not " +
        "count review, unblocking a teammate or answering a question as unexplained by default — " +
        "say what it was and let the reader judge whether it belonged.",
    ),
  ask: z
    .string()
    .nullable()
    .describe(
      "The single question worth putting to this person, in their manager's own plain words, " +
        "or null when the window raises none. One question, not a list, and never a reprimand.",
    ),
});

export type PersonSummary = z.infer<typeof SUMMARY_SCHEMA>;
export type WorkTypeProposals = z.infer<typeof WORK_TYPE_SCHEMA>;
export type FocusReading = z.infer<typeof FOCUS_SCHEMA>;

export type Judgment =
  | { kind: "summary"; personId: string; cached: boolean; payload: PersonSummary }
  | { kind: "work_type"; personId: string; cached: boolean; payload: WorkTypeProposals }
  | { kind: "focus"; personId: string; cached: boolean; payload: FocusReading }
  | { kind: AiOutputKind; personId: string; error: string };

/** A stored judgment, read back and re-validated. Carries the window it judged, not the current one. */
export type StoredJudgment = {
  personId: string;
  windowStart: Date;
  windowEnd: Date;
  createdAt: Date;
} & (
  | { kind: "summary"; payload: PersonSummary }
  | { kind: "work_type"; payload: WorkTypeProposals }
  | { kind: "focus"; payload: FocusReading }
);

/** Every kind that has a schema here, paired with it, so reading one back is one lookup. */
const SCHEMAS = {
  summary: SUMMARY_SCHEMA,
  work_type: WORK_TYPE_SCHEMA,
  focus: FOCUS_SCHEMA,
} as const;

/**
 * The newest judgment of each kind per person, whatever window it was made over
 * — which is why every row carries its own window. A row whose payload no longer
 * matches the schema was written by an older version of it and is dropped rather
 * than shown: half a judgment is worse than none.
 */
export async function storedJudgments(): Promise<StoredJudgment[]> {
  const rows = await recentAiOutputs();
  const seen = new Set<string>();
  const judgments: StoredJudgment[] = [];

  for (const row of rows) {
    const kind = row.kind;
    if (!(kind in SCHEMAS)) continue;
    const key = `${kind}:${row.personId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const stored = {
      personId: row.personId,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      createdAt: row.createdAt,
    };

    const parsed = SCHEMAS[kind as keyof typeof SCHEMAS].safeParse(row.payload);
    if (!parsed.success) continue;
    // The cast holds because SCHEMAS pairs each kind with the one schema that
    // just validated this payload: `kind` and `payload` cannot disagree here.
    // TypeScript loses that pairing across the index, not the program.
    judgments.push({ ...stored, kind, payload: parsed.data } as StoredJudgment);
  }

  return judgments;
}

const SUMMARY_INSTRUCTIONS = [
  "You read one person's activity events and say what the window was about.",
  "The events are the only evidence you have. Never assert anything they do not show,",
  "never estimate effort or hours — an event is the moment work surfaced, not a duration —",
  "and never praise, rank or grade. A quiet window is a quiet window; say so plainly.",
].join(" ");

const WORK_TYPE_INSTRUCTIONS = [
  "You classify delivered work by kind. Each item below reached a team's history without a",
  "label or a conventional-commit prefix saying what kind of work it was, which is why it is",
  "here. Judge only from the title and body given. When they are ambiguous, leave the item",
  "out: an unclassified item is reported as a visible gap, and a wrong ratio is worse than a gap.",
].join(" ");

const FOCUS_INSTRUCTIONS = [
  "You are given one person's stated priorities and the events their work produced in a window,",
  "and you say how the two line up. You are answering for their manager.",
  "",
  "The priorities come from three places and they are not equal: a manager's stated focus is an",
  "instruction and outranks the tracker, a Linear issue's own priority is what the tracker",
  "records, and a project or initiative says which larger thing a piece of work belongs to.",
  "When the manager's focus and the tracker disagree, say so — that disagreement is the single",
  "most useful thing on the page, and it is a fact about the two lists, not a fault of the person.",
  "",
  "Hard limits. Events are instants, not durations: they are the moments work surfaced, so you",
  "cannot tell effort, hours or diligence from them, and you must never try. Silence against a",
  "priority means it left no trace — reading code, thinking, pairing and meetings people did not",
  "book all look identical to a quiet day. Never grade, rank, praise or reprimand the person, and",
  "never compare them to anybody else; there is nobody else in this prompt for that reason.",
  "Judge only the fit between two lists you were handed, and when the lists are too thin to",
  "support a verdict, answer not_enough_signal and stop.",
].join(" ");

function digestOf(prompt: string): string {
  return new Bun.CryptoHasher("sha256").update(prompt).digest("hex");
}

/** Titles only: bodies are mostly template and would crowd out the events themselves. */
export function summaryPrompt(rows: { ts: Date; type: string; title: string | null }[]): string {
  return rows
    .map((row) => `${row.ts.toISOString()} ${row.type} ${row.title ?? ""}`.trimEnd())
    .join("\n");
}

export function workTypePrompt(
  rows: { id: string; type: string; title: string | null; body: string | null }[],
): string {
  return rows
    .map((row) =>
      [
        `id: ${row.id}`,
        `event: ${row.type}`,
        `title: ${row.title ?? ""}`,
        `body: ${row.body?.slice(0, 500) ?? ""}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * The three lists, in the order they carry weight: what a manager said, what the
 * tracker holds, and what actually surfaced. Laid out as labelled sections rather
 * than prose so the model is never left guessing which list a line came from.
 */
export function focusPrompt(brief: FocusBrief): string {
  const declared = brief.declared
    ? `${brief.declared.focus}\n(set ${brief.declared.setAt})`
    : "none stated";

  const assignments = brief.assignments.length
    ? brief.assignments
        .map((issue) =>
          [
            `${issue.identifier} ${issue.title}`,
            `  priority: ${priorityLabel(issue.priority)}`,
            `  state: ${issue.state}`,
            `  project: ${issue.project_name ?? "none"}`,
            `  initiative: ${issue.initiative_name ?? "none"}`,
            `  untouched for: ${issue.idle_days} days`,
          ].join("\n"),
        )
        .join("\n")
    : "none open";

  const events = brief.events.length
    ? brief.events
        .map((row) => `${row.ts.toISOString()} ${row.type} ${row.title ?? ""}`.trimEnd())
        .join("\n")
    : "none in this window";

  return [
    `# Focus stated by their manager\n${declared}`,
    `# Open assignments in Linear, most important first\n${assignments}`,
    `# Events in this window, newest first\n${events}`,
  ].join("\n\n");
}

async function ask<T>(input: {
  kind: AiOutputKind;
  personId: string;
  since: Date;
  until: Date;
  instructions: string;
  prompt: string;
  schema: z.ZodType<T>;
}): Promise<{ payload: T; cached: boolean }> {
  const inputDigest = digestOf(input.prompt);

  const seen = await findAiOutput(input.kind, input.personId, inputDigest);
  // Parsed rather than trusted: a stored payload was written by an older version
  // of a schema that may since have changed, which makes it a trust boundary.
  if (seen) return { payload: input.schema.parse(seen.payload), cached: true };

  const { object } = await generateObject({
    model: MODEL,
    schema: input.schema,
    instructions: input.instructions,
    prompt: input.prompt,
  });

  await saveAiOutput({
    kind: input.kind,
    personId: input.personId,
    windowStart: input.since,
    windowEnd: input.until,
    inputDigest,
    // The schema above already validated the shape; Prisma only needs it typed as JSON.
    payload: object as never,
  });

  return { payload: object, cached: false };
}

/**
 * Both judgments, for every person given, over one window. One person's failure
 * is reported and skipped rather than losing the rest — the same bargain
 * `sync` makes with one expired token out of six sources.
 */
export async function judge(options: {
  personIds: string[];
  since: Date;
  repository?: string;
}): Promise<Judgment[]> {
  const until = new Date();
  const unclassified = await unclassifiedWork(options.since, options.repository);

  const results = await Promise.all(
    options.personIds.flatMap((personId): Promise<Judgment | null>[] => [
      summarise({ ...options, personId, until }),
      proposeWorkTypes({
        ...options,
        personId,
        until,
        items: unclassified.filter((item) => item.person_id === personId),
      }),
    ]),
  );

  return results.filter((judgment): judgment is Judgment => judgment !== null);
}

/**
 * Reads each person's focus brief and says how their window lines up with what
 * they were asked to be on. Separate from `judge` because it answers a different
 * question over a different window — a day, against priorities that were true
 * this morning — and because a manager should be able to spend one without
 * paying for the other.
 */
export async function judgeFocus(options: {
  briefs: FocusBrief[];
  since: Date;
}): Promise<Judgment[]> {
  const until = new Date();

  const results = await Promise.all(
    options.briefs.map(async (brief): Promise<Judgment | null> => {
      // Nothing stated and nothing open: there is no pair of lists to compare, so
      // the only honest reading is one this function can give away for free.
      if (!brief.declared && !brief.assignments.length) return null;

      try {
        const { payload, cached } = await ask({
          kind: "focus",
          personId: brief.personId,
          since: options.since,
          until,
          instructions: FOCUS_INSTRUCTIONS,
          prompt: focusPrompt(brief),
          schema: FOCUS_SCHEMA,
        });
        return { kind: "focus", personId: brief.personId, cached, payload };
      } catch (error) {
        return { kind: "focus", personId: brief.personId, error: String(error) };
      }
    }),
  );

  return results.filter((judgment): judgment is Judgment => judgment !== null);
}

async function summarise(options: {
  personId: string;
  since: Date;
  until: Date;
  repository?: string;
}): Promise<Judgment | null> {
  const feed = await activityFeed({
    personId: options.personId,
    since: options.since,
    limit: FEED_LIMIT,
    repository: options.repository,
  });
  // Nothing happened, so there is nothing to have an opinion about. Asking anyway
  // would buy a paragraph of invented significance.
  if (!feed.length) return null;

  try {
    const { payload, cached } = await ask({
      kind: "summary",
      personId: options.personId,
      since: options.since,
      until: options.until,
      instructions: SUMMARY_INSTRUCTIONS,
      prompt: summaryPrompt(feed),
      schema: SUMMARY_SCHEMA,
    });
    return { kind: "summary", personId: options.personId, cached, payload };
  } catch (error) {
    return { kind: "summary", personId: options.personId, error: String(error) };
  }
}

async function proposeWorkTypes(options: {
  personId: string;
  since: Date;
  until: Date;
  items: { id: string; type: string; title: string | null; body: string | null }[];
}): Promise<Judgment | null> {
  if (!options.items.length) return null;

  try {
    const { payload, cached } = await ask({
      kind: "work_type",
      personId: options.personId,
      since: options.since,
      until: options.until,
      instructions: WORK_TYPE_INSTRUCTIONS,
      prompt: workTypePrompt(options.items),
      schema: WORK_TYPE_SCHEMA,
    });
    // A proposal for an id that was never shown is a hallucinated row; drop it
    // rather than storing a claim about an event this call never saw.
    const shown = new Set(options.items.map((item) => item.id));
    return {
      kind: "work_type",
      personId: options.personId,
      cached,
      payload: { proposals: payload.proposals.filter((p) => shown.has(p.activityId)) },
    };
  } catch (error) {
    return { kind: "work_type", personId: options.personId, error: String(error) };
  }
}
