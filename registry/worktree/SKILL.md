---
name: worktree
description: Create worktree and branch in one step
version: 1
visibility: user
triggers:
  - /worktree
cli_command: worktree
depends_on: []
composes: []
---

## Purpose

Create a git worktree with a new branch from a repo and branch name. Wraps `git worktree add` with workspace conventions — output lands in `workspaces/<repo>--<branch-slug>`.

## Arguments

```
/worktree <repo> <branch> [--base <base-branch>] [--dry-run]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `repo` | yes | Repository name under `repos/` (e.g., `web`, `api`). |
| `branch` | yes | Branch name to create (e.g., `yourname/fix-something`). |
| `--base <branch>` | no | Base branch to branch from. Defaults to the repo's default branch (usually `main`). |
| `--dry-run` | no | Print what would be created without executing. |

## Execution

1. Run `./scripts/<agent> worktree <repo> <branch> [--base <base>] [--dry-run]` to create the worktree.
2. The command:
   a. Resolves the repo path from `repos/<repo>`.
   b. Derives the worktree name: `<repo>--<branch-slug>` (slashes in branch name become `--`).
   c. Checks that `workspaces/<worktree-name>` does not already exist.
   d. Resolves the base ref: defaults to `origin/HEAD` (usually `origin/main`).
   e. Runs `git -C repos/<repo> worktree add workspaces/<worktree-name> -b <branch> <base-ref>`.
3. Confirm the worktree was created and print the path.

## Cleanup

The module ships `skills/worktree/cleanup-workspaces.sh` — a companion that scans
`workspaces/` for worktrees whose branch has merged into the source repo's
default branch and removes the stale ones. Run it with `--dry-run` to preview,
or `--force` to skip the confirmation prompt.

## Examples

```
/worktree web yourname/feature-x
→ Creates workspaces/web--yourname--feature-x on branch yourname/feature-x from origin/main

/worktree api yourname/fix-pagination --base release/v5
→ Creates workspaces/api--yourname--fix-pagination branched from origin/release/v5

/worktree web yourname/add-logging --dry-run
→ Prints the git command that would be run without executing
```
