---
name: memory
description: Manage workspace memory — daily logs, feedback, project context, and references
version: 1
visibility: user
triggers:
  - /memory
  - hook:SessionStart
  - hook:SessionEnd
backing_script: memory.sh
depends_on: []
composes: []
---

# Memory Skill

Manage the workspace memory system: daily logs, typed memory files (user, feedback, project, reference), and the `MEMORY.md` index.

The backing script is `skills/memory/memory.sh`. Data lives at workspace root: `MEMORY.md` and `memory/`.

---

## Purpose

Consolidate all memory operations into a single skill. Covers daily log creation, typed memory file management, index regeneration, and the validation checks used by session-start and session-end hooks.

Memory files use four types, each with YAML frontmatter:

| Type | Naming | Purpose |
|------|--------|---------|
| `user` | `user_<name>.md` | The user's goals, preferences, growth areas |
| `feedback` | `feedback_<name>.md` | Working style feedback, process preferences |
| `project` | `project_<name>.md` | Project-specific context and decisions |
| `reference` | `reference_<name>.md` | Durable reference material (tools, protocols, catalogs) |

Daily logs (`YYYY-MM-DD.md`) do not have frontmatter — they are plain markdown with session notes, decisions, and blockers.

---

## Arguments

```
/memory                                          Show today's memory status
/memory save <type> <name> "<content>"           Create a typed memory file
/memory index                                    Regenerate MEMORY.md from memory/ files
/memory status                                   Summary of all memory files
```

| Argument | Required | Description |
|----------|----------|-------------|
| (none) | -- | Show today's daily log status |
| `save` | -- | Create a new typed memory file |
| `<type>` | yes (for save) | One of: `user`, `feedback`, `project`, `reference` |
| `<name>` | yes (for save) | Short kebab-case identifier (e.g., `rebase-not-merge`) |
| `<content>` | yes (for save) | Body text for the memory file |
| `index` | -- | Rebuild MEMORY.md by scanning `memory/` |
| `status` | -- | Count files by type, find orphans |

---

## Execution

### Default: `/memory`

Show today's memory status.

```bash
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SKILL_DIR/memory.sh"
memory_status_today
```

Report:
- Whether today's daily log exists
- Whether today's daily log has content beyond the empty template
- When `MEMORY.md` was last modified (relative: "2h ago", "3 days ago")
- Count of typed memory files by type

### `save <type> <name> "<content>"`

Create a new typed memory file with frontmatter and update `MEMORY.md`.

1. Validate `<type>` is one of: `user`, `feedback`, `project`, `reference`.
2. Run the backing script:

```bash
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SKILL_DIR/memory.sh"
memory_save "<type>" "<name>" "<content>"
```

3. The script creates `memory/<type>_<name>.md` with frontmatter:

```yaml
---
name: <human-readable name derived from kebab-case>
description: <first line of content>
type: <type>
---
```

4. Appends a link to `MEMORY.md` in the appropriate section.
5. Report: "Saved memory/<type>_<name>.md and updated MEMORY.md index."

### `index`

Regenerate `MEMORY.md` by scanning all files in `memory/`.

```bash
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SKILL_DIR/memory.sh"
memory_regenerate_index
```

The function:
1. Scans all `.md` files in `memory/`.
2. Reads frontmatter from typed files (name, description, type).
3. Groups typed files by type into sections: `## Feedback`, `## Project Context`, `## Observability & Incident Response`, `## Company Context`, etc.
4. Lists daily logs in a separate section.
5. Preserves manually curated sections in `MEMORY.md` that are not auto-generated (like `## Active Tasks`, `## Key Repos`, `## Learned Preferences`, `## Known Gotchas`, `## Skills`, `## Feature Design System`, etc.).

Report: "Regenerated MEMORY.md — N typed files, M daily logs."

### `status`

Show a summary of all memory files.

```bash
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SKILL_DIR/memory.sh"
memory_list_status
```

Report:
- Count of files by type (user, feedback, project, reference, daily log)
- Last modified date of `MEMORY.md`
- Orphan files (files in `memory/` with frontmatter but not linked in `MEMORY.md`)

### Hook: `SessionStart`

Called by `scripts/session-start.sh` to load memory context and create today's daily log.

```bash
SKILL_DIR="skills/memory"
source "$SKILL_DIR/memory.sh"
memory_load_context      # Load MEMORY.md + today/yesterday daily logs
memory_create_daily_log  # Create today's template if missing
```

### Hook: `SessionEnd`

Called by `scripts/session-end.sh` to validate memory state.

```bash
SKILL_DIR="skills/memory"
source "$SKILL_DIR/memory.sh"
memory_validate          # Check today's daily log exists and has content
```

---

## Examples

```
/memory
-> Today's daily log: memory/2026-03-20.md (exists, has content)
   MEMORY.md last updated: 2h ago
   Typed files: 4 user, 15 feedback, 5 project, 3 reference

/memory save feedback rebase-not-merge "Use rebase, not merge, when updating feature branches with main. The team prefers clean linear history."
-> Saved memory/feedback_rebase-not-merge.md and updated MEMORY.md index.

/memory save project env-cache-purge "Cache purge fix needed in the backend api. The enable handler doesn't purge the Redis cache, causing 404s."
-> Saved memory/project_env-cache-purge.md and updated MEMORY.md index.

/memory index
-> Regenerated MEMORY.md — 27 typed files, 9 daily logs.

/memory status
-> Memory summary:
   user:      1 file
   feedback: 15 files
   project:   5 files
   reference: 3 files
   daily:     9 files
   Total:    33 files
   MEMORY.md: last modified 2026-03-20
   Orphans:   0
```

---

## Graceful Degradation

- Missing `memory/` directory: created automatically on first `save` or `create_daily_log`.
- Missing `MEMORY.md`: created from scratch on `index`. Other commands report "MEMORY.md not found" without crashing.
- Typed file without frontmatter: skipped during index regeneration with a warning.
- Daily log files (no frontmatter): handled separately from typed files in all operations.

## Metrics

The `save-daily-summary` action is logged automatically by the composition engine
(the `SessionEnd` pipeline invokes `memory` as a compose target). For an
agent-initiated `/memory` invocation that does NOT run through composition, log it
by calling the shared helper — never hand-write the JSON:

```bash
source scripts/lib/skills.sh
skills_log_event memory "<action>" /memory <duration_ms> true "" "<model-id>"
```

`<action>` is the resolved subcommand (`save` / `index` / `status` / default).
`skills_log_event` builds the row via jq and pins `at` to UTC `Z`. If `.metrics/`
is unavailable, skip silently — never fail the run over metrics.
