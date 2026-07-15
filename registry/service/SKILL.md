---
name: service
description: Start, track, and stop the dev services the agent runs (a local dev sandbox first) with port discipline and cross-session visibility
version: 1
visibility: user
triggers:
  - /service
backing_script: service.sh
cli_command: service
depends_on: []
composes: []
---

## Purpose

Run and observe long-lived dev servers (a local JS sandbox first) without them getting lost in a session. Every service the agent starts is spawned detached in its own process group, allocated collision-free ports in reserved agent bands (never your manual `4000`/`4011`), and recorded so anyone — agent or you — can list it, tail its logs, or stop it later, across sessions.

Use it any time you need a repo running (browser QA, reproducing a bug, checking a build) instead of a bare `pnpm dev` that leaves an untracked process behind.

## Skill-owned config and state

This skill is the reference implementation of the skill-owned config/state architecture (see `skills/SCHEMA.md` → *Skill-owned config and state*):

- **Logic** — `service.sh` (CLI), `lib/ports.sh` (allocator), `lib/registry.sh` (records + liveness). Tracked.
- **Config** — `config/services.json` (port bands, timeouts) and `config/recipes/<repo>.json` (one per runnable repo). Tracked.
- **State** — `.state/<id>.json` records + `.state/logs/<id>.log`, gitignored via the skill-local `.gitignore`. Never committed.

Nothing the skill needs lives outside `skills/service/` except the shared `scripts/lib/node-env.sh` (the workspace's Node 22 shim, reused by every node recipe).

## Arguments

```
<agent> service start <recipe> [--worktree <name>] [--branch <b>] [--repo] [--mode <m>] [--setup] [--timeout <secs>]
<agent> service stop  <id|--all>
<agent> service list  [--json]
<agent> service logs  <id> [--follow] [-n <N>]
<agent> service status <id> [--json]
<agent> service url   <id> [--role <role>]
```

| Verb | What it does |
|------|--------------|
| `start` | Resolve the recipe, resolve the cwd (a `--worktree` under `workspaces/`, else the base `repos/<repo>` clone), allocate ports, spawn detached, wait for readiness, print a report ending in the exact stop command. |
| `stop` | Group-kill the whole process tree (TERM, then KILL after a grace period), refusing to kill a recycled PID. `--all` stops every tracked service. |
| `list` | Aligned table of tracked services (reaps dead ones first). Your primary visibility surface. |
| `logs` | `tail` (`-f` to follow) a service's captured log. |
| `status` | Full record + a live liveness re-probe. |
| `url` | Print the entrypoint URL(s) — the scripting hook (e.g. for a QA runner). |

Key flags: `--worktree <name>` runs a worktree under `workspaces/` instead of the base clone (each worktree gets its own ports). `--setup` runs the recipe's one-time setup (`pnpm install`/`build`) if the worktree isn't primed. `--timeout <secs>` overrides the readiness wait.

## Execution

When you need a repo running (browser QA, reproducing a bug):

1. Pick the recipe (`javascript` today) and the target — a worktree name if the work is in `workspaces/`, else the base repo.
2. `<agent> service start <recipe> --worktree <name>`. If it reports setup is incomplete, re-run with `--setup` once.
3. Report the entrypoint URL and the `stop` command so it can be opened and killed directly.
4. When done (or at session end), `<agent> service stop <id>` — or `--all`.

**Port discipline (the core rule):** You run repos manually on the defaults (`4000`/`4011`). The agent must never use those — the allocator picks from the `47xxx` bands and skips anything already listening, so an agent-run sandbox and your manual one coexist. Recipes declare each port's default only so it's excluded, never bound.

## Adding a recipe

Drop a `config/recipes/<repo>.json` describing the run: `command`, per-port `var`/`band`/`default`/`readiness`, and a `setup` block (`commands` + `ready_when` paths). The `javascript.json` recipe is the worked example — copy its shape. Bands are defined in `config/services.json`; reuse an existing role band or add one there.

## Examples

```
# Boot the sandbox for a worktree (browser QA), then use the URL + stop cmd
<agent> service start javascript --worktree web--yourname--feature-x
→ Service started — javascript (c82dfc)
  web  http://localhost:47100/   ← open this
  stop  <agent> service stop c82dfc

# See everything running, across sessions
<agent> service list

# Follow the log while it compiles
<agent> service logs c82dfc --follow

# Stop it (or everything)
<agent> service stop c82dfc
<agent> service stop --all
```

## Graceful degradation

Requires `jq`, `perl`, and `curl` (all present on macOS). Readiness uses `lsof` for liveness, falling back to `nc`, then a bash `/dev/tcp` probe. A recipe with no readiness URL is considered ready as soon as its process is alive.
