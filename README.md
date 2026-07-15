# Straper

Straper does two things: it scaffolds self-contained AI agent workspaces, and it manages the skills inside them through a versioned registry. Skills are vendored — copied into your workspace with a lockfile, shadcn-style — so you own the code and can edit it, while `straper update` still pulls upstream fixes and merges them with your local changes.

Run one command to get a workspace that works with Claude Code, Codex, Cursor, Gemini CLI, or any tool that reads markdown. Add the skills you want. Boot.

## Why This Exists

AI assistants forget everything between sessions. Straper fixes that by generating a workspace with cross-session memory, task tracking, and reusable scripts — so your agent picks up where it left off every time. The workspace stands alone: no framework, no runtime service, just markdown, JSON, and shell scripts.

Skills — the reusable workflows an agent runs (`/ship`, `/fd`, `/task`, `/session-review`) — used to be baked into the scaffold, frozen at whatever version you generated. Now they live in a registry and get vendored on demand. You install exactly the skills you want, pin them in a lockfile, edit them freely, and update them without losing your edits.

## Quick Start

Straper is npm-ready but not yet published, so there are two paths. Once it is on npm:

```bash
npx straper init myagent --user "Your Name" --project "My Project"
```

Today, install from source:

```bash
git clone https://github.com/iagodahlem/straper.git
cd straper && pnpm install && pnpm build
node bin/straper init myagent --dir ~/myagent --user "Your Name" --project "My Project"
```

Add the skills you want (they are vendored into `skills/` and pinned in `straper.lock`):

```bash
cd ~/myagent
straper add task fd ship session-review
```

Then point your AI assistant at `AGENTS.md` (or `CLAUDE.md` for Claude Code) and start a session. The session-start hook loads memory, reads active tasks, and greets you.

## What You Get

```
~/myagent/
├── AGENTS.md              # Instructions for AI agents (universal)
├── CLAUDE.md -> AGENTS.md # Symlink for Claude Code
├── preferences.json       # Workspace conventions (commits, branches, etc.)
├── SOUL.md                # Agent persona and decision framework
├── USER.md                # Your profile and working style
├── TOOLS.md               # Tooling conventions and workflows
├── BOOT.md                # Session startup instructions
├── MEMORY.md              # Persistent memory across sessions
├── memory/                # Daily session logs
├── tasks/                 # JSON task files with schema validation
├── designs/               # Feature design specs
├── plans/                 # Architecture notes
├── skills/                # Vendored registry skills (added via `straper add`)
├── straper.lock           # Which skills are installed, and at what version
├── .straper/base/         # Pristine baselines that make `straper update` merges safe
├── scripts/               # CLI orchestrator, session hooks, verifiers
│   └── myagent.js         # Agent-named CLI (named after your agent)
├── config/                # Provider configuration
├── .claude/               # Claude Code settings + skill pointers (.claude/skills/)
├── .agents/               # Universal skill pointers (.agents/skills/)
└── .githooks/             # Pre-commit task validation
```

A freshly scaffolded workspace has no skills yet — `skills/` fills in as you `straper add` them.

## Commands

| Command | When to reach for it |
|---------|----------------------|
| `straper init <name>` | Starting fresh — build a new agent workspace skeleton. |
| `straper init --adopt` | You already have a workspace and want Straper to manage its skills (no scaffolding). |
| `straper add <module...>` | Install skills you want, with their dependencies. `--no-agents-dir` skips the universal `.agents/skills/` pointer. |
| `straper update [module...]` | Pull upstream skill fixes — merged into your local edits, no clobbering. |
| `straper doctor` | Something feels off — check vendored skills for missing files, conflict markers, drift, and orphans. |
| `straper use <module>` | Try a skill for one session without installing it — prints a ready-to-use prompt from a temp dir. |
| `straper publish <module>` | You author skills — push one into a registry checkout (gated, opens a review branch). |
| `straper status` | See the health of every workspace you have created. |
| `straper migrate` | Move a pre-registry workspace onto the registry model (being reworked). |
| `straper --version` / `--help` | Version and usage. |

See [docs/cli-reference.md](docs/cli-reference.md) for every flag, argument, and environment variable.

## For AI Agents

Straper workspaces are built to be driven by agents, not just humans:

- **One instruction file, every runtime.** Point your assistant at `AGENTS.md` (the universal entry point). `CLAUDE.md` is a symlink to it for Claude Code. It `@`-references `SOUL.md`, `USER.md`, `TOOLS.md`, and `BOOT.md`.
- **Skills are discoverable without configuration.** Every installed skill has a pointer at `.claude/skills/<name>/SKILL.md` (Claude Code) and `.agents/skills/<name>/SKILL.md` (read natively by Cursor, Codex, Amp, and Vercel's installer). The skill body lives once under `skills/<name>/`.
- **Trial before install.** An agent can run `straper use <skill>` to get a skill's full prompt from a throwaway temp dir — nothing is written into the workspace, so it is safe to explore.
- **Deterministic session lifecycle.** `./scripts/session-start.sh` loads memory and active tasks at the start; `./scripts/session-end.sh` validates and commits at the end. Claude Code runs these via hooks; other tools run them directly.

See the [Provider Guide](docs/provider-guide.md) for per-tool setup.

## Concepts in Brief

- **Registry modules** — Skills published to a registry, each with a version, a manifest (`module.json`), and real declared dependencies. `straper add session-review` also pulls in the `fd`, `memory`, `session`, and `task` skills it depends on.
- **`straper.lock`** — Records which skills are installed, at what version, and the hash of every vendored file. The source of truth for what your workspace has.
- **`.straper/base/`** — A pristine copy of each skill's published bytes. It is the merge baseline: `straper update` runs a three-way merge (base vs. your edits vs. new upstream) so upstream fixes land without clobbering your local changes; genuine conflicts get standard conflict markers.
- **Consumer pointers** — Vendoring a skill also writes a small `SKILL.md` pointer so agents surface it: `.claude/skills/<name>/SKILL.md` for Claude Code and `.agents/skills/<name>/SKILL.md` universally (read natively by Cursor, Codex, Amp, and Vercel's installer). The skill body lives once under `skills/<name>/`; the pointers just register it.
- **The publish gate** — Module authors run `straper publish` to push a workspace skill into a registry checkout. It is deliberately gated: the workspace must carry a scrub engine and gate config, the skill must be committed and self-contained (every cross-skill reference declared as a dependency), and the command opens a branch for review rather than committing to the registry directly.

## Documentation

| Guide | What you'll learn |
|-------|------------------|
| [Getting Started](docs/getting-started.md) | Full walkthrough from install to first session |
| [Concepts](docs/concepts.md) | Workspaces, the registry, tasks, memory, designs, and sessions |
| [CLI Reference](docs/cli-reference.md) | Every command, flag, and environment variable |
| [Templates](docs/templates.md) | How the scaffold template system works and how to customize it |
| [Preferences](docs/preferences.md) | Every workspace preference field explained |
| [Provider Guide](docs/provider-guide.md) | Setup for Claude Code, Codex, Gemini CLI, and others |
| [Writing Verifiers](docs/writing-verifiers.md) | Add verification scripts for your repos |
| [Contributing](docs/contributing.md) | Dev setup, architecture, and PR guidelines |

## Requirements

- Node.js 20+
- pnpm
- git
- jq (used by workspace scripts to read `preferences.json`)

## License

MIT — see [LICENSE](LICENSE)
