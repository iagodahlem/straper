---
name: investigate
description: Sync a repo to a deterministic ref before investigation — use this before any Read/Grep on a repo
version: 1
visibility: user
triggers:
  - /investigate
cli_command: investigate
depends_on: []
composes: []
---

## Purpose

Any time an agent reads, greps, or explores code in `repos/<repo>/`, call `/investigate <repo>` first. The related `repo-scope` PreToolUse hook blocks reads from your local source clones (e.g. `~/Developer/<org>/`); `/investigate` is the positive path — it syncs the target repo to a deterministic ref (main, a branch, or a specific SHA/tag) so the exploration starts from a known commit.

## Arguments

```
/investigate <repo> [--branch <name>] [--ref <sha|tag>] [--dry-run]
/investigate list
/investigate clean [--older-than <days>] [--dry-run]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `repo` | yes (for default/branch/ref) | Repository name under `repos/` (e.g., `web`, `api`). Reserved values `list` and `clean` route to their subcommands. |
| `--branch <name>` | no | Investigate a specific branch. Creates a detached-HEAD worktree under `investigations/<repo>--<branch-slug>`. |
| `--ref <sha\|tag>` | no | Investigate a specific ref. Creates a detached-HEAD worktree under `investigations/<repo>--ref-<shortsha>`. |
| `--dry-run` | no | Print the commands and target path without mutating anything. |
| `--older-than <days>` | no (clean only) | Age threshold for `clean`. Defaults to `14`. |

`--branch` and `--ref` are mutually exclusive.

## Execution

### Default mode (`/investigate <repo>`)

Operates on `repos/<repo>/` directly — the canonical main copy.

1. Validate that `repos/<repo>` exists.
2. Require `repos/<repo>` to be on `main`. If it is on another branch, abort with a message pointing to `/workspaces` or `--branch`.
3. Require a clean working tree. If `git status --porcelain` is non-empty, abort and ask the user to resolve manually.
4. Run `git fetch origin main`.
5. Run `git reset --hard origin/main` (force-deterministic sync — idempotent).
6. Print the absolute path, the branch (`main`), short SHA, and commit date.

### Branch mode (`/investigate <repo> --branch <name>`)

Operates on a detached-HEAD worktree at `investigations/<repo>--<branch-slug>/`. Slashes in the branch name become `--`.

1. Validate that `repos/<repo>` exists.
2. Run `git fetch origin <branch>` (falls back to full fetch if the specific-ref fetch fails).
3. Compute short SHA for `origin/<branch>`.
4. Compute the worktree path `investigations/<repo>--<branch-slug>/` and ensure `investigations/` exists.
5. If the worktree path does not exist: `git worktree add --detach <path> origin/<branch>`.
6. If it already exists: sanity-check it is a git worktree, then fetch + `git checkout --detach origin/<branch>` to refresh idempotently.
7. Print the absolute path, branch label, short SHA, commit date, and `(detached)` marker.

### Ref mode (`/investigate <repo> --ref <ref>`)

Same as branch mode, but the target is a SHA or tag and the slug is `ref-<shortsha>`.

1. Validate that `repos/<repo>` exists.
2. Run `git fetch origin <ref>` (fallback to full fetch — some SHAs require it).
3. Compute short SHA for the ref.
4. Compute the worktree path `investigations/<repo>--ref-<shortsha>/` and ensure `investigations/` exists.
5. Add the worktree with `git worktree add --detach <path> <ref>` if missing, otherwise refresh via fetch + `git checkout --detach <ref>`.
6. Print the absolute path, ref label, short SHA, commit date, and `(detached)` marker.

### List mode (`/investigate list`)

1. If `investigations/` is missing or empty, print `No investigations.`.
2. Otherwise, for each entry, collect repo (slug's first `--`-segment), ref (branch name if available, else `(detached)`), short HEAD SHA, and last commit date.
3. Print the rows as an aligned table with columns `SLUG`, `REPO`, `REF`, `SHA`, `DATE`.

### Clean mode (`/investigate clean [--older-than <days>] [--dry-run]`)

1. Default threshold is 14 days; override via `--older-than <days>`.
2. For each entry in `investigations/`, compare the directory's `mtime` to the threshold.
3. If older: in dry-run, print `Would remove: <slug> (last modified <date>)`; otherwise run `git worktree remove <path> --force` from the source repo, `fs.rmSync` any remaining files, then `git worktree prune` to clean up metadata.
4. Print `Removed N investigation(s).` as the summary.

### Dry-run

For default/branch/ref/clean modes, `--dry-run` prints the target path and the git commands that would run, then exits without mutating anything.

### Related vault notes

After printing the investigation path, grep your knowledge vault's domain notes (e.g. `~/brain/domains/<domain>/`) note TITLES (filenames) for the repo/feature keywords of the task at hand (e.g. `ls ~/brain/domains/<domain>/*/ | grep -i <keyword>`) and print any matches as "Related vault notes:" lines. Titles only — the caller decides what to read. Skip silently if the vault is absent.

## Examples

```
/investigate web
→ Path: <workspace>/repos/web
→ Ref:  main @ abc1234 (2026-04-22)

/investigate web --branch yourname/feature-x
→ Path: <workspace>/investigations/web--yourname--feature-x
→ Ref:  yourname/feature-x @ def4567 (2026-04-22) (detached)

/investigate api --ref v5.12.0
→ Path: <workspace>/investigations/api--ref-9ab8cde
→ Ref:  v5.12.0 @ 9ab8cde (2026-03-10) (detached)

/investigate web --dry-run
→ Prints the fetch + reset --hard commands it would run, without mutating

/investigate list
→ SLUG                                                   REPO        REF              SHA       DATE
  web--yourname--feature-x                               web         (detached)       def4567   2026-04-22

/investigate clean --older-than 7
→ Removes every investigations/* worktree untouched for 7+ days and prints a summary
```
