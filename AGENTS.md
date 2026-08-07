# AGENTS.md

Conventions for anyone — human or agent — writing code in this repository.

## Do not abbreviate

Names are written out in full. This applies to variables, functions, types,
files, CSS custom properties, database columns, and comments.

```ts
// no
const cfg = await loadConfig();
const res = await fetch(url);
const pct = merged / opened;

// yes
const configuration = await loadConfig();
const response = await fetch(url);
const mergeRate = merged / opened;
```

Exceptions, and only these:

- Established domain vocabulary that is longer when expanded and universally
  read as the short form: `id`, `url`, `http`, `sql`, `api`, `json`, `yaml`,
  `csv`, `utc`, `iso`.
- Names fixed by something outside this repository: a third-party API field, a
  SQL keyword, an environment variable, a `package.json` key.
- A conventional loop index (`i`) in a loop three lines long.

Everything else gets its full word. `configuration`, not `cfg`. `repository`,
not `repo`, unless it is the GitHub API's own `repo` field. `person`, not `p`.
`previous`, not `prev`. `temporary`, not `tmp`.

## Do not reinvent the wheel

Before writing an implementation, in this order:

1. Does this need to exist at all? Speculative need means skip it.
2. Does this repository already have it? A helper, a type, a query, a pattern
   a few files over. Reuse it rather than writing a second version.
3. Does the standard library or the runtime cover it? Bun ships a YAML parser,
   a test runner, a bundler, a dev server, `.env` loading, and a SQL client.
   Use them before adding anything.
4. Does a native platform feature cover it? A CSS custom property over a theme
   context, a database constraint over an application-level check, an
   `<input type="date">` over a date-picker dependency.
5. Does an already-installed dependency solve it? Check `package.json` first.
6. Only then add a new dependency — and prefer the well-maintained, widely used
   one over the clever one.

Writing a hand-rolled version of something a package already does well is a
defect, not craftsmanship. The exception is when the package costs more than the
few lines it replaces; say so in a comment when you make that call.

## Be strict with types

TypeScript runs in `strict` mode and that is the floor, not the goal.

- **No `any`.** Not in a parameter, not in a return, not behind a cast. When a
  value genuinely arrives unknown — a parsed JSON body, a third-party callback —
  type it `unknown` and narrow it before use.
- **No `as` to silence the compiler.** A cast is a claim you are making on the
  compiler's behalf; it needs a comment saying why it holds. Prefer a type guard,
  a schema check at the boundary, or fixing the type.
- **No non-null assertion (`!`) where a check is possible.** Use it only where
  the invariant is enforced two lines above and obvious.
- **Model the domain so illegal states cannot be written.** Unions over loose
  strings (`WorkType`, `Source`, `ActivityType` in `src/types.ts`), `null` where
  a value is genuinely absent, and never a sentinel like `-1` or `""` standing in
  for "no value". An unclassified work type is `null` and is reported as a
  visible gap — never folded into a bucket to make a type simpler.
- **Validate at trust boundaries, then trust.** Everything crossing into the
  program — a query string, an API response, a YAML file — is checked once at the
  edge and typed from there inward. Inside the program, types are believed.
- **Infer inside, annotate at the edges.** Exported functions, module boundaries,
  and public types get explicit annotations. Local variables do not need one when
  inference already says it.

## Do not repeat yourself

One fact, one home.

- All SQL lives in `src/metrics.ts`. A second copy of a query, however small, is
  a second thing to keep correct. The HTTP layer and the command line layer read
  the same functions.
- Handles are mapped to a canonical `person_id` in `src/config.ts` and nowhere
  else. A lookup written a second time is a bug waiting for the two copies to
  drift.
- Formatting rules live in one module per surface, not inline at every call site.
- The palette is defined once as CSS custom properties and referenced by role.

The counterweight: **duplication is cheaper than the wrong abstraction.** Two
things that merely look alike today are not one thing. Wait for the third
occurrence, and for the shared meaning to be real, before extracting.

## You are not gonna need it

Build what is asked for and nothing beyond it.

- No interface with a single implementation, no factory for a single product, no
  configuration option for a value that has never changed.
- No scaffolding "for later" — later can scaffold for itself, with the benefit of
  knowing what it actually needs.
- No abstraction layer added in anticipation of a second use case that does not
  exist yet.
- No feature flag, no plugin system, no generic pipeline until a second concrete
  case forces it.

Deletion beats addition. The shortest change that fully solves the problem is the
right change — provided you understood the problem first. A small diff in the
wrong place is not laziness, it is a second bug.

## Work with established paradigms

Use the patterns the industry already has names for, so the next reader
recognises the shape without being told.

### Domain-driven design

- The domain vocabulary in `people.yaml`, `src/types.ts`, and the database is
  the *ubiquitous language*. `Activity`, `Person`, `WorkType`, `OpenIssue`,
  `personId` mean one thing everywhere. Do not invent a synonym in a new layer.
- `Activity` is the domain model every source collapses into. Source-specific
  vocabulary — a GitHub pull request, a Linear issue, a Slack message — stays
  inside its collector in `src/sources/` and never leaks downstream.
- Keep the layers separate, as the README states: facts are SQL over `activity`;
  judgment writes only to `ai_output`. A change that blurs that boundary is
  wrong even when it works.
- `person_id` is the canonical identity. Source handles are translated at the
  boundary, in `src/config.ts`, and nowhere else.

### SOLID

- **Single responsibility.** One collector per source. All SQL lives in
  `src/metrics.ts`; nothing else in the project writes queries. Presentation
  formats, it does not compute.
- **Open/closed.** Adding a source means adding a collector that returns
  `Activity[]`. Nothing downstream changes. Preserve that property.
- **Liskov substitution.** Every collector honours the same contract: return
  `Activity[]`, throw on failure, never write to the database directly.
- **Interface segregation.** A consumer imports the metric functions it needs,
  not a god object that exposes everything.
- **Dependency inversion.** Modules depend on the `Activity` shape in
  `src/types.ts`, not on the shape of a vendor API response.

## Testing

Non-trivial logic — a branch, a parser, a classifier, a query — leaves one
runnable check behind in `test/`. No frameworks beyond `bun test`, no fixtures
unless the test genuinely needs them. Trivial one-liners need no test.

## Comments

Comment the decision, not the mechanism. A comment explaining *why* a
simplification is acceptable, or what a query attributes to whom, earns its
place. A comment restating the line below it does not.
