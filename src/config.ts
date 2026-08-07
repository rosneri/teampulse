import { DEFAULT_WORK_WEEK, WORK_WEEKS, type WorkWeek, isWorkWeek } from "./workweek";

export type Person = {
  id: string;
  name: string;
  /**
   * Every GitHub login this person works under — people.yaml may give one or a
   * list, and a personal account whose email lands on commits counts just as
   * much as the org account that opens the pull requests. Empty when they have
   * no GitHub presence at all.
   */
  githubLogins: string[];
  linear?: string;
  slack?: string;
  /** Defaults to DEFAULT_WORK_WEEK when people.yaml leaves it out. */
  workWeek: WorkWeek;
};

export type Config = {
  /** `mainRepo` is only the dashboard's default filter — it never narrows a sync. */
  github?: { org?: string; repos?: string[]; mainRepo?: string };
  slack?: { channels?: string[] };
  people: Person[];
};

export type People = {
  all: Person[];
  byId: Map<string, Person>;
  byGithub: Map<string, string>;
  byLinear: Map<string, string>;
  bySlack: Map<string, string>;
};

/**
 * people.yaml as it arrives: unvalidated, free to leave workWeek out, and free
 * to write `github` as either a single login or a list of them.
 */
type RawPerson = Omit<Person, "workWeek" | "githubLogins"> & {
  workWeek?: unknown;
  github?: unknown;
};
type RawConfig = Omit<Config, "people"> & { people?: RawPerson[] };

function parseGithubLogins(person: RawPerson): string[] {
  if (person.github === undefined || person.github === null) return [];
  const given = Array.isArray(person.github) ? person.github : [person.github];
  const logins = given
    .filter((login): login is string => typeof login === "string" && login.trim() !== "")
    .map((login) => login.trim());
  if (!logins.length || logins.length !== given.length) {
    throw new Error(
      `person "${person.id}" has github ${JSON.stringify(person.github)} — ` +
        `use a login, or a list of logins when they commit under more than one account`,
    );
  }
  return logins;
}

export async function loadConfig(path = "people.yaml"): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`${path} not found — copy people.example.yaml and fill it in`);
  }

  // The one cast in this module: YAML is checked immediately below, and every
  // consumer downstream reads the validated Config instead.
  const raw = Bun.YAML.parse(await file.text()) as RawConfig;
  if (!raw?.people?.length) throw new Error(`${path} has no people`);

  const people = raw.people.map((rawPerson): Person => {
    if (!rawPerson.id || !rawPerson.name) {
      throw new Error(`person missing id or name: ${JSON.stringify(rawPerson)}`);
    }
    if (rawPerson.workWeek !== undefined && !isWorkWeek(rawPerson.workWeek)) {
      throw new Error(
        `person "${rawPerson.id}" has workWeek ${JSON.stringify(rawPerson.workWeek)} — ` +
          `use one of: ${WORK_WEEKS.join(", ")}`,
      );
    }
    // Built field by field rather than spread, so `github` — which is replaced by
    // the parsed `githubLogins` — cannot ride along into the validated Person.
    return {
      id: rawPerson.id,
      name: rawPerson.name,
      linear: rawPerson.linear,
      slack: rawPerson.slack,
      githubLogins: parseGithubLogins(rawPerson),
      workWeek: rawPerson.workWeek ?? DEFAULT_WORK_WEEK,
    };
  });

  return { ...raw, people };
}

export function indexPeople(configuration: Config): People {
  const index: People = {
    all: configuration.people,
    byId: new Map(),
    byGithub: new Map(),
    byLinear: new Map(),
    bySlack: new Map(),
  };
  for (const person of configuration.people) {
    index.byId.set(person.id, person);
    // Every login a person commits under resolves to the same canonical id, so
    // work done from a second account is never credited to nobody.
    // GitHub logins are case-insensitive; everything else is an opaque id.
    for (const login of person.githubLogins) index.byGithub.set(login.toLowerCase(), person.id);
    if (person.linear) index.byLinear.set(person.linear, person.id);
    if (person.slack) index.bySlack.set(person.slack, person.id);
  }
  return index;
}

/** "30d" | "12w" | "6m" | "2026-01-01" -> Date. */
export function parseSince(input: string): Date {
  const rel = /^(\d+)([dwm])$/.exec(input.trim());
  if (rel) {
    const n = Number(rel[1]);
    const days = rel[2] === "d" ? n : rel[2] === "w" ? n * 7 : n * 30;
    return new Date(Date.now() - days * 86_400_000);
  }
  const abs = new Date(input);
  if (Number.isNaN(abs.getTime())) throw new Error(`bad --since: ${input}`);
  return abs;
}
