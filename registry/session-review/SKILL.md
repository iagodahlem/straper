---
name: session-review
description: End-of-session review — summarize progress, update tracking, flag loose ends
version: 1
visibility: user
triggers:
  - /session-review
  - hook:SessionEnd
cli_command: session-review
depends_on:
  - memory
  - task
  - session
  - fd
composes: []
---

## Purpose

Run the end-of-session review workflow: summarize work done, validate task tracking, flag blockers and loose ends, and optionally execute the session-end checklist. Invoked manually at the end of a session or automatically by the `SessionEnd` hook.

## Arguments

```
/session-review [--run-session-end] [--dry-run]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `--run-session-end` | no | Execute `./scripts/session-end.sh` as part of the review (validates tasks, memory, worktrees). |
| `--dry-run` | no | Preview what would happen without making any changes. |

## Execution

1. Run `./scripts/<agent> session-review` with the provided arguments to generate the session review prompt.
2. Review active tasks: check status, linked feature designs, worker state, and recent log entries.
3. Review worktrees: identify stale or untracked branches.
4. Call out any blockers, missing task logs, or untracked branches/worktrees.
5. If `--run-session-end` is set, confirm whether `./scripts/session-end.sh` succeeded. This script enforces:
   - Task files validate against the schema
   - At least one active task has a log entry for today
   - Active tasks with blockers have a log entry for today
   - Today's memory file exists
   - Task worktree references exist on disk

## Examples

```
/session-review
→ Runs end-of-session review: summarizes active tasks, flags loose ends, no session-end script

/session-review --run-session-end
→ Runs review and executes ./scripts/session-end.sh checklist

/session-review --dry-run
→ Shows what would be reviewed and committed without making changes
```

## Composition

This skill declares no `composes` entries. The end-of-session housekeeping that a `review-complete` pipeline would have driven — auto-commit sweep, daily-memory check, task-continuity check — is implemented directly in bash by `scripts/session-end.sh`, not via the composition engine. See that script's numbered phases for the actual checks; keep them in sync with this skill's `## Execution` section if either changes.

## Graceful Degradation

If `memory`, `task`, or `session` skills are unavailable, the review still runs. Missing skills are reported as warnings.
