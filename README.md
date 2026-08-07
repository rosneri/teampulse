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
bun test                        # sanity check against the local DB
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
```

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
bun run sync --since 30d              # all three sources
bun run sync --source github          # one at a time
bun run team --since 30d              # team board
bun run person maya --since 30d       # stats + timeline for one person
```

A failing source logs and is skipped — one expired token doesn't cost you the
other two.

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
src/sources/*.ts       one collector per source, each returns Activity[]
src/metrics.ts         all SQL; nothing else in the project writes queries
src/cli.ts             sync / team / person
```

Adding a source means writing one collector that returns `Activity[]`. Nothing
downstream changes.
