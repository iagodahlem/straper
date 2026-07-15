---
name: task
description: Cross-session task tracking with status lifecycle, PR linking, worker management, and validation
version: 1
visibility: user
triggers:
  - /task
backing_script: task.js
cli_command: task
depends_on: []
composes: []
---

## Purpose

Manage cross-session task tracking. Tasks are JSON files in `tasks/` at the workspace root that track status, PRs, branches, worktrees, workers, blockers, dependencies, and a chronological log. The log is the primary cross-session communication channel.

## Arguments

```
/task create <title>                                    Create a new task
/task list [--status <status>] [--has-blockers]         List tasks with optional filters
/task status <ID> <new-status> [--note <message>]       Change task status
/task log <ID> <message>                                Add a log entry
/task design <ID> <FD-ID|none> [--note <message>]       Link or unlink a feature design
/task sub-item add <ID> <item>                          Track a feature design sub-item
/task sub-item remove <ID> <item>                       Remove a tracked sub-item
/task worker set <ID> <worker-id> [options]              Set or update a worker
/task worker remove <ID> <worker-id> [--note <message>] Remove a worker
/task blocker add <ID> <reason>                         Add a blocker
/task blocker remove <ID> <reason>                      Remove a blocker
/task sync-prs                                          Refresh PR statuses from GitHub
```

### Status values

`backlog` | `in_progress` | `blocked` | `in_review` | `done`

### Worker options (for `worker set`)

| Flag | Description |
|------|-------------|
| `--sub-item <item>` | Feature design sub-item (e.g., A1) |
| `--provider <claude\|codex>` | Worker provider |
| `--profile <fast\|strong>` | Worker profile |
| `--status <status>` | Worker status: planned, running, blocked, stopped, done, failed |
| `--repo <repo>` | Repository name |
| `--branch <branch>` | Branch name |
| `--worktree <path>` | Worktree path |
| `--model <model>` | Model ID |
| `--started-at <iso>` | Start timestamp |
| `--updated-at <iso>` | Update timestamp |
| `--note <message>` | Log note |

## Execution

All commands invoke the backing script via Node.js. The wrapper script at `scripts/task` handles path resolution.

### create

```bash
node skills/task/task.js create "Title here"
```

Creates a new `TASK-###.json` in `tasks/` with auto-incremented ID, `backlog` status, and empty arrays for all collection fields. Validates the file after creation.

### list

```bash
node skills/task/task.js list [--status in_progress] [--has-blockers]
```

Lists all task files from `tasks/`. Optionally filter by status or presence of blockers. Shows ID, status, priority, title, open PRs, blockers, design, and worker count.

### status

```bash
node skills/task/task.js status TASK-001 in_progress --note "Starting work"
```

Changes task status with transition validation. Appends a log entry with the transition and optional note. Valid transitions are enforced (e.g., `backlog` can go to `in_progress`, `blocked`, or `done`).

### log

```bash
node skills/task/task.js log TASK-001 "Implemented API pagination"
```

Appends a timestamped log entry to the task. Uses file locking for concurrent access safety.

### design

```bash
node skills/task/task.js design TASK-001 FD-001
node skills/task/task.js design TASK-001 none
```

Links a feature design ID to the task, or clears it with `none`. Appends a log entry.

### sub-item

```bash
node skills/task/task.js sub-item add TASK-001 A5
node skills/task/task.js sub-item remove TASK-001 A5
```

Adds or removes a feature design sub-item reference. Sub-items must match the pattern `[A-Z]+[0-9]+`.

### worker

```bash
node skills/task/task.js worker set TASK-001 worker-fd001-a5 --sub-item A5 --provider codex --profile strong --status running --repo web --branch yourname/feature-x --worktree workspaces/web--yourname--feature-x
node skills/task/task.js worker remove TASK-001 worker-fd001-a5
```

Sets or removes a worker record. Setting a worker also auto-tracks the sub-item, worktree, and branch on the task. Uses file locking.

### blocker

```bash
node skills/task/task.js blocker add TASK-001 "Waiting on backend review"
node skills/task/task.js blocker remove TASK-001 "Waiting on backend review"
```

Adds or removes a blocker string. Appends a log entry on change.

### sync-prs

```bash
node skills/task/task.js sync-prs
```

Refreshes PR statuses on all non-`done` tasks from GitHub: for each PR that
isn't already `merged`/`closed`, queries `gh pr view` and maps GitHub
state + review decision to our status (`open`/`approved`/`changes_requested`/
`merged`/`closed`), writing through the validated, file-locked update path.
No-ops gracefully if `gh` is missing or unauthenticated. Run automatically at
session start.

### validate

The validation script checks all task JSON files against the schema:

```bash
node skills/task/validate.js              # Validate all tasks
node skills/task/validate.js <file>       # Validate a specific file
```

## Data vs Logic

This skill follows the data-vs-logic separation pattern:

- **Logic** (portable, lives in `skills/task/`): `task.js` (CLI), `validate.js` (validation), `schema.json` (data schema), `task.md` (this definition)
- **Data** (workspace-specific, lives at root): `tasks/TASK-001.json`, `tasks/TASK-002.json`, etc.

When exporting this skill to another workspace, you get the tooling. The target workspace creates an empty `tasks/` directory and it works immediately.

## Examples

```
/task create "Implement SCIM custom attributes"
  -> Created TASK-012: Implement SCIM custom attributes

/task list --status in_progress
  -> TASK-010  in_progress  medium    Skills Architecture (1 PR open, FD-005, 2 workers)

/task status TASK-010 in_review --note "All sub-items complete"
  -> TASK-010: status in_progress -> in_review

/task log TASK-010 "Completed A9: migrated task skill to skills/task/"
  -> TASK-010: appended log entry

/task worker set TASK-010 worker-fd005-a9 --sub-item A9 --provider claude --profile strong --status done --repo <agent>
  -> TASK-010: worker set worker-fd005-a9
```
