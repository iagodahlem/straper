---
name: fd
description: Feature design lifecycle — create, work, track status, and close feature designs
version: 1
visibility: user
triggers:
  - /fd
backing_script: fd-commands.js
cli_command: fd
depends_on:
  - task
composes: []
---

## Purpose

Manage the full feature design lifecycle — from creation through implementation to archival. Feature designs live in `designs/` at the workspace root and are the contract between planning and implementation.

## Arguments

```
/fd new <title> [--effort small|medium|large] [--priority low|medium|high|critical] [--repo <repo>]
/fd work <FD-ID> <SUB-ITEM> [--base <branch>]
/fd status
/fd close <FD-ID> [--force]
```

| Subcommand | Description |
|------------|-------------|
| `new` | Create a new feature design from template and update the design index. |
| `work` | Generate a worker prompt for a specific sub-item and follow it. |
| `status` | Show all feature designs with sub-item progress and worker status. |
| `close` | Archive a completed feature design and update linked tasks. |

## Execution

### new

Create a new feature design.

1. Run:
   ```bash
   ./scripts/<agent> fd-new <title> [--effort <effort>] [--priority <priority>] [--repo <repo>] [--provider-hint <provider>] [--profile-hint <profile>] [--branch-suffix <suffix>] [--verification-command <command>]
   ```
2. The command creates `designs/FD-NNN.md` from the template and appends it to `designs/INDEX.md`.
3. Return the output to the user.
4. For prompt-based creation (agent-driven fleshing out), use:
   ```bash
   ./scripts/<agent> fd-new-prompt <title> [same flags]
   ```
   Then follow the rendered instructions to flesh out the design.

### work

Bootstrap a worker for a feature design sub-item.

1. Run:
   ```bash
   ./scripts/<agent> fd-work-prompt <FD-ID> <SUB-ITEM> [--base <branch>]
   ```
2. Follow the rendered instructions exactly.
3. When you need a worktree, prefer the canonical command:
   ```bash
   ./scripts/<agent> worktree <repo> <branch-name> [--base <branch>]
   ```

### status

Show the status of all feature designs.

1. Run:
   ```bash
   ./scripts/<agent> fd-status
   ```
2. Return the command output to the user as the status report.

### close

Archive a completed feature design.

1. Run:
   ```bash
   ./scripts/<agent> fd-close <FD-ID> [--force] [--dry-run]
   ```
2. The command moves the design to `designs/archive/`, removes it from the index, and logs completion in linked tasks.
3. Use `--force` to archive even if sub-items are pending or verification items are unchecked.
4. Return the output to the user.

## Examples

```
/fd new "SCIM Phase 3" --effort large --priority high --repo dashboard
-> Creates designs/FD-007.md, updates INDEX.md

/fd work FD-005 A1
-> Generates worker prompt for FD-005 sub-item A1, follows instructions

/fd status
-> Prints table of all designs with progress, workers, and ready sub-items

/fd close FD-003
-> Archives FD-003, updates linked task logs

/fd close FD-005 --force
-> Archives FD-005 even with pending sub-items
```

## Bundled files

The module is self-contained. It ships:

- `skills/fd/providers.json.example` — a template for the worker provider/profile map (`claude`/`codex`, `fast`/`strong`). `worker` reads the live config from `config/providers.json` at the workspace root; copy this example there and edit the models to configure providers.
- `skills/fd/designs/TEMPLATE.md` and `skills/fd/designs/INDEX.md` — seed copies of the feature-design template and index. `fd-new` renders `designs/TEMPLATE.md` from the workspace when it exists and falls back to the bundled `skills/fd/designs/TEMPLATE.md`, so a fresh workspace can create designs before it has its own `designs/` seed.
- `skills/fd/prompts/` — the `fd-new` and `fd-work` prompt templates.

## Graceful Degradation

If the `task` skill is unavailable, the `new` and `close` commands still work but skip task log updates. The `status` command omits worker tracking information for designs without linked tasks.
