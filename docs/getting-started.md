# Getting Started

This guide walks you through installing Straper, creating your first agent workspace, and starting your first session. You will have a working workspace in under 10 minutes.

## Prerequisites

You need the following installed:

- **Node.js 20+** — [download](https://nodejs.org/) or use a version manager like nvm
- **pnpm** — [install](https://pnpm.io/installation) (`npm install -g pnpm`)
- **git** — [download](https://git-scm.com/)
- **jq** — [download](https://jqlang.github.io/jq/) (used by workspace scripts to read preferences.json)

Verify your setup:

```bash
node --version   # v20.0.0 or higher
pnpm --version   # any recent version
git --version    # any recent version
jq --version     # any recent version
```

## Install Straper

Straper is npm-ready but not yet published. Once it is on npm you will be able to run it with no install step:

```bash
npx straper init myagent --user "Your Name"
```

Until then, install from source. Clone the repository and build:

```bash
git clone https://github.com/iagodahlem/straper.git
cd straper
pnpm install
pnpm build
```

The rest of this guide uses `node bin/straper` for the source install; substitute `straper` (or `npx straper`) once it is on your PATH.

Verify the CLI works:

```bash
node bin/straper --help
```

You should see the full command list:

```
straper v0.1.0

The agent that keeps the harness in place.
Scaffold, configure, and maintain AI agent workspaces.

Usage:
  straper init <name> [options]      Scaffold a new agent workspace
  straper init --adopt [options]     Adopt an existing workspace into module management
  straper add <module...> [opts]     Vendor registry modules into a workspace
  straper use <module> [opts]        Print a skill for one-off session use (nothing installed)
  straper update [module...] [opts]  Update vendored modules, merging local edits
  straper doctor [options]           Check vendored module health
  straper publish <module> [opts]    Publish a workspace skill into a registry checkout
  straper migrate [options]          Migrate an old workspace to the registry model (being reworked)
  straper status                     Show workspace status
  straper --version                  Print version
  straper --help                     Show this help
```

See [cli-reference.md](cli-reference.md) for every command's flags.

## Create Your First Workspace

Run `straper init` with your agent's name and basic info:

```bash
node bin/straper init myagent \
  --dir ~/myagent \
  --user "Your Name" \
  --project "My Project" \
  --description "A short description of what the project does"
```

The agent name must be lowercase, start with a letter, and contain only letters, digits, hyphens, or underscores. Examples: `myagent`, `project-helper`, `code_buddy`.

Straper creates the workspace, initializes a git repo, installs the agent CLI, and makes the initial commit. You should see output like:

```
  Created Myagent workspace at /Users/you/myagent

  Workspace structure:
    AGENTS.md          Main instructions
    SOUL.md            Agent persona
    preferences.json   Workspace conventions
    scripts/myagent.js CLI orchestrator
    tasks/             Task tracking
    designs/           Feature designs

  Customize your workspace:
    Open preferences.json to configure:
    - commits    — style, footer, co-authored-by
    - branches   — prefix, format
    - worktrees  — naming pattern
    - subagents  — parallelism limits

  Next steps:
    cd /Users/you/myagent
    myagent --help                    # See available commands
    ./scripts/task create "My first task"
    # Start a session with your preferred AI assistant
```

## What Was Created

Here is a walkthrough of each file and directory in your new workspace:

| File / Directory | Purpose |
|-----------------|---------|
| `AGENTS.md` | The main instruction file for AI agents. Every provider reads this. |
| `CLAUDE.md` | A symlink to `AGENTS.md`. Claude Code reads this automatically. |
| `SOUL.md` | Your agent's persona — name, tone, decision framework, boundaries. |
| `USER.md` | Your profile — name, role, working style, growth areas. Fill this in. |
| `TOOLS.md` | Tooling conventions: commit style, branching, subagent rules, skills. |
| `BOOT.md` | What the agent does at session start: load memory, check health, greet. |
| `MEMORY.md` | Curated long-term memory. The agent updates this as it learns. |
| `preferences.json` | Machine-readable workspace conventions. Scripts and agents read this. |
| `memory/` | Daily session logs (one markdown file per day, named `YYYY-MM-DD.md`). |
| `tasks/` | JSON task files with a schema. Tracks status, PRs, blockers, logs. |
| `designs/` | Feature design specs. Contains `TEMPLATE.md` and `INDEX.md` to start. |
| `plans/` | Architecture notes and discussion plans. Free-form markdown. |
| `agents/` | Domain-specific agent profiles (empty — add your own). |
| `repos/` | Clean git clones used as the base for worktrees. |
| `workspaces/` | Git worktrees for isolated work on different branches. |
| `patches/` | Exported patch files (gitignored). |
| `scripts/` | All workspace scripts: session lifecycle, tasks, verification, and your agent-named CLI. |
| `config/` | Provider configuration (`providers.json`). |
| `straper.lock` | Records which registry skills are installed and at what version. Starts empty. |
| `.claude/` | Claude Code settings, plus `skills/` pointers once you add skills. |
| `.githooks/` | Git hooks (pre-commit runs task validation). |

Two directories appear once you install skills (next section): `skills/` (the vendored skill code), `.straper/base/` (pristine baselines for safe updates), and `.agents/skills/` (universal skill pointers).

## Add Skills

A fresh workspace has no skills yet. Skills are reusable workflows — task tracking, feature designs, shipping PRs, session review — vendored from the registry into your workspace. Install the ones you want:

```bash
cd ~/myagent
node bin/straper add task fd ship session-review
```

Straper copies each skill into `skills/<name>/`, resolves and installs its dependencies (so `session-review` also pulls in `fd`, `memory`, `session`, and `task`), records everything in `straper.lock`, and writes discovery pointers under `.claude/skills/` and `.agents/skills/`. You should see output like:

```
added task@0.1.1 (+0 deps)
added fd@0.1.3 (+0 deps)
added ship@0.1.1 (+0 deps)
added session-review@0.1.2 (+2 deps)
```

The dependency count is how many *new* skills each install pulled in — here `session-review` added `memory` and `session` (its other deps, `fd` and `task`, were already installed).

The skill code now lives in your workspace — edit it freely. When upstream ships a fix, `node bin/straper update` merges it into your copy without clobbering your edits. Check the health of your vendored skills anytime with `node bin/straper doctor`.

To trial a skill without installing it, use `node bin/straper use <name>` — it prints a ready-to-use prompt from a temp directory and touches nothing in your workspace.

See [Concepts: The Skill Registry](concepts.md#the-skill-registry) for the full model.

## Customize Preferences

Open `preferences.json` in your workspace. This is the single source of truth for workspace conventions. Both scripts and AI agents read from it.

```json
{
  "agent_name": "myagent",
  "agent_display_name": "Myagent",
  "commits": {
    "style": "conventional",
    "include_footer": false,
    "include_co_authored_by": false,
    "sign_off": false,
    "skip_hooks_env": ""
  },
  "branches": {
    "prefix": "",
    "format": "{prefix}{name}"
  },
  "worktrees": {
    "naming": "{repo}--{branch}",
    "base_dir": "workspaces"
  },
  "subagents": {
    "max_parallel_read": 5,
    "max_parallel_write": 1
  },
  "session": {
    "auto_commit": true,
    "daily_memory_logs": true
  },
  "github": {
    "org": ""
  }
}
```

Common customizations:

- Set `branches.prefix` to `yourname/` so all branches get a consistent prefix
- Set `commits.skip_hooks_env` to `SKIP_GIT_HOOKS=1` if your external repos have pre-commit hooks that fail in non-interactive shells
- Set `github.org` to your GitHub organization name
- Adjust `subagents.max_parallel_read` if your machine has resource constraints

See [preferences.md](preferences.md) for a full reference of every field.

## Start Your First Session

### With Claude Code

Claude Code reads `CLAUDE.md` (which symlinks to `AGENTS.md`) automatically. Session hooks in `.claude/settings.json` run `session-start.sh` at the beginning and `session-end.sh` at the end of each session.

```bash
cd ~/myagent
claude   # Claude Code picks up CLAUDE.md and hooks automatically
```

### With Other Providers

Point your AI assistant at `AGENTS.md` as its instruction file, then run the session start script manually:

```bash
cd ~/myagent
./scripts/session-start.sh
```

See [provider-guide.md](provider-guide.md) for setup instructions for Codex, Gemini CLI, and other tools.

## Create Your First Task

Tasks are JSON files in `tasks/` that track work across sessions. Create one:

```bash
./scripts/task create "Set up project authentication"
```

This creates `tasks/TASK-001.json` with status `todo`. The agent reads active tasks at the start of each session and updates them as work progresses.

Other task commands:

```bash
./scripts/task list                                      # List all tasks
./scripts/task log TASK-001 "Researched auth options"    # Add a log entry
./scripts/task status TASK-001 in_progress               # Change status
```

## Next Steps

- **Fill in USER.md** — Tell the agent about yourself: how you work, what you are good at, where you want to grow. The more context you give, the better the agent works with you.
- **Fill in SOUL.md** — Customize your agent's persona. Change the name, adjust the tone, update the decision framework.
- **Read [Concepts](concepts.md)** — Understand how tasks, memory, designs, and sessions fit together.
- **Read [Provider Guide](provider-guide.md)** — Set up your preferred AI coding assistant.
- **Add verification** — If you work with external repos, see [Writing Verifiers](writing-verifiers.md) to add type-checking and linting before PRs.
