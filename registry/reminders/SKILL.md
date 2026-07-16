---
name: reminders
description: Personal follow-up ledger — track things that shouldn't get lost in a daily memory log, with a morning Telegram digest of open items
version: 1
visibility: user
triggers:
  - /reminders
cli_command: reminder
depends_on: []
composes: []
---

## Purpose

A durable, git-tracked ledger of small personal follow-ups — things the user (or the agent, on their behalf) wants to not forget, but that don't rise to the level of a `TASK-XXX` (no worker, no branch, no PR — just "someone should check on this"). Entries live in `memory/reminders.json` at the workspace root (canonical data, alongside the rest of `memory/`'s durable content — not skill-owned `.state/`, since this is real personal data meant to survive across machines and sessions). The scheduler job `jobs/reminders-digest/` reads the same ledger every weekday morning and pushes the open list to the user through [[notify]], so reminders surface even in a session that never gets opened.

Note: the skill is named `reminders` (directory, trigger, `INDEX.md` entry — plural), but the actual CLI verb is singular: `<agent> reminder <verb>`, since each invocation acts on one reminder or one flat list of them.

## Arguments

```
<agent> reminder add "<text>" [--source "<text>"]
<agent> reminder done <id>
<agent> reminder list [--all]
```

| Verb | Effect |
|------|--------|
| `add "<text>" [--source "<text>"]` | Appends a new `REM-NNN` entry with `status: open`. Prints the assigned id. |
| `done <id>` | Sets `status: done` and stamps `done_at`. Errors clearly if the id doesn't exist or is already marked done. |
| `list [--all]` | Prints open reminders (id, text, source, added date). `--all` also includes done ones. No open reminders prints a plain "No open reminders." — never an error. |

`<id>` is case-insensitive on input (`rem-001` and `REM-001` both resolve), always printed upper-case as `REM-NNN` (zero-padded, incrementing). This is deliberately NOT the bare `R1`/`R2` single-letter-plus-digit shape banned as a workspace sub-item reference (see `notify_scrub`'s `[AFRT][0-9]+` strip in `skills/notify/notify.sh`), and NOT `TASK-`/`FD-`-prefixed either, since those get expanded by `notify_gloss_ids` (which only matches `(TASK|FD)-[0-9]+`) — a bare `REM-NNN` in a digest is left alone, not treated as a task/design reference to look up.

## Execution

1. `<agent> reminder add "<text>" [--source "<text>"]` — reads `memory/reminders.json` (missing file treated as `[]`), computes the next `REM-NNN` id from the highest existing numeric suffix, appends `{ id, text, added_at: <now ISO>, source, status: "open", done_at: null }`, writes the file back pretty-printed.
2. `<agent> reminder done <id>` — looks up the entry by id (case-insensitive), throws if missing or already `done`, otherwise sets `status: "done"` and `done_at: <now ISO>`.
3. `<agent> reminder list [--all]` — filters to `status == "open"` (or everything, with `--all`), printing one line per entry: `REM-NNN [done] — <text> (source: <source>) [added YYYY-MM-DD]`.
4. Every mutating command (`add`, `done`) takes a short-lived file lock (`memory/reminders.json.lock`, same busy-wait pattern as `skills/task/task.js`) around its read-modify-write, since `<agent> reminder ...` invocations are separate OS processes and can race across concurrent sessions.

The morning digest (`jobs/reminders-digest/run.sh`) is a separate, read-only consumer of the same ledger — it never writes to `memory/reminders.json`; adding/closing reminders stays this CLI's job.

## Examples

```
<agent> reminder add "Follow up with a reviewer on PR #482" --source "review thread"
  -> Added REM-003: Follow up with a reviewer on PR #482

<agent> reminder list
  -> REM-001 — Revisit the caching layer ownership before scheduling the follow-up work. (source: pulse-archive recovery pass.) [added 2026-07-06]
     REM-002 — Confirm whether the metadata refresh invalidates the existing test runs — likely moot; verify-and-drop. (source: pulse-archive recovery pass.) [added 2026-07-06]

<agent> reminder done REM-001
  -> REM-001: marked done

<agent> reminder list --all
  -> includes REM-001 [done] alongside the still-open REM-002
```
