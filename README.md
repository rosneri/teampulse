# teampulse

Pulls GitHub, Linear and Slack into one `activity` table so team activity can be
counted, compared against its own history, and read in one place.

Two layers, kept strictly apart:

- **Facts** — every number comes from SQL over `activity`. Deterministic, free,
  reproducible. No model is involved.
- **Judgment** — the AI layer writes only to `ai_output`, stamped with a hash of
  exactly what it was shown. It never touches `activity`. It runs on the
  Anthropic API through the Vercel AI SDK, against a Zod schema that describes
  each field it is allowed to fill in — see `src/judgment.ts`.

There is one row that is neither, and it lives in `person_focus`: what a manager
says somebody should be on. Not collected from a source and not a model's
opinion — an intention, typed by a person. It is the only thing in this database
a human writes directly, and the focus card is what compares it against the
other two.

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

The web UI is the only controller. It opens on the last **30 days**, **all
repositories**, with **hide weekends** on, unless a default view has been saved.
Everything happens there:

- **Sync now** pulls all three sources for the selected window and reports what
  each one collected. A failing source is reported and skipped — one expired
  token doesn't cost you the other two.
- **Date range** scopes every number, chart and table on the page.
- **Repository** narrows the GitHub side to one repository. Only GitHub events
  belong to a repository; Linear issues and Slack messages happen in none, so
  they are counted under every repository rather than dropped — otherwise
  picking one would zero out intake, bugs and conversation, and read as if the
  team had stopped talking.
- **Save as default** pins the current date range, repository and weekend toggle
  as what the dashboard opens on. **Reset** goes back to the built-in view.
  Only the button writes: changing a filter is not the same as choosing a
  default, and a page that quietly remembered every fiddle would be hard to get
  back from. The preference lives in the browser's own storage — it is one
  person's habit on one machine, not a fact about the team, so it belongs in
  neither the database nor `people.yaml`. A stored value that is malformed or
  from an older version is discarded rather than half-applied.
- **Hide weekends**, on by default, drops non-working days from the activity
  strip *per person*, using each person's `workWeek` from `people.yaml`. A
  Friday off in Tel Aviv is an ordinary working day in Berlin, so a day only
  leaves the axis when it is a weekend for everybody.
- **Work hours** shows when each person is active, one row per person, one cell
  per hour of the day. Hours are read in the browser's own timezone, and each
  row is shaded against that person's own busiest hour — the grid answers *when*
  somebody works, not how much. Hide weekends applies here too.
- **Day shape** takes one person at a time and draws every working day: the
  blocks are when they were actually going, the gaps between them are the
  breaks, and the coloured marks say what the work was — code, review, chat,
  issues, docs, ship, meetings, and the table view spells out each block's start and end. A silence
  longer than an hour starts a new block — `DEFAULT_BREAK_MINUTES` in
  `src/metrics.ts` is the knob. Events are instants, so a block is the visible
  edge of the work: an hour spent reading code emits nothing and reads as lunch.
- **Claude Code** shows tokens, cost, sessions and accepted edits per person from
  Anthropic's usage report. It is reported by whole day, so it carries no time of
  day and deliberately never reaches the two charts above.
- **Daily focus** answers the one question the rest of the page does not: is each
  person on the right thing *today*. It has its own window — today, three days,
  or the week — because everything below it opens on a month.

  Three lists sit side by side per person, and they do not carry equal weight:

  1. **Stated focus** — what you typed into the field. It is neither collected
     nor inferred, it is an instruction, and it outranks the tracker when the
     two disagree. It saves on the button only: a half-typed sentence is not an
     instruction, and a field that saved as you thought would make it one.
  2. **Assigned in Linear** — their open issues, most important first. Linear's
     priority is a set of names and not an ordering — `0` is *no priority*, then
     1 urgent through 4 low — so the rows arrive sorted and the number is never
     sorted on again.
  3. **What surfaced** — their events in the window.

  **Check focus** is the second button here that spends money. It asks a model
  how the three lines up and appends the reading to `ai_output`, never to
  `activity`. It reports what it cannot see as loudly as what it can: a priority
  with no events against it means *the work left no trace* — reading code,
  thinking and pairing all emit nothing — and it answers **not enough signal**
  rather than inventing a verdict out of two events. It reads one person against
  their own priorities and nobody else's; there is no second person in the prompt.

  Someone with nothing stated and nothing assigned is not judged at all, and
  costs nothing: there is no pair of lists to compare.

  **Draft daily message** is the third, and the only thing on this dashboard
  written to leave it: the end-of-day update you post to your team, drafted from
  every brief at once and shown as the exact text the Copy button hands over.
  It is organised by the work rather than by person — a section per person is a
  scoreboard, and nothing here ranks people — and it is numbered in one running
  sequence across sections, so a teammate can answer "re 3" and mean one thing.
  The numbering happens when the text is rendered, not in the model's head.

  Its row in `ai_output` is the only judgment about nobody in particular, so its
  `person_id` is null rather than a placeholder id. A window where nothing
  surfaced anywhere produces no message and costs nothing — there is no day to
  write up. It drafts and stops: teampulse has never sent anything anywhere, and
  whether a word of it is true enough to post is your call.

- **Judgment** is the one card on the page no number comes from. **Run judgment**
  asks a model two questions about each person — what their window was about, and
  what kind of work the unclassified merged PRs and created issues were — and
  appends the answers to `ai_output`. It never writes `activity.work_type`, so a
  proposal stays a proposal and every mix keeps reporting its visible gap. Each
  call is keyed by a hash of the exact prompt, so asking twice about the same
  events answers from the first run instead of paying again, and one person
  failing is reported in their own entry rather than costing you the others. It
  is the only button here that spends money, which is why nothing but a click
  runs it — `POST /api/judge?since=30d` is the same action from a terminal.
- **Coverage** shows how many events each source produced per person. A source
  that is configured and reports zero is either a quiet week or a blind spot —
  everywhere else on the page those look identical.
- **Selecting a person** opens their stats and their last 40 events.

`PORT` overrides the port. The server binds localhost and has no authentication;
`POST /api/sync`, `POST /api/judge`, `POST /api/judge/focus`,
`POST /api/judge/daily-message` and
`POST|DELETE /api/focus/:id` change state, so they need an auth layer before any
of them is ever exposed beyond the machine it runs on.

There is no command line interface. `src/server.ts` is the entry point.

### The daily review

`/daily-focus` (in `.claude/commands/`) is the interactive version of the focus
card, for walking the team one person at a time rather than reading a page. It
runs in two stages with you in the middle: it prints one table and stops, and
only on your go-ahead does it turn each person into a concrete choice, apply the
answers, and draft the messages. It reads through the MCP server below and
writes only what you chose, through `POST /api/focus/:id` — so `bun run ui` has
to be running for that step.

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

## What this does and does not see

Every number here is a floor, not a census. The collectors are honest about
where they stop, and the **Coverage** card exists so a blind spot looks
different from a quiet week. The known limits, per source:

- **GitHub** — pull requests, issues, review submissions, review-thread and
  conversation comments, commits on the default branch, deployments, and
  workflow runs a person started by hand. Not counted: commits on branches that
  never merged, and anything GitHub's search truncates (it caps at 1000 results
  per query, so a very wide window silently loses the tail). A commit whose
  author GitHub cannot resolve to a login belongs to nobody.
- **Linear** — issues created and completed, and comments. State changes,
  assignment changes, estimates and project updates are not events here. The
  open-assignment snapshot also carries each issue's project and the initiative
  that project belongs to; initiatives are a paid-plan feature, so on a workspace
  without them that column is simply null and the sync does not fail. "No
  initiative" and "this workspace has no initiatives" are the same absence here.
- **Slack** — the hard ceiling: a user token only reaches conversations *you*
  are in. Anything a teammate says in a channel you never joined, or in a DM
  with someone else, is invisible and always will be. Reactions, file uploads
  and huddles are not counted either.
- **Notion** — pages carry `created_by` and `last_edited_by` and nothing
  between. Ten edits collapse into one row, and an earlier editor who was later
  overwritten leaves no trace. Comments have no workspace-wide API and are not
  collected.
- **Calendar** — meetings the person did not decline, excluding all-day entries
  and anything they marked as free. This is the only source with a real
  duration, which is why it is also the only one that can say a person was
  occupied rather than that they surfaced.
- **Claude Code** — daily totals only, and only for actors on API billing:
  anyone signed in to Claude Code through a claude.ai subscription does not
  appear in the report at all.
- **Everything else is an instant.** A commit is the moment work surfaced, not
  the hour that produced it, so an hour of reading code is indistinguishable
  from an hour of lunch. The day-shape card says so on its face.

Two more general limits worth knowing: a person with no handle for a source is
invisible in it — the Coverage card prints **not set up** rather than a zero —
and nothing is backfilled automatically, so a window you have never synced is
empty rather than wrong.

## Layout

```
prisma/schema.prisma   activity, open_issue, person_focus, ai_output, sync_run
src/types.ts           the Activity shape every source collapses into
src/worktype.ts        deterministic bug/feature/improvement/chore classifier
src/priority.ts        Linear's priority scale, which is names and not an ordering
src/focus.ts           the daily brief: stated focus, assignments, what surfaced
src/judgment.ts        the AI layer: Zod schemas, prompts, writes to ai_output
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
`intake_mix`, `bug_ratio`, `daily_counts`, `hourly_counts`, `day_sessions`,
`day_marks`, `coverage`, `ai_usage`, `judgments`, `stale_issues`, `assignments`,
`daily_focus`, `activity`.

`daily_focus` returns the three lists the focus card shows and deliberately does
not judge them: the reading costs money, and only a person can spend it. Its
stated focus is the one value in the whole MCP surface that nobody measured —
it is text a manager typed, and it is null for anybody nobody has typed one for.

`judgments` is the one tool whose answers are not facts: it reads back what the
AI layer stored, and its own description says so, so a model reading it knows not
to add a proposed work type to a count that deliberately excludes it.

It is **read-only on purpose**. There is no sync tool and no way to set a focus:
pulling from GitHub, Linear and Slack is a person's decision, and so is saying
what somebody should be working on. The UI is where both are made — the
`/daily-focus` command writes a focus through `POST /api/focus/:id`, and only
one you picked out of an answer. Every number a model sees comes from the SQL in
`src/metrics.ts`, so the model and the dashboard can never disagree.

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
