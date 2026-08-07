# teampulse

Pulls GitHub, Linear and Slack into one `activity` table so team activity can be
counted, compared against its own history, and read in one place.

Two layers, kept strictly apart:

- **Facts** — every number comes from SQL over `activity`. Deterministic, free,
  reproducible. No model is involved.
- **Judgment** — the AI layer writes only to `ai_output`, stamped with a hash of
  exactly what it was shown. It never touches `activity`.

## Setup

```bash
cp .env.example .env            # fill in LINEAR_API_KEY, SLACK_USER_TOKEN
cp people.example.yaml people.yaml
bun install
bun run db:up                   # Postgres 18 in Docker + migrations
bun test                        # sanity check, against its own database
bun run ui                      # http://localhost:3737
```

GitHub needs no token — it shells out to an authenticated `gh`.

### people.yaml

The identity map. One person, three handles, one canonical id:

```yaml
github:
  org: YourOrg
slack:
  channels: [eng, product]
people:
  - id: maya
    name: Maya
    github: mayagh
    linear: 6b1f…            # Linear user UUID
    slack: U01ABCDEF
    workWeek: sunday-thursday  # or monday-friday; this is the default
```

`github` takes one login or a list — a person who commits from a second account
gets both credited to the same canonical id:

```yaml
  - id: sam
    name: Sam
    github: [sam-work, sam-personal]
```

`workWeek` is what the "hide weekends" toggle reads. `sunday-thursday` puts the
weekend on Friday and Saturday; `monday-friday` puts it on Saturday and Sunday.
Anything else fails the load with the list of valid values rather than guessing.

Handles are looked up here and nowhere else, so `person_id` in the database is
always the canonical id. `people.yaml` is gitignored — the example file is the
one that's committed.

Finding the ids:

```bash
# Linear user UUIDs
curl -s https://api.linear.app/graphql -H "authorization: $LINEAR_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"query":"{ users { nodes { id name email } } }"}' | jq

# Slack user IDs
curl -s "https://slack.com/api/users.list" -H "authorization: Bearer $SLACK_USER_TOKEN" \
  | jq '.members[] | {id, name: .profile.real_name}'
```

## Use

```bash
bun run ui                            # http://localhost:3737
```

The web UI is the only controller. Everything happens there:

- **Sync now** pulls all three sources for the selected window and reports what
  each one collected. A failing source is reported and skipped — one expired
  token doesn't cost you the other two.
- **Date range** scopes every number, chart and table on the page.
- **Repository** narrows the GitHub side to one repository, opening on
  `github.mainRepo` from `people.yaml`. Only GitHub events belong to a
  repository; Linear issues and Slack messages happen in none, so they are
  counted under every repository rather than dropped — otherwise picking one
  would zero out intake, bugs and conversation, and read as if the team had
  stopped talking. Pick **All repositories** for the unscoped view.
- **Hide weekends**, on by default, drops non-working days from the activity
  strip *per person*, using each person's `workWeek` from `people.yaml`. A
  Friday off in Tel Aviv is an ordinary working day in Berlin, so a day only
  leaves the axis when it is a weekend for everybody.
- **Selecting a person** opens their stats and their last 40 events.

`PORT` overrides the port. The server binds localhost and has no authentication;
`POST /api/sync` changes state, so it needs an auth layer before it is ever
exposed beyond the machine it runs on.

There is no command line interface. `src/server.ts` is the entry point.

## What's measured

| Number | Definition |
|---|---|
| PRs merged | `pr_merged` events, credited to the PR author |
| Reviews given | `pr_reviewed` events, credited to the reviewer, timestamped at actual submission |
| Median review wait | PR opened → **first** review, credited to the PR's author: how long they wait to get unblocked |
| Issues completed | Linear issue reaching a completed state, credited to the assignee |
| Active days | Distinct days with any event from any source |
| Shipped mix | Merged PRs by work type |
| Intake mix | Created Linear issues by work type |
| Bugs per delivery | Bugs reported ÷ PRs merged. Rising = quality outrunning delivery |
| Fix share | Share of merged PRs that were fixes rather than new work |

Work type (`bug` / `feature` / `improvement` / `chore`) is classified
deterministically: explicit labels first, then conventional-commit title
prefixes. Anything unrecognised stays `null` and is reported as
**unclassified** rather than folded into a bucket — a wrong ratio is worse than
a visible gap.

Shipped mix and intake mix are counted over different event types on purpose, so
a PR and the Linear issue it closes are never both counted as one delivery.

## Known behavior

`github.org` is a hard boundary. With `org: YourOrg` set, a merged PR in a
personal repo or a second org is not counted and never will be — the collector
searches `org:YourOrg` and nothing else. If the totals look low, that is the
first thing to check:

```bash
# what the configured scope sees
gh api -X GET search/issues -f advanced_search=true -f per_page=1 \
  -f q="is:pr is:merged org:YourOrg merged:>=2026-07-08 author:someone" --jq .total_count

# what exists anywhere the token can see
gh api -X GET search/issues -f advanced_search=true -f per_page=1 \
  -f q="is:pr is:merged merged:>=2026-07-08 author:someone" --jq .total_count
```

A gap between the two is scope, not a bug. Widen it with `repos:` or drop `org:`.

Only people listed in `people.yaml` are searched, and only handles that are
correct. A wrong GitHub login reports zero rather than failing, so a person
sitting at zero across every column is worth checking before it is believed.


Narrowing the scope in `people.yaml` (adding `github.org`, trimming `repos`,
removing a person) does **not** retroactively remove rows an earlier, wider sync
already wrote — `sync` only inserts. Numbers will keep counting the old scope
until you clear them. The activity table is a rebuildable cache, so the fix is to
drop the out-of-scope rows and re-sync:

```sql
delete from activity
where source = 'github' and meta ->> 'repo' not like 'YourOrg/%';
```

## What's deliberately absent

- **No cross-person leaderboard.** Deltas compare a person against their own
  prior period, never against a teammate. PR counts reward small PRs and become
  political the moment anyone learns they're ranked.
- **No LOC or commit counts.**
- **No sentiment analysis on Slack.**
- **No webhooks.** A poll is enough and needs no infrastructure.

## Layout

```
prisma/schema.prisma   activity, open_issue, ai_output, sync_run
src/types.ts           the Activity shape every source collapses into
src/worktype.ts        deterministic bug/feature/improvement/chore classifier
src/commitmessage.ts   whether a commit already arrived through a merged PR
src/workweek.ts        which days a person works, and so which are their weekend
src/config.ts          people.yaml: parsed, validated, indexed by handle
src/sources/*.ts       one collector per source, each returns Activity[]
src/sync.ts            runs the collectors, reports what each one did
src/metrics.ts         all SQL; nothing else in the project writes queries
src/server.ts          the entry point: HTTP API and the web UI
src/mcp.ts             read-only MCP server over the same metric functions
src/ui/*               React dashboard — Tailwind, Headless UI, Recharts
```

Adding a source means writing one collector that returns `Activity[]`. Nothing
downstream changes.

Conventions for anyone writing code here are in [AGENTS.md](AGENTS.md).

## MCP

`src/mcp.ts` exposes the same metric functions the dashboard reads as MCP tools
over stdio, so a model can query the data without being handed a database
connection. `.mcp.json` registers it for MCP clients that read one:

```json
{ "mcpServers": { "teampulse": { "command": "bun", "args": ["run", "src/mcp.ts"] } } }
```

Tools: `people`, `team_stats`, `person_stats`, `review_waits`, `shipped_mix`,
`intake_mix`, `bug_ratio`, `daily_counts`, `stale_issues`, `activity`.

It is **read-only on purpose**. There is no sync tool: pulling from GitHub,
Linear and Slack is a person's decision, and the UI is where it is made. Every
number a model sees comes from the SQL in `src/metrics.ts`, so the model and the
dashboard can never disagree.

## Checks

```bash
bun run check      # typecheck, then lint, then tests
bun run typecheck  # TypeScript 7
bun run lint       # oxlint
bun test
```

All three run on **pre-push**, in parallel, via lefthook (`lefthook.yml`). The
hooks install themselves through the `prepare` script on `bun install`, or by
hand with `bunx lefthook install`. The test job needs the Postgres container up.
To push past a failure — a spike branch, a work-in-progress share — use
`git push --no-verify`.

Type checking runs on **TypeScript 7** (`tsc --noEmit`) and is clean. Linting is
**oxlint**, configured in `.oxlintrc.json`: correctness is an error, everything
else a warning. Two rules are off with a reason — `react-in-jsx-scope`, which the
automatic JSX runtime makes obsolete, and `no-await-in-loop`, because the
collectors serialise deliberately to stay inside API rate limits.
`typescript/no-explicit-any` is a **warning**, not an error: the three collectors
still carry `any` at their API boundaries, which AGENTS.md forbids and the lint
run keeps visible until it is paid down.

The suite truncates tables, so it runs against its **own** database — a sibling
`<name>_test`, created and migrated automatically by `test/setup.ts` before
anything imports `src/db.ts`. Set `TEST_DATABASE_URL` to point somewhere else.
The preload refuses to run if the test URL resolves to `DATABASE_URL`.

Coverage is enforced at **100%** (`coverageThreshold = 1.0` in `bunfig.toml`)
across every file the suite loads: `config.ts`, `db.ts`, `metrics.ts`,
`worktype.ts`, `workweek.ts`. Generated Prisma client code is excluded. The
collectors, the HTTP layer and the React UI are not loaded by the suite and so
are not part of that number — they are covered by running the thing.
