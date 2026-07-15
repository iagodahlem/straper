---
name: sync-branch
description: Rebase feature branch on latest main (never merge)
version: 1
visibility: user
triggers:
  - /sync-branch
cli_command: sync-branch
depends_on: []
composes: []
---

## Purpose

Rebase a feature branch onto the latest `main` (or another base branch) for a given worktree. Always rebases — never merges. Keeps the branch history clean and ready for PR.

## Arguments

```
/sync-branch [<worktree>] [--base <branch>] [--dry-run]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `<worktree>` | no | Worktree name under `workspaces/`. Auto-detected from cwd if omitted. |
| `--base <branch>` | no | Branch to rebase onto. Defaults to the repo's default branch (usually `main`). |
| `--dry-run` | no | Show what would be rebased without executing. |

## Execution

1. Run `./scripts/<agent> sync-branch <arguments>` to execute the rebase.
2. The command:
   a. Resolves the worktree path (`workspaces/<worktree>`).
   b. Fetches `origin` to get the latest remote state.
   c. Detects the current branch.
   d. Runs `git rebase origin/<base>` against the target base branch.
   e. If the rebase encounters conflicts, reports the conflict state and instructs to resolve manually, then run `git rebase --continue` in the worktree.
3. Return the output: commits replayed, final branch status (ahead/behind vs origin), or conflict details.

## Examples

```
/sync-branch web--yourname--feature-x
→ Fetch origin, rebase branch onto origin/main

/sync-branch web--yourname--feature-x --base release/v5
→ Rebase onto origin/release/v5

/sync-branch --dry-run
→ Auto-detect worktree, show what would be fetched and rebased
```
