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

/**
 * The one thing the AI layer writes that is meant to leave the building: a draft
 * of the update a manager posts to their team at the end of a day.
 *
 * It is organised by work rather than by person, and that is a constraint on the
 * shape, not a style note — a section per person is a scoreboard, and nothing in
 * this repository ranks people against each other. Lines are unnumbered here and
 * numbered when rendered, so the reader can reply "re 3" without the model having
 * to count.
 */
const DAILY_MESSAGE_SCHEMA = z.object({
  headline: z
    .string()
    .describe(
      "The day in one sentence, about the work rather than the team. On a day with almost no " +
        "events, say that plainly — a padded update trains people to stop reading it.",
    ),
  shipped: z
    .array(z.string().describe("One thing that landed, naming the work and who it belongs to."))
    .describe("Work the events show finished in this window. Empty is a normal answer."),
  inFlight: z
    .array(z.string().describe("One strand still moving, and where it stands."))
    .describe("Work the events show in progress, one line per strand rather than per event."),
  waiting: z
    .array(z.string().describe("What has stopped, and what it is waiting on or who could unstick it."))
    .describe(
      "Work that has not moved — an assignment idle for days, a strand that stopped mid-window. " +
        "Say what the lists show and let the reader decide whose turn it is.",
    ),
});

export type PersonSummary = z.infer<typeof SUMMARY_SCHEMA>;
export type WorkTypeProposals = z.infer<typeof WORK_TYPE_SCHEMA>;
export type FocusReading = z.infer<typeof FOCUS_SCHEMA>;
export type DailyMessage = z.infer<typeof DAILY_MESSAGE_SCHEMA>;

export type Judgment =
  | { kind: "summary"; personId: string; cached: boolean; payload: PersonSummary }
  | { kind: "work_type"; personId: string; cached: boolean; payload: WorkTypeProposals }
  | { kind: "focus"; personId: string; cached: boolean; payload: FocusReading }
  | { kind: "daily_message"; personId: null; cached: boolean; payload: DailyMessage }
  | { kind: AiOutputKind; personId: string | null; error: string };

/** A stored judgment, read back and re-validated. Carries the window it judged, not the current one. */
export type StoredJudgment = {
  windowStart: Date;
  windowEnd: Date;
  createdAt: Date;
} & (
  | { kind: "summary"; personId: string; payload: PersonSummary }
  | { kind: "work_type"; personId: string; payload: WorkTypeProposals }
  | { kind: "focus"; personId: string; payload: FocusReading }
  | { kind: "daily_message"; personId: null; payload: DailyMessage }
);

/** Every kind that has a schema here, paired with it, so reading one back is one lookup. */
const SCHEMAS = {
  summary: SUMMARY_SCHEMA,
  work_type: WORK_TYPE_SCHEMA,
  focus: FOCUS_SCHEMA,
  daily_message: DAILY_MESSAGE_SCHEMA,
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
    // Scope and kind have to agree: a personless summary, or a daily message
    // pinned to somebody, is a row no version of this file ever wrote.
    if ((row.personId === null) !== (kind === "daily_message")) continue;
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

const DAILY_MESSAGE_INSTRUCTIONS = [
  "You draft the end-of-day update a manager posts to their own team. You are writing as them, in",
  "the first person, plainly and short: a teammate reads this in a chat window between two other",
  "things, and every line they skip is a line that should not have been there.",
  "",
  "You are given one section per person — what their manager stated they should be on, what the",
  "tracker has them assigned, and the events their work produced in the window. Those sections are",
  "how the input is organised and not how the message is: group the update by the work, so one",
  "strand is one line whoever touched it, and name a person because they own something, never as a",
  "heading with their day listed underneath. This is a message a whole team reads, and a per-person",
  "tally of output is a scoreboard. Do not write one, and do not rank, grade, praise or compare",
  "anybody — there is no ordering in this data to support it.",
  "",
  "Hard limits, the same ones every other reading here works under. Events are instants: they are",
  "the moments work surfaced, so you cannot tell effort, hours or diligence from them. A person",
  "with no events is simply absent from the message — silence means the work left no trace, and a",
  "line announcing that somebody was quiet is both a guess and a public one. Claim nothing the",
  "lists do not show, invent no progress, and when the day was thin say so in a sentence and stop.",
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

/**
 * Every brief, each under the name it belongs to, reusing the per-person layout
 * exactly. The team's day is the sum of these three-list sections and nothing
 * else — no metric, no ranking and no second window sneaks into this prompt.
 */
export function dailyMessagePrompt(briefs: FocusBrief[]): string {
  // Ruled off rather than nested under a heading: the per-person layout already
  // owns "#", and a name one level above it would read as a section to write.
  return briefs.map((brief) => `=== ${brief.name} ===\n\n${focusPrompt(brief)}`).join("\n\n");
}

async function ask<T>(input: {
  kind: AiOutputKind;
  personId: string | null;
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

/**
 * One draft of the day's team update, from every brief at once. It is the only
 * judgment here about nobody in particular, which is why its row carries no
 * person: the alternative is a placeholder id, and a placeholder in the identity
 * column is exactly the kind of thing the rest of this database refuses.
 *
 * A draft, and never a send. Nothing in this repository posts anywhere.
 */
export async function dailyMessage(options: {
  briefs: FocusBrief[];
  since: Date;
}): Promise<Judgment | null> {
  // No events anywhere in the window means there is no day to report. Asking
  // would buy a paragraph about an empty team.
  if (!options.briefs.some((brief) => brief.events.length)) return null;

  try {
    const { payload, cached } = await ask({
      kind: "daily_message",
      personId: null,
      since: options.since,
      until: new Date(),
      instructions: DAILY_MESSAGE_INSTRUCTIONS,
      prompt: dailyMessagePrompt(options.briefs),
      schema: DAILY_MESSAGE_SCHEMA,
    });
    return { kind: "daily_message", personId: null, cached, payload };
  } catch (error) {
    return { kind: "daily_message", personId: null, error: String(error) };
  }
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
