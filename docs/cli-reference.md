# CLI Reference

This page documents every Straper command, flag, and configuration option. It mirrors `straper --help`.

## Overview

```
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

## straper init

Scaffold a new agent workspace.

```bash
straper init <name> [options]
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<name>` | Yes (unless `--adopt`) | Agent name. Must be lowercase, start with a letter, and contain only letters, digits, hyphens, or underscores. Examples: `myagent`, `project-helper`, `code_buddy`. |

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dir <path>` | string | `./<name>` | Target directory for the workspace. Created if it does not exist. Must be empty if it exists. |
| `--user <name>` | string | From global config | Your name. Required on first run if no global config exists. |
| `--role <role>` | string | `"Software Engineer"` | Your role. Appears in USER.md. |
| `--project <name>` | string | Capitalized `<name>` | Project name. Appears in AGENTS.md and SOUL.md. |
| `--description <desc>` | string | `""` | Project description. Appears in USER.md. |
| `--adopt` | flag | -- | Adopt an existing workspace instead of scaffolding. See below. |
| `--registry <dir>` | string | Bundled registry | Registry directory used by `--adopt`. Overrides `STRAPER_REGISTRY_DIR`. |

### What It Creates

1. Creates the workspace directory (or uses an existing empty directory)
2. Initializes a git repository with a `main` branch
3. Reads global config from `~/.config/straper/` (creates it on first run)
4. Processes template files with variable substitution
5. Copies scripts, schemas, design templates, prompt templates, and shell completions
6. Creates empty directories: `memory/`, `plans/`, `repos/`, `workspaces/`, `agents/`, `patches/`
7. Writes an empty `straper.lock` (ready for `straper add`)
8. Sets up `.githooks/` with a pre-commit hook for task validation
9. Creates `CLAUDE.md` as a symlink to `AGENTS.md`
10. Makes all scripts executable
11. Saves or updates global config
12. Registers the workspace in `~/.config/straper/workspaces.json`
13. Installs the agent CLI to your PATH (unless `STRAPER_SKIP_CLI_INSTALL=1`)
14. Makes an initial git commit

A fresh workspace has no `skills/` directory yet — skills are added later with `straper add`.

### Examples

```bash
# Minimal (uses defaults)
straper init myagent --user "Alice"

# Full options
straper init nova \
  --dir ~/Developer/nova \
  --user "Alice Smith" \
  --role "Software Engineer" \
  --project "Acme Support" \
  --description "Customer support agent"

# Second workspace (reuses global config)
straper init helper --dir ~/helper --project "Side Project"
```

### Error Cases

| Error | Cause |
|-------|-------|
| `Invalid agent name` | Name contains uppercase letters, starts with a digit, or has invalid characters. |
| `Directory already exists and is not empty` | The target directory has files in it. Use an empty directory or a new path. |
| `User name is required` | No `--user` flag and no global config with a saved name. |

## straper init --adopt

Onboard an existing workspace into vendored-module management without scaffolding anything. Straper scans `skills/<name>/` trees and, for each one that byte-matches a registry module, records it in `straper.lock`, writes a pristine baseline under `.straper/base/<name>/`, and emits consumer pointers. Skill trees that differ from the registry are reported but not adopted.

```bash
straper init --adopt [--dir <path>] [--registry <dir>]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dir <path>` | string | Current directory | Workspace to adopt. |
| `--registry <dir>` | string | Bundled registry | Registry to match skills against. Overrides `STRAPER_REGISTRY_DIR`. |

It touches only the management surface (`straper.lock`, `.straper/base/`, and pointers) — your skill files are left byte-for-byte unchanged.

## straper add

Vendor one or more registry modules into a workspace: copy the skill files into `skills/<name>/`, resolve and install declared dependencies, record everything in `straper.lock`, write a pristine baseline under `.straper/base/<name>/`, and emit consumer pointers.

```bash
straper add <module...> [options]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dir <path>` | string | Current directory | Workspace directory to install into. |
| `--registry <dir>` | string | Bundled registry | Registry directory. Overrides `STRAPER_REGISTRY_DIR`. |
| `--no-agents-dir` | flag | off | Skip the universal `.agents/skills/<name>/SKILL.md` pointer (only write the Claude pointer). Equivalent to `STRAPER_NO_AGENTS_DIR=1`. |

Dependencies are installed transitively; a dependency cycle in the registry aborts the install. Each installed module prints its version and dependency count, e.g. `added session-review@0.1.2 (+4 deps)`.

## straper use

Materialize a registry skill and its dependencies into a disposable temp directory and print a ready-to-pipe prompt. Nothing is installed — no lockfile entry, no pointers, no writes into any workspace. Use it to trial a skill for a single session.

```bash
straper use <module> [options]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dir <path>` | string | Current directory | Workspace directory (used only for resolution context). |
| `--registry <dir>` | string | Bundled registry | Registry directory. Overrides `STRAPER_REGISTRY_DIR`. |

The temp directory lives in the OS temp dir and can be removed anytime.

## straper update

Update vendored modules to the current registry version via a three-way merge that preserves your local edits. With no module arguments, every module in the lockfile is updated.

```bash
straper update [module...] [options]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dir <path>` | string | Current directory | Workspace directory. |
| `--registry <dir>` | string | Bundled registry | Registry directory. Overrides `STRAPER_REGISTRY_DIR`. |

For each module, Straper merges three versions: the pristine baseline in `.straper/base/<name>/`, your current working files, and the new registry bytes. Files you have not touched update cleanly; files you have edited are merged; genuine conflicts get standard `<<<<<<<`/`>>>>>>>` markers and are listed at the end. A customized consumer pointer is preserved rather than overwritten. Exits non-zero if there are conflicts or errors.

## straper doctor

Read-only health check of vendored modules. Exits non-zero only when there are real problems (missing files, unresolved conflict markers, missing pointer or baseline) — purely local modifications are reported as info, not failures.

```bash
straper doctor [--dir <path>]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dir <path>` | string | Current directory | Workspace directory. |

Reports, per module: `✓` healthy, `~` locally modified (info), `✗` a problem. It also flags orphans — `skills/<name>/` directories not present in `straper.lock`.

## straper publish

Publish a workspace skill (`skills/<module>/`) into a Straper registry checkout. Intended for module authors. Privilege is environmental: the command refuses unless the workspace carries both a gate engine (`skills/scrub/scrub.sh`) and gate config (`config/publish-gate.conf`).

```bash
straper publish <module> [options]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dir <path>` | string | Current directory | Workspace containing the skill to publish. |
| `--registry-repo <path>` | string | `STRAPER_REGISTRY_REPO` | Registry repo checkout to publish into. Required (flag or env). The bundled read-only registry is not a valid target. |

What it does: publishes exactly what HEAD tracks (the skill must be committed), runs the publish-profile scrub gate, verifies the skill is self-contained (every cross-skill reference declared as a dependency), bumps the patch version, then creates a branch and worktree in the registry repo, writes `module.json`, `CHANGELOG.md`, and a registry-surface `SKILL.md`, and commits. You review the branch, push, and open a PR — publish never pushes for you.

## straper migrate

Migrate a pre-registry workspace to the registry model. This command is being reworked; behavior may change.

```bash
straper migrate [options]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dir <path>` | string | Current directory | Workspace directory. |
| `--dry-run` | flag | off | Show planned changes without modifying files. |
| `--skip-validate` | flag | off | Skip post-migration validation. |

## straper status

Show health status of all registered workspaces.

```bash
straper status
```

No flags. Reads the workspace registry from `~/.config/straper/workspaces.json` and checks each workspace for: directory exists, number of active tasks (status is not `done`), number of open feature designs, number of active worktrees.

### Example Output

```
Straper workspaces:

  myagent  ~/Developer/myagent
    ✓ Directory exists
    ✓ 2 active tasks
    ✓ 1 open design
    ✓ 0 active worktrees

2 workspaces registered
```

## straper --version

Print the version number.

```bash
straper --version   # e.g. 0.1.0
```

## straper --help

Show usage help. Also triggered when Straper is called with no arguments.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STRAPER_REGISTRY_DIR` | Bundled registry | Registry directory used by `add`, `use`, `update`, and `init --adopt` when `--registry` is not passed. |
| `STRAPER_REGISTRY_REPO` | -- | Registry repo checkout that `publish` targets when `--registry-repo` is not passed. |
| `STRAPER_NO_AGENTS_DIR` | unset | Set to `1` to skip the universal `.agents/skills/` pointer on `add` (same as `--no-agents-dir`). |
| `STRAPER_SKIP_CLI_INSTALL` | unset | Set to `1` to skip installing the agent CLI to your PATH during `init` (useful in tests and sandboxes). |
| `XDG_CONFIG_HOME` | `~/.config` | Base directory for Straper's global config. Straper stores its config in `$XDG_CONFIG_HOME/straper/`. |

## Global Config

Straper stores global configuration at `~/.config/straper/` (or `$XDG_CONFIG_HOME/straper/`).

### Directory Structure

```
~/.config/straper/
├── config.json       # User defaults (name, role, provider, CLI install target)
├── shared/           # Files copied into every new workspace on init
│   └── USER.md       # Shared user profile (optional)
└── workspaces.json   # Registry of all created workspaces
```

### config.json

Created on your first `straper init`. Subsequent inits reuse these values as defaults.

```json
{
  "version": 1,
  "user": {
    "name": "Your Name",
    "role": "Software Engineer"
  },
  "defaults": {
    "provider": "claude",
    "branch_prefix": ""
  },
  "cli": {
    "install_target": "~/.local/bin"
  }
}
```

### workspaces.json

Updated every time you run `straper init`. Used by `straper status` to find workspaces.

```json
{
  "version": 1,
  "workspaces": [
    {
      "name": "myagent",
      "path": "/Users/you/myagent",
      "agent": "myagent",
      "created_at": "2026-03-18"
    }
  ]
}
```

### shared/

Place files here that you want copied into every new workspace. For example, a `USER.md` at `~/.config/straper/shared/USER.md` is copied into every future workspace root, overwriting the generated template.

## CLI Install Target

When `straper init` runs, it tries to install the agent-named CLI script to your PATH. It checks directories in this order:

1. `config.json` -> `cli.install_target` (if configured)
2. `~/.local/bin/`
3. `~/bin/`

If none exist, Straper skips the install and prints instructions for running the CLI directly via `./scripts/<agent-name>`. Set `STRAPER_SKIP_CLI_INSTALL=1` to skip the install entirely.

To install manually after init:

```bash
cd ~/myagent
./scripts/install-cli.sh ~/.local/bin
```
