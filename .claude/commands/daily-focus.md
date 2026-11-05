---
description: Walk each team member's day against their priorities, decide what to do, draft the nudges
---

# Daily focus

Two stages, with the manager in the loop between them.

- **Stage 1** — read the briefs, print one table. Stop. They read it.
- **Stage 2** — turn every person needing a decision into a concrete choice, collect answers, draft the messages, confirm before anything is sent.

Never merge the stages. Deciding what somebody should be working on is not a thing to do on a model's own initiative.

## What this reads

The `teampulse` MCP server, registered in `.mcp.json`. The tools that matter here:

| Tool | What it gives you |
|---|---|
| `people` | The roster. Canonical ids for everything else. |
| `daily_focus` | Per person: the stated focus, the Linear assignments, the window's events. |
| `judgments` | The last stored focus reading per person, if anybody ran one. |
| `assignments` | The same open issues, when you want the whole list rather than the brief. |
| `activity` | Raw events, when a brief line needs its evidence checked. |

`daily_focus` defaults to a one-day window. On a Monday, or after time off, pass `since: "3d"` — a weekend of silence is not drift.

If the MCP server is not connected, say so and stop. Do not shell out to the database.

## The three lists, and how they rank

Every person has up to three statements of what they should be on, and they do not carry equal weight:

1. **Stated focus** — a manager typed it. It is an instruction and it outranks everything below.
2. **Linear priority** — what the tracker records. Priority is Linear's own scale and is *not* an ordering: `0` means "no priority", `1` is urgent through `4` low. `daily_focus` returns the rows already sorted; do not re-sort on the number.
3. **Project / initiative** — which larger thing a piece of work belongs to. Useful for spotting work that belongs to nothing.

When the stated focus and the tracker disagree, that disagreement is the most useful thing on the page. Report it as a fact about the two lists. It is not the person's fault, and often it means nobody updated Linear.

## Reading the evidence honestly

The hard part of this command is not finding drift. It is not inventing it.

- **Events are instants.** A commit is the moment work surfaced, not an hour of effort. You cannot tell effort, hours, or diligence from this data, and you must not try.
- **Silence is not absence.** Reading code, thinking, pairing, and any meeting nobody booked all produce exactly nothing. A priority with no events against it means *the work left no trace* — say it that way every time.
- **A quiet day is a quiet day.** Say so plainly rather than manufacturing a concern to fill a row.
- **Never rank people against each other.** This whole repository refuses to; so does this command. Each person is read against their own priorities and nobody else's.
- **Check coverage before believing a zero.** A person with no GitHub handle is invisible in GitHub, and that looks identical to a quiet day. The `coverage` tool is the difference.

## Stage 1 — the table

One row per person, in roster order:

```markdown
# Daily focus — <Day> <D Mon>
_Window: <since> → now_

| Person | Should be on | Surfaced today | Reads as |
|---|---|---|---|
| <name> | <stated focus, or their top Linear priority when none is stated> | <what the events show, one clause> | <on track / no trace on X / working on Y instead / quiet> |

**Needs a decision**
- **<name>** — <what is unclear or contested, and what it blocks>
```

Then stop and print:

`<N> people need a decision. Say "go" for stage 2, or tell me what to change.`

Someone with no stated focus and no open assignments is listed as **not set up**, not as drifting. There is nothing to be off.

## Stage 2 — decide, then draft

Only on the manager's go-ahead.

### Decisions

Every person under **Needs a decision** becomes an `AskUserQuestion` question. Batch up to 4 per call, most urgent first.

Options must be concrete and actionable, 2–4 of them, the one you would pick first and labelled `(Recommended)`. Base the recommendation on the brief, not on politeness.

Good:

> **Tomer — 3 days on the publish pipeline, nothing on ENG-503 (urgent, assigned)**
> - `Ask him to land ENG-503 first (Recommended)` — it is the only urgent issue on his list and it has not moved in 3 days
> - `Restate his focus as the pipeline` — the tracker is wrong, not him; updates the stated focus to match what he is doing
> - `Leave it — ask at standup` — costs a day, right if you think Linear is stale

Bad: `Follow up` / `Ignore` / `Later`.

Do not ask about things the manager cannot act on. Do not ask more than ~8 questions in a run; take the top 8 by urgency and list the rest as FYI.

### Apply the answers

An answer that restates what somebody should be on is worth storing, so tomorrow's brief compares against it:

```bash
curl -sS -X POST http://localhost:3737/api/focus/<person-id> \
  -H 'content-type: application/json' \
  -d '{"focus": "<the new statement>"}'
```

The MCP server is read-only by design, so this is the one write in the whole command and it goes through the dashboard's own HTTP API. The server must be running (`bun run ui`). Never write a focus the manager did not choose in an answer above.

### Draft

Answers become messages. One per person who needs one, written as the manager, first person, short. A teammate reads this in Slack between two other things.

```markdown
**@<name>**
<the ask, in one or two sentences. What, and by when. No preamble.>
```

No message for anybody the manager chose to leave alone. No summary of the whole team appended to somebody's personal message.

The drafts are the **last thing in the message** — nothing after them, no "want me to send these?", no recap. Anything you need to say about them goes *above*. Ask where they go in the **next** message.

To send, find the Slack write tool with `ToolSearch("+slack post send message", max_results: 10)`.

**Never send without explicit confirmation of both the text and the recipient.**
