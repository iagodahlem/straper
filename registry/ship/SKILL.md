---
name: ship
description: Full pre-PR pipeline — verify, review, prepare PR, push
version: 1
visibility: user
triggers:
  - /ship
cli_command: ship
depends_on: []
composes: []
---

## Purpose

Run the full pre-PR pipeline for a worktree: typecheck and lint (and optionally run tests), review the diff, prepare a PR body, and optionally push the branch and create the PR. The canonical path from "done coding" to "PR open."

## Arguments

```
/ship [<worktree>] [--base <branch>] [--tier 1|2] [--quick] [--skip-verify] [--push] [--create-pr] [--title <title>] [--body-file <path>] [--dry-run]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `<worktree>` | no | Worktree name under `workspaces/`. Auto-detected from cwd if omitted. |
| `--base <branch>` | no | Base branch for the PR diff. Defaults to the repo's default branch (usually `main`). |
| `--tier 1\|2` | no | Verification tier. `1` = typecheck + lint. `2` = typecheck + lint + scoped unit tests. Default: `1`. |
| `--quick` | no | Quick lint mode — lint only changed files (skips full project lint). |
| `--skip-verify` | no | Skip verification entirely. Not recommended for PRs. |
| `--push` | no | Push the branch to origin after verification passes. |
| `--create-pr` | no | Create a GitHub PR via `gh pr create`. Implies `--push`. |
| `--title <title>` | no | Override the PR title (defaults to latest commit message). |
| `--body-file <path>` | no | Use a file as the PR body instead of the auto-generated body. |
| `--dry-run` | no | Preview what would run without executing verification or push. |

## Execution

1. Run `./scripts/<agent> ship <arguments>` to execute the shipping pipeline.
2. The pipeline:
   a. Resolves the worktree path (`workspaces/<worktree>`).
   b. Runs `./scripts/verify.sh <worktree> --tier <tier>` unless `--skip-verify` is set.
   c. If verification fails (exit code non-zero), stops and reports the failure.
   d. Computes the diff against the base branch for review context.
   e. Builds a PR title (latest commit message or `--title`) and body.
   f. Runs `skills/scrub/scrub.sh` against the drafted PR title, body, and latest commit message before creating or updating the PR (`gh pr create`/`gh pr edit`) — a non-clean result blocks the pipeline and the text must be rewritten and rescanned (see [[scrub]]).
   g. If `--push` or `--create-pr`: pushes branch to origin.
   h. If `--create-pr`: creates a GitHub PR via `gh pr create`.
3. Return the output: verification results, PR URL (if created), and any suggested follow-up review steps.
4. If the worktree is linked to a task, note the PR number in the task log.

## Examples

```
/ship web--yourname--feature-x
→ Verify tier 1, show diff summary, print PR template (no push)

/ship web--yourname--feature-x --push --create-pr
→ Verify, push branch, create PR via gh

/ship web--yourname--feature-x --tier 2 --quick --push
→ Quick lint + unit tests, then push

/ship --dry-run
→ Auto-detect worktree from cwd, show what would run without executing
```
