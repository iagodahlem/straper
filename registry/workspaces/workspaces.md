---
name: workspaces
description: List all active worktrees with their status
version: 1
visibility: user
triggers:
  - /workspaces
cli_command: workspaces
depends_on: []
composes: []
---

## Purpose

Show a summary of all active worktrees in the `workspaces/` directory, grouped
by status (stale / active / orphaned) with branch, PR state, and task linkage.
Surfaces cleanup candidates without removing anything.

## Arguments

```
/workspaces [--include-orphaned]
```

No required arguments. `--include-orphaned` expands the orphaned group with
extra detail. Lists all worktrees unconditionally; never destructive.

## Execution

Run the backing command — it delegates to the single worktree-enumeration
implementation (`scripts/cleanup-workspaces.sh --dry-run`) so listing and
cleanup share one source of truth for branch / PR-state / task-linkage /
staleness. It is non-destructive: nothing is ever removed.

```bash
./scripts/<agent> workspaces            # list all worktrees, grouped by status
./scripts/<agent> workspaces --include-orphaned
```

The report groups worktrees into:

- **STALE** — merged/closed PR or no recent activity (cleanup candidates)
- **ACTIVE** — open PR or live task linkage (kept)
- **ORPHANED** — no PR and no task linkage (kept by default)

…and prints a summary line with totals. To actually remove stale worktrees,
use `./scripts/cleanup-workspaces.sh` (without `--dry-run`) — a separate,
deliberate action, not part of this read-only listing.

## Examples

```
/workspaces
→ Prints STALE / ACTIVE / ORPHANED groups with branch + PR + task linkage
→ Summary: "Stale: 0  |  Active: 7  |  Orphaned: 4"
```
