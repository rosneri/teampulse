import type { Person } from "./config";
import { personFocus } from "./db";
import { type Assignment, type FeedRow, activityFeed, assignments } from "./metrics";

/**
 * The daily focus brief: for one person, the three things a manager needs beside
 * each other to answer "are they on the right thing today".
 *
 * Two of them are facts and the third is not, and they are kept apart here the
 * same way `metrics.ts` and `judgment.ts` are kept apart everywhere else:
 *
 * - `assignments` is what their tracker says they are on the hook for.
 * - `events` is what actually surfaced from them in the window.
 * - `declared` is what a manager typed. It is neither measured nor inferred, and
 *   it is null for anybody nobody has said anything about — which is a real and
 *   common answer, not a gap to fill in.
 *
 * Nothing here decides whether the three agree. That question costs money and is
 * asked in `judgment.ts`, on a person's say-so.
 */
export type FocusBrief = {
  personId: string;
  name: string;
  declared: { focus: string; setAt: string } | null;
  assignments: Assignment[];
  events: FeedRow[];
};

/**
 * A day rarely produces more than a few dozen events per person, so this is a
 * ceiling rather than a page: a window wide enough to hit it wants the activity
 * feed, not a focus brief.
 */
const EVENT_LIMIT = 60;

export async function focusBriefs(options: {
  people: Person[];
  since: Date;
  repository?: string;
}): Promise<FocusBrief[]> {
  const [declared, open] = await Promise.all([personFocus(), assignments()]);
  const declaredByPerson = new Map(declared.map((row) => [row.personId, row]));

  return Promise.all(
    options.people.map(async (person): Promise<FocusBrief> => {
      const statement = declaredByPerson.get(person.id);
      return {
        personId: person.id,
        name: person.name,
        declared: statement
          ? { focus: statement.focus, setAt: statement.setAt.toISOString() }
          : null,
        assignments: open.filter((issue) => issue.person_id === person.id),
        events: await activityFeed({
          personId: person.id,
          since: options.since,
          limit: EVENT_LIMIT,
          repository: options.repository,
        }),
      };
    }),
  );
}
