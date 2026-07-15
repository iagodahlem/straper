---
name: skill
description: Scaffold a new self-contained skill (definition, command wrapper, opt-in config/state buckets) following the skill-owned architecture
version: 1
visibility: user
triggers:
  - /skill
backing_script: skill-commands.js
cli_command: skill
depends_on: []
composes: []
---

## Purpose

Create a new skill correct-by-construction. Emits the skill directory, a valid `<name>.md`, a `<agent>` command wrapper, and — opt-in — the `config/` (tracked) and `.state/` (gitignored) buckets with a skill-local `.gitignore`, so a skill's private config and runtime state live inside the skill from day one instead of scattered across the workspace root. See `skills/SCHEMA.md` → *Skill-owned config and state* for the architecture this enforces.

Use it whenever you're adding a skill, so the structure and wire-up are consistent every time. (The `workspace-review skillify` flow scaffolds ack-gated review candidates; this is the general-purpose creator.)

## Arguments

```
<agent> skill new <name> [--bash] [--with-config] [--with-state] [--no-script] [--dry-run]
```

| Flag | Effect |
|------|--------|
| `--bash` | Also scaffold a `<name>.sh` backing script; the command wrapper shells into it (the `service`/`patch` pattern) and `backing_script` is set. |
| `--with-config` | Add `config/<name>.json` (tracked settings the skill reads). |
| `--with-state` | Add `.state/` + a skill-local `.gitignore` (gitignored runtime bookkeeping). |
| `--no-script` | Prompt-only skill — no command wrapper, no CLI wiring. |
| `--dry-run` | Print what would be created without writing anything. |

`<name>` must be kebab-case. Fails if `skills/<name>/` already exists.

## Execution

1. `<agent> skill new <name>` with the buckets the skill needs (`--with-config`/`--with-state`/`--bash`).
2. The scaffolder writes the files and prints the manual `scripts/<agent>.js` wire-up (import, `SKILL_BY_COMMAND` entry, dispatch `case`, usage line).
3. Do the wire-up, fill in the `.md` TODOs (Purpose/Arguments/Execution/Examples), and implement the backing script if `--bash`.
4. `<agent> skills validate <name>` until it PASSes, then `<agent> skills sync` to register it in `INDEX.md` and create the `/command` pointer.

## Examples

```
# A CLI skill with tracked config + gitignored runtime state (like `service`)
<agent> skill new deploy --bash --with-config --with-state

# A prompt-only skill (no CLI)
<agent> skill new triage --no-script

# Preview without writing
<agent> skill new foo --dry-run
```
