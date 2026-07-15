---
name: auto-commit
description: Group and commit workspace changes by category — runs on workspace file edits and at session end
version: 2
visibility: system
triggers:
  - hook:PostToolUse (Edit|Write on workspace files)
  - hook:SessionEnd
  - compose:session-review.review-complete
backing_script: auto-commit.sh
depends_on: []
composes: []
---

## Purpose

Automatically group and commit pending workspace changes (tasks, memory, plans, config, scripts) into logical commits. This is a system skill — it has no slash command and is only invoked by hooks and composition.

## Arguments

This skill takes no arguments. It is invoked automatically by `hook:SessionEnd` or by the `session-review` skill's `review-complete` event. There is no user-facing command.

## Execution

The skill runs `skills/auto-commit/auto-commit.sh` from the workspace root. The script processes five commit groups in order:

1. Tasks (`tasks/`) → `chore: update task tracking`
2. Memory (`memory/`, `MEMORY.md`) → `chore: update memory`
3. Plans (`plans/`) → `chore: update plans`
4. Config (`.claude/`) → `chore: update workspace config`
5. Scripts/agents (`scripts/`, `agents/`) → `chore: update workspace scripts`

Each group is processed independently:

1. Collect all modified and untracked files matching the group's path patterns using `git diff --name-only` and `git ls-files --others --exclude-standard`.
2. If no files match, skip the group (no-op).
3. Stage the matching files with `git add`.
4. Commit with the group's message using `--no-verify` to avoid recursive pre-commit hook invocation.
5. Report the committed group to stdout.

If no groups produced commits, the script reports "nothing to commit" and exits 0.

## Examples

Invoked by `hook:SessionEnd` (via `scripts/session-end.sh`):

```
Auto-committing workspace changes...
  committed: chore: update task tracking (2 file(s))
  committed: chore: update memory (1 file(s))
```

Invoked by `compose:session-review.review-complete`:

```
Auto-committing workspace changes...
  nothing to commit
```

## Graceful Degradation

If no workspace changes exist, the skill is a no-op. Each group is independent — a failure in one group does not block the others. The script exits 0 in all cases where no commit was attempted; non-zero only when a `git commit` itself fails.

## Notes

- Uses `--no-verify` intentionally to avoid recursive pre-commit hooks triggered by the workspace's `.githooks/pre-commit`.
- Safe to run anytime — no-ops if the working tree is clean.
- Groups are processed in order; each group independently stages and commits its files.
- The script resolves `ROOT_DIR` from its own location (`$(dirname "${BASH_SOURCE[0]}")/../..`) so it works correctly from `skills/auto-commit/auto-commit.sh`.
