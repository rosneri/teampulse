import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { type AiOutputKind, findAiOutput, recentAiOutputs, saveAiOutput } from "./db";
import { activityFeed, unclassifiedWork } from "./metrics";
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

export type PersonSummary = z.infer<typeof SUMMARY_SCHEMA>;
export type WorkTypeProposals = z.infer<typeof WORK_TYPE_SCHEMA>;

export type Judgment =
  | { kind: "summary"; personId: string; cached: boolean; payload: PersonSummary }
  | { kind: "work_type"; personId: string; cached: boolean; payload: WorkTypeProposals }
  | { kind: AiOutputKind; personId: string; error: string };

/** A stored judgment, read back and re-validated. Carries the window it judged, not the current one. */
export type StoredJudgment = {
  personId: string;
  windowStart: Date;
  windowEnd: Date;
  createdAt: Date;
} & ({ kind: "summary"; payload: PersonSummary } | { kind: "work_type"; payload: WorkTypeProposals });

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
    if (row.kind !== "summary" && row.kind !== "work_type") continue;
    const key = `${row.kind}:${row.personId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const stored = {
      personId: row.personId,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      createdAt: row.createdAt,
    };

    if (row.kind === "summary") {
      const parsed = SUMMARY_SCHEMA.safeParse(row.payload);
      if (parsed.success) judgments.push({ ...stored, kind: "summary", payload: parsed.data });
      continue;
    }

    const parsed = WORK_TYPE_SCHEMA.safeParse(row.payload);
    if (parsed.success) judgments.push({ ...stored, kind: "work_type", payload: parsed.data });
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
