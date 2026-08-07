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
  /** Slack user id, or a list when they post from more than one account. */
  slack?: string | string[];
  /** Notion user id. Notion attributes a page to a user id, never to an email. */
  notion?: string;
  /**
   * Work email. The calendar is read by impersonating this address, and it is
   * also what a Vercel deployment is matched on when no explicit handle is given.
   */
  email?: string;
  /**
   * Vercel username, when it differs from the local part of their email. A list
   * when they deploy from more than one account, the way `github` allows.
   */
  vercel?: string | string[];
  /** Defaults to DEFAULT_WORK_WEEK when people.yaml leaves it out. */
  workWeek: WorkWeek;
};

export type Config = {
  github?: { org?: string; repos?: string[] };
  slack?: { channels?: string[] };
  people: Person[];
};

export type People = {
  all: Person[];
  byId: Map<string, Person>;
  byGithub: Map<string, string>;
  byLinear: Map<string, string>;
  bySlack: Map<string, string>;
  byNotion: Map<string, string>;
  /** Lower-cased: an address is the same address whatever case a vendor echoes back. */
  byEmail: Map<string, string>;
  byVercel: Map<string, string>;
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
      notion: rawPerson.notion,
      email: rawPerson.email,
      vercel: rawPerson.vercel,
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
    byNotion: new Map(),
    byEmail: new Map(),
    byVercel: new Map(),
  };
  for (const person of configuration.people) {
    index.byId.set(person.id, person);
    // Every login a person commits under resolves to the same canonical id, so
    // work done from a second account is never credited to nobody.
    // GitHub logins are case-insensitive; everything else is an opaque id.
    for (const login of person.githubLogins) index.byGithub.set(login.toLowerCase(), person.id);
    if (person.linear) index.byLinear.set(person.linear, person.id);
    for (const id of [person.slack ?? []].flat()) index.bySlack.set(id, person.id);
    if (person.notion) index.byNotion.set(person.notion, person.id);
    if (person.email) index.byEmail.set(person.email.toLowerCase(), person.id);
    // A Vercel deployment names its creator by username; the email is the fallback
    // for the common case where nobody bothered to write the username down.
    for (const handle of [person.vercel ?? []].flat()) index.byVercel.set(handle.toLowerCase(), person.id);
    if (person.email) index.byVercel.set(person.email.split("@")[0]!.toLowerCase(), person.id);
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
