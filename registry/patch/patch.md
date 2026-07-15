---
name: patch
description: Export a worktree's unstaged changes as a .patch file for applying to your repos
version: 1
visibility: user
triggers:
  - /patch
cli_command: patch
depends_on: []
composes: []
---

## Purpose

Export the unstaged changes in a `workspaces/<name>` worktree as a `.patch`
file under `patches/` (gitignored), so a diff produced in a worktree can be applied
to your running repo at `~/Developer/<org>/<repo>/`. This is the bridge for
handing work back without pushing a branch — you apply the patch,
review, and commit on your side.

Backed by `scripts/create-patch.sh`.

## Arguments

```
/patch <worktree-name> [description] [-- <pathspec>...]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `worktree-name` | yes | Worktree under `workspaces/` (e.g. `web--yourname--add-debug-logs`) |
| `description` | no | Short label for the patch filename (default: `changes`) |
| `-- <pathspec>` | no | Path filter passed to `git diff` (everything after `--`) |

Output: `patches/<worktree>--<description>--<timestamp>.patch`

## Execution

Run the backing command — it diffs the worktree's unstaged changes and writes
the patch:

```bash
./scripts/<agent> patch <worktree-name> [description] [-- <pathspec>...]
```

1. Resolve `workspaces/<worktree-name>`; error with the available worktree list if missing.
2. Run `git diff` in the worktree (optionally filtered by the pathspec after `--`).
3. If there are no unstaged changes, report and exit without writing a file.
4. Otherwise write the diff to `patches/<worktree>--<description>--<timestamp>.patch` and print a `files / +added / -removed` summary plus the apply command.

To apply a patch to your repo:

```bash
cd ~/Developer/<org>/<repo>
git apply <workspace>/patches/<patch-file>.patch
```

## Examples

```
/patch web--yourname--add-debug-logs
→ patches/web--yourname--add-debug-logs--changes--20260602-141530.patch
  3 file(s), +84 -12

/patch web--yourname--add-debug-logs rollback-cursor-stack -- apps/web/app/**/event-logs/
→ patches/web--yourname--add-debug-logs--rollback-cursor-stack--<ts>.patch (filtered to the event-logs path)
```
