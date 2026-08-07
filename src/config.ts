export type Person = {
  id: string;
  name: string;
  github?: string;
  linear?: string;
  slack?: string;
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
};

export async function loadConfig(path = "people.yaml"): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`${path} not found — copy people.example.yaml and fill it in`);
  }
  const cfg = Bun.YAML.parse(await file.text()) as Config;
  if (!cfg?.people?.length) throw new Error(`${path} has no people`);
  for (const p of cfg.people) {
    if (!p.id || !p.name) throw new Error(`person missing id or name: ${JSON.stringify(p)}`);
  }
  return cfg;
}

export function indexPeople(cfg: Config): People {
  const idx: People = {
    all: cfg.people,
    byId: new Map(),
    byGithub: new Map(),
    byLinear: new Map(),
    bySlack: new Map(),
  };
  for (const p of cfg.people) {
    idx.byId.set(p.id, p);
    // GitHub logins are case-insensitive; everything else is an opaque id.
    if (p.github) idx.byGithub.set(p.github.toLowerCase(), p.id);
    if (p.linear) idx.byLinear.set(p.linear, p.id);
    if (p.slack) idx.bySlack.set(p.slack, p.id);
  }
  return idx;
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
