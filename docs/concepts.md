# Concepts

This page explains the mental model behind agent workspaces: what they are, what concepts they use, and how those concepts fit together. It also covers the skill registry — how workspaces get their reusable workflows and keep them up to date.

## What Is an Agent Workspace?

An agent workspace is a git repository with structured files that give AI coding assistants persistent memory, task tracking, and repeatable workflows. Instead of starting every session from scratch, the agent reads its instruction files, loads its memory, checks active tasks, and picks up where it left off.

The workspace is not a framework or a library. It is a collection of markdown files, JSON files, and shell scripts. Any AI tool that can read files and run commands can use it. There is no runtime service to keep running — after Straper creates the workspace and you add the skills you want, it stands alone.

Straper has two jobs, and they map to two sets of commands:

- **Scaffolding** (`straper init`) builds the workspace skeleton — instructions, memory, tasks, scripts, config.
- **Skill management** (`straper add`, `update`, `doctor`, `use`, `publish`) vendors reusable skills into the workspace from a registry and keeps them current. See [The Skill Registry](#the-skill-registry) below.

## Core Concepts

### Tasks

A task is a unit of work tracked as a JSON file in `tasks/`. Each task has a status, a chronological log, links to PRs and branches, and optional blockers and dependencies.

Tasks are the cross-session communication channel. When the agent finishes a session, it writes what it did into the task log. When it starts the next session, it reads the log to understand where things stand.

Lifecycle: `todo` -> `in_progress` -> `in_review` -> `done`

Managed by: `./scripts/task create`, `./scripts/task log`, `./scripts/task status`

### Feature Designs

A feature design (FD) is a structured spec that breaks a large feature into implementable sub-items. Designs live in `designs/` and serve as the contract between the orchestrator agent and worker agents.

Each design has a frontmatter block with metadata (status, effort, priority, verification command) and a body with the problem statement, solution, and a table of sub-items. Worker agents can pick up a sub-item and execute it independently because the design provides enough context.

Lifecycle: `planned` -> `design` -> `open` -> `in_progress` -> `verification` -> `complete` -> `archived`

Managed by the `/fd` skill: `/fd new`, `/fd work`, `/fd status`, `/fd close` (or the equivalent agent-named CLI commands)

### Memory

Memory has two layers:

- **MEMORY.md** (root) — Curated long-term memory. Contains stable facts: key repos, learned preferences, confirmed patterns. The agent updates this when something is proven true over multiple sessions.
- **memory/YYYY-MM-DD.md** — Daily logs. One file per day. Contains session-specific progress, decisions, and context. The agent reads today's and yesterday's logs at session start.

Memory is how the agent avoids repeating mistakes. If a build command has a quirk, the agent writes it down. If a preference is confirmed, it goes into MEMORY.md. Over time, the agent gets sharper.

### Sessions

A session is one continuous interaction between a user and an AI agent. Straper workspaces define a session lifecycle with two hooks:

- **session-start.sh** — Runs at the beginning. Loads memory, reads active tasks, checks workspace health, and prints a status summary.
- **session-end.sh** — Runs at the end. Validates task files, ensures log entries exist for today, checks that memory was updated, and auto-commits workspace changes.

For Claude Code, these hooks run automatically via `.claude/settings.json`. For other providers, you run them manually.

### Worktrees

A worktree is a git worktree — a separate working directory that shares the same git history as its parent repo. Workspaces use worktrees to work on multiple branches simultaneously without switching branches in the main repo.

Convention: clean clones live in `repos/`, worktrees are created in `workspaces/`, and the naming pattern (default: `{repo}--{branch}`) is configured in `preferences.json`.

Managed by: `./scripts/cleanup-workspaces.sh`, the `/worktree` skill, and the agent-named CLI

### Skills

Skills are self-contained, reusable workflows an agent can invoke. In Claude Code they appear as slash commands (e.g., `/ship`, `/worktree`, `/fd`). Each skill is a directory under `skills/<name>/` — a main `<name>.md` definition plus any scripts it needs — vendored from the registry with `straper add`. A fresh workspace has no skills; you install the ones you want.

Commonly installed skills include:

| Skill | What it does |
|-------|-------------|
| `task` | Cross-session task tracking (create, log, status) |
| `fd` | Feature design lifecycle — create, work, status, close |
| `ship` | Run verification, review, and prepare a PR |
| `session` | Session tracking and coordination |
| `session-review` | End-of-session summary and tracking update |
| `worktree` | Create a worktree and branch in one step |
| `sync-branch` | Rebase a feature branch on latest main |
| `memory` | Manage daily logs and curated memory |
| `slack-status` | Manage Slack status from the agent |
| `auto-commit` | Commit pending workspace changes in logical groups |

Skills declare real dependencies on each other, so `straper add session-review` also installs `fd`, `memory`, `session`, and `task`. See [The Skill Registry](#the-skill-registry) for how vendoring, updating, and pointers work.

### Preferences

`preferences.json` is the single source of truth for workspace conventions. It is a flat JSON file at the workspace root that both scripts and AI agents read.

Preferences cover: commit style, branch naming, worktree patterns, subagent parallelism limits, session behavior, and GitHub organization.

See [preferences.md](preferences.md) for every field.

## The Skill Registry

Skills are not baked into the scaffold. They live in a registry and get vendored into your workspace on demand — shadcn-style: the code lands in your repo and you own it, but Straper can still pull upstream updates and merge them with your edits.

### Registry modules

A registry module is a published skill: a directory of files plus a `module.json` manifest carrying a semantic version, a `type`, and a list of declared dependencies. Dependencies are real — `session-review` depends on `fd`, `memory`, `session`, and `task`, and `straper add session-review` installs all of them transitively.

### Skill-owned config and jobs

A module's state lives inside its own skill folder, not scattered across the workspace root. Two reserved subdirectories carry that state:

- **`skills/<name>/config/`** — the module's own overlay config: settings the module reads at runtime, tracked in git like any other module file. A config file that carries a secret is the one exception: it stays gitignored, with a committed `<file>.example` sibling documenting its shape so a fresh workspace knows what to fill in. `config/services.json` and `config/recipes/*.json` in the `service` module are the working example of the non-secret case.
- **`skills/<name>/jobs/`** — job definitions the scheduler module discovers and runs on a wall-clock schedule. Each job is its own folder, `jobs/<job-id>/<job-id>.md` plus an optional helper script, mirroring the shape scheduler already uses at the workspace root today.

Both subdirectories are ordinary module files as far as vendoring, updating, and publishing are concerned: `straper add` copies them into `skills/<name>/` alongside everything else, `straper.lock` hashes and tracks them file-by-file, `straper update` three-way-merges them like any other vendored file, and `straper publish` includes them in the module's content hash and self-containment check. Nothing in the toolchain special-cases these two names — the contract is where a module is allowed to look for its own state, not a new mechanism.

**Precedence.** A module resolves its own config in this order: an explicit override (a CLI flag or an env var the module defines), then `skills/<name>/config/`. New modules only ever have the second — there is no root-level fallback to fall back to. A module migrating off a workspace-root config path keeps reading the root path too, for one release, with a note in its own docs that the root path is deprecated; after that release the root path is dropped.

**Why:** only structural directories belong at the workspace root — `repos/`, `workspaces/`, `tasks/`, `designs/`, `plans/`, `docs/`, `memory/`, `skills/`, `scripts/`, `secrets/`, `runs/`, and the like. Config and job definitions are a specific module's business, not the workspace's, so they live where that module lives. This keeps the root minimal and makes a skill's footprint easy to reason about: everything it owns is under one directory, and removing the module (once `straper remove` exists) removes its state with it.

**Root `jobs/` is deprecated, not removed.** Before this contract, the scheduler module discovered jobs from a single workspace-root `jobs/` directory, and that is still true today — the scheduler's own glob change to also (or instead) look under `skills/*/jobs/` is a separate, later change. A workspace-root `jobs/` directory keeps working for one release after the scheduler adopts the skill-local glob. `straper doctor` flags a workspace-root `jobs/` directory as deprecated (informational — it does not fail the check) so a workspace knows to migrate before the compatibility window closes.

### Vendoring (`straper add`)

`straper add <module>` copies the module's files into `skills/<name>/`, installs its dependencies, and records the result in the lockfile. The skill body now lives in your workspace; you can read and edit it freely.

### `straper.lock`

The lockfile at the workspace root records which modules are installed, at what version, and the SHA-256 hash of every vendored file. It is the source of truth for what your workspace has and the basis for drift detection.

### `.straper/base/` — merge baselines

Every time a module is vendored, Straper also writes a pristine copy of the published bytes under `.straper/base/<name>/`. This baseline is what makes updates safe: `straper update` runs a three-way merge between the baseline, your current files, and the new registry bytes. Files you never touched update cleanly; files you edited are merged; only genuine conflicts get conflict markers. Without the baseline, Straper cannot tell your edits from upstream changes and refuses to merge.

### Consumer pointers

A bare copy under `skills/<name>/` does not register the skill with an agent. Vendoring also emits a small `SKILL.md` pointer at:

- `.claude/skills/<name>/SKILL.md` — read by Claude Code
- `.agents/skills/<name>/SKILL.md` — the universal pointer, read natively by Cursor, Codex, Amp, and Vercel's installer (skip it with `--no-agents-dir`)

The pointers carry identical content and just say "read `skills/<name>/<name>.md`." The skill body lives once; the pointers make it discoverable across runtimes.

### Health and updates

- `straper doctor` is a read-only check: missing files, unresolved conflict markers, local modifications (reported as info), orphaned skill directories not in the lockfile, and a deprecated workspace-root `jobs/` directory (see [Skill-owned config and jobs](#skill-owned-config-and-jobs) above).
- `straper update [module...]` refreshes vendored skills, preserving local edits via the baseline merge.
- `straper use <module>` materializes a skill into a temp dir and prints a prompt without installing anything — a way to trial a skill for one session.

### Publishing (`straper publish`)

Module authors push a workspace skill back into a registry checkout with `straper publish <module>`. It is gated: the workspace must carry a scrub engine and gate config, the skill must be committed and self-contained (every cross-skill reference declared as a dependency), and the command opens a review branch rather than committing to the registry directly. Version numbers bump automatically.

## Two CLIs: `straper` and `<agent>`

There are two distinct command-line tools in play, and they must not be confused.

`straper` is the npm tool. It scaffolds a workspace (`straper init`) and runs the module lifecycle (`straper add`, `update`, `use`, `publish`, `status`). It is TypeScript compiled to `dist/`, ships with the registry, and is what you run *from outside* a workspace to create or maintain one. It is authored in this repository.

`<agent>` (e.g. `nova`, whatever you named the agent) is the workspace CLI — `scripts/<agent>.js`. It is generated into each workspace, is thin plain JS with no build step, and is registry-driven: at invocation it discovers its commands by scanning the *installed* skill modules under `skills/*/commands.json`, then lazily loads only the handler for the command you ran. Three built-ins always work even in a workspace with zero skills installed — `help`, `skills`, and `completion`. A module contributes its commands through the `commands.json` contract; the workspace CLI has no hardcoded knowledge of any skill.

See [workspace-cli.md](workspace-cli.md) for the `commands.json` contract and the discovery/routing model.

## How They Fit Together

Here is the lifecycle of a typical workday using an agent workspace:

```
Session Start
  |
  v
Load memory (MEMORY.md + today's daily log)
  |
  v
Read active tasks (tasks/*.json where status != done)
  |
  v
Check workspace health (stale worktrees, validation)
  |
  v
Agent greets user with status summary
  |
  v
User and agent work together:
  - Create/update tasks
  - Write feature designs for large work
  - Spawn worker agents for sub-items
  - Create worktrees for isolated changes
  - Run verification before PRs
  - Ship PRs with /ship
  |
  v
Session End
  |
  v
Validate tasks, update logs, commit workspace changes
  |
  v
Next session picks up from the task logs and memory
```

## Provider-Agnostic Design

The workspace is designed to work with any AI coding assistant:

- **AGENTS.md** is the universal instruction file. It uses `@` references to pull in SOUL.md, USER.md, TOOLS.md, and BOOT.md.
- **CLAUDE.md** is a symlink to AGENTS.md. Claude Code reads it automatically.
- **Scripts are plain bash and Node.js** — no provider-specific APIs.
- **Session hooks** are configured in `.claude/settings.json` for Claude Code but can be run manually via `./scripts/session-start.sh` and `./scripts/session-end.sh` for any provider.
- **Skills** live once under `skills/<name>/` and are surfaced through pointers: `.claude/skills/<name>/SKILL.md` for Claude Code and the universal `.agents/skills/<name>/SKILL.md` for other runtimes. The skill logic is plain markdown and scripts, callable by any provider.

For providers that do not support `.claude/`, point them at `AGENTS.md` and the `.agents/skills/` pointers, and run the scripts directly. See [provider-guide.md](provider-guide.md) for details.
