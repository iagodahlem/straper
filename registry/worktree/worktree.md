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
/worktree <repo> <branch> [--base <base-branch>] [--no-sync] [--dry-run]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `repo` | yes | Repository name under `repos/` (e.g., `web`, `api`). |
| `branch` | yes | Branch name to create (e.g., `yourname/fix-something`). |
| `--base <branch>` | no | Base branch to branch from. Defaults to the repo's default branch (usually `main`). |
| `--no-sync` | no | Skip the base-clone sync step (see "Base clone sync" below). |
| `--dry-run` | no | Print what would be created without executing. |

## Execution

1. Run `./scripts/<agent> worktree <repo> <branch> [--base <base>] [--no-sync] [--dry-run]` to create the worktree.
2. The command:
   a. Resolves the repo path from `repos/<repo>`.
   b. Syncs the base clone first — see "Base clone sync" below (skipped under `--dry-run` or `--no-sync`).
   c. Derives the worktree name: `<repo>--<branch-slug>` (slashes in branch name become `--`).
   d. Checks that `workspaces/<worktree-name>` does not already exist.
   e. Resolves the base ref: defaults to `origin/HEAD` (usually `origin/main`).
   f. Runs `git -C repos/<repo> worktree add workspaces/<worktree-name> -b <branch> <base-ref>`.
3. Confirm the worktree was created and print the path.

## Base clone sync

A stale `repos/<repo>` clone is a repeat failure mode: a worktree cut from it branches off a commit that's days behind origin, so the work that lands looks based on current main when it isn't. Before creating a worktree, this skill fast-forwards the base clone by calling the [[repos]] skill — `repos sync <repo>` — when it's installed.

This is a **soft dependency**, not a `depends_on` entry and not wired through the skill composition engine (`composes` stays `[]` — `worktree` calls `repos.sh` directly via a feature-detected subprocess, not a declarative `skill: repos` composition): `worktree` feature-detects `skills/repos/repos.sh` on disk and no-ops the sync step entirely when it's absent. `worktree` works exactly as it did before `repos` existed when `repos` isn't installed — nothing here is a hard requirement.

A sync refusal or failure (dirty clone, local commits ahead of upstream, diverged history, no network) is printed as a warning and does **not** block worktree creation — the worktree is still cut from whatever commit the clone currently has, same as before this integration existed. Use `--no-sync` to skip the sync step outright (e.g. working offline, or when you deliberately want a worktree off the clone's current, unsynced state).

## Cleanup

The module ships `skills/worktree/cleanup-workspaces.sh` — a companion that scans
`workspaces/` for worktrees whose branch has merged into the source repo's
default branch and removes the stale ones. Run it with `--dry-run` to preview,
or `--force` to skip the confirmation prompt.

## Examples

```
/worktree web yourname/feature-x
→ Fast-forwards repos/web (if the repos skill is installed), then creates
  workspaces/web--yourname--feature-x on branch yourname/feature-x from origin/main

/worktree api yourname/fix-pagination --base release/v5
→ Creates workspaces/api--yourname--fix-pagination branched from origin/release/v5

/worktree web yourname/add-logging --dry-run
→ Prints the git command that would be run without executing (no sync, no mutation)

/worktree web yourname/quick-fix --no-sync
→ Skips the repos sync step and creates the worktree from the clone's current state
```
