---
name: repos
description: Fast-forward and inspect base clones under repos/ so worktrees never branch off a stale commit
version: 1
visibility: user
triggers:
  - /repos
backing_script: repos.sh
cli_command: repos
depends_on: []
composes: []
---

## Purpose

Workspaces keep one clean clone per repo under `repos/<name>/` and cut worktrees from it. When that clone goes stale — nobody ran `git pull` in it for a while — every worktree cut from it silently branches off an old commit, and the work that lands looks based on current main when it isn't. This skill makes "is my base clone current" a single command instead of a manual `git fetch` + `git log` check nobody remembers to run.

Backed by `skills/repos/repos.sh` — a dependency-free bash/git script, sourceable as a library or run as a CLI, cloned from the `skills/notify/notify.sh` shape (functions plus a guarded CLI entrypoint).

## Arguments

```
<agent> repos sync <name>
<agent> repos sync --all
<agent> repos status [<name>] [--json]
<agent> repos guard <name>
```

Or call the backing script directly:

```
skills/repos/repos.sh sync <name>
skills/repos/repos.sh sync --all
skills/repos/repos.sh status [<name>] [--json]
skills/repos/repos.sh guard <name>
```

| Argument | Required | Description |
|----------|----------|--------------|
| `sync <name>` | — | Fast-forward `repos/<name>` to its default branch's upstream. |
| `sync --all` | — | Sync every clone found directly under `repos/`. |
| `status [<name>]` | no | One line per clone (or every clone when `<name>` is omitted). |
| `--json` | no | With `status`, emit a JSON array instead of plain text. |
| `guard <name>` | — | Advisory-only staleness warning for one clone (stderr, always exits 0). |

## Execution

### `sync <name>`

1. Resolve `repos/<name>` and confirm it's a git clone.
2. Detect the clone's default branch (`refs/remotes/origin/HEAD`, falling back to `git remote set-head origin --auto` when that symref was never set — never hardcoded to `main`).
3. Refuse, with a clear stderr message, and change nothing, if the clone:
   - is in detached HEAD
   - is checked out on a branch other than its default branch
   - has uncommitted changes (dirty working tree or index)
   - has local commits not present on its upstream (`origin/<branch>..HEAD` is non-empty)
4. Otherwise: `git fetch origin`, then `git merge --ff-only origin/<branch>`. A merge that can't fast-forward (local and origin have diverged) is reported and left alone — never reset, never forced.
5. Print one summary line: `<name>: <old-sha>..<new-sha> (<n> commits, <branch>)`, or `<name>: already up to date (<sha>, <branch>)`.

### `sync --all`

Runs `sync` for every clone directly under `repos/`, printing one line (success or failure message) per clone. Exits non-zero if any clone failed; a failure on one clone does not stop the rest from being attempted.

### `status [<name>]`

For the named clone, or every clone under `repos/` when `<name>` is omitted: one `git fetch origin` (read-only — no merge), then report branch, commits ahead/behind the default branch's upstream, and dirty/clean. Exactly one fetch per clone, regardless of how many of `ahead`/`behind`/`dirty` are asked for.

Plain text: `<name>: branch=<branch> ahead=<n> behind=<n> <clean|dirty>`

`--json`: an array of `{name, branch, ahead, behind, dirty}` objects (requires `jq`; without it, `--json` exits 2 with a clear message rather than silently falling back to plain text).

### `guard <name>`

Advisory-only, no network call, always exits 0. Warns to stderr when:

- the clone's `HEAD` commit is older than the configured threshold (default 7 days — see Configuration below), or
- the clone is behind its default branch's upstream according to whatever remote-tracking refs are already cached locally (this is *not* a fetch — that's what makes `guard` cheap enough to call unconditionally; `sync` is the one that actually reaches the network).

Silently returns 0 with no output when the named clone doesn't exist — this is what lets a caller (e.g. the [[worktree]] skill) call it unconditionally without feature-detecting the repo first.

## Skill-owned config

This skill follows the skill-local config contract in `docs/concepts.md` ("Skill-owned config and jobs"): non-secret settings live in `skills/repos/config/`, tracked in git like any other module file — the same shape the `service` module uses for `config/services.json`.

`config/repos.json`:

```json
{
  "staleness_days": 7
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `staleness_days` | `7` | `guard`'s HEAD-age threshold, in days. |

Missing config file, missing key, or missing `jq` all degrade to the built-in default of 7 — this file is a convenience override, not a hard requirement.

## Worktree integration

The [[worktree]] skill calls `repos sync <repo>` on the base clone before cutting a new worktree, so a fresh worktree always branches off a current commit. This is a **soft dependency**, not a `depends_on` entry: `worktree` feature-detects `skills/repos/repos.sh` on disk and no-ops the integration entirely when it's absent (repos not installed) — the worktree skill works exactly as before with `repos` uninstalled. See `skills/worktree/worktree.md` ("Base clone sync") for the caller side, including the `--no-sync` escape hatch.

A `sync` refusal (dirty clone, local commits, diverged branch) is printed as a warning and does **not** block worktree creation — the worktree is still cut from whatever commit the clone currently has. `repos sync` only ever advances a clone; it never blocks the workflow that depends on it.

## Examples

```
$ skills/repos/repos.sh sync web
web: a1b2c3d..f9e8d7c (14 commits, main)

$ skills/repos/repos.sh sync web
web: already up to date (f9e8d7c, main)

$ skills/repos/repos.sh sync web
repos sync: repos/web has uncommitted changes -- refusing to sync (never reset, never force). Commit or clean up the clone first.
$ echo $?
1

$ skills/repos/repos.sh sync --all
web: a1b2c3d..f9e8d7c (14 commits, main)
api: already up to date (77aa11b, main)
$ echo $?
0

$ skills/repos/repos.sh status
web: branch=main ahead=0 behind=0 clean
api: branch=main ahead=0 behind=3 clean

$ skills/repos/repos.sh status web --json
[
  {
    "name": "web",
    "branch": "main",
    "ahead": 0,
    "behind": 0,
    "dirty": false
  }
]

$ skills/repos/repos.sh guard web
repos: repos/web HEAD is 11 day(s) old (threshold: 7) -- run `repos sync web` before branching off it.
$ echo $?
0
```

## Graceful Degradation

- `repos/<name>` missing or not a git clone → `sync`/`status` report it clearly and return non-zero for that clone; `guard` silently returns 0 (feature-detection contract for callers).
- No `jq` → `config/repos.json` is ignored (falls back to the 7-day default); `status --json` exits 2 with a clear message instead of guessing at hand-rolled JSON.
- `sync` never resets, never forces, never switches branches, never touches an untracked file. Every refusal path leaves the clone exactly as it found it.

## Consumers

- **[[worktree]]** — calls `repos sync <repo>` on the base clone before creating a worktree (soft dependency, see "Worktree integration" above).
- **Any session or job** — `repos status --json` gives a scriptable snapshot of every base clone's freshness; `repos sync --all` is a reasonable session-start or scheduled-job step.

## Metrics

`repos` has no `cli_command`-driven metrics of its own beyond what the workspace CLI dispatcher logs automatically for every `commands.json`-declared command (`.metrics/skills.jsonl`, via `logSkillMetric`). No extra instrumentation needed here.
