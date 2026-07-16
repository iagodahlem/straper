---
name: workspace-review
description: On-demand workspace health & learning review — skill drift, memory/pointer integrity, tracking drift, and feedback harvest into candidate skills
version: 1
visibility: user
triggers:
  - /workspace-review
backing_script: workspace-review-commands.js
cli_command: workspace-review
depends_on:
  - memory
  - fd
  - task
composes: []
---

## Purpose

Run an on-demand HEALTH & LEARNING review of the workspace: audit skill drift and self-containment, check memory/pointer integrity, flag tracking drift, and harvest recurring feedback/repeated actions into ranked candidate skills. Everything is read-only and advisory — nothing is mutated and nothing is created without the user's explicit ack.

This is distinct from `session-review`, which is per-session WORK TRACKING (tasks, FDs, worktrees, blockers — runs at `SessionEnd`). `workspace-review` is workspace HEALTH & LEARNING and is invoked on demand. Don't confuse the two: if you want "what did this session do, is tracking up to date" use `/session-review`; if you want "is the workspace healthy, are skills self-contained, what should become a skill" use `/workspace-review`.

## Arguments

```
/workspace-review
/workspace-review skillify <candidate> [--with-script] [--dry-run]
```

| Argument | Required | Description |
|----------|----------|-------------|
| (none) | — | Run the three deterministic scans + point at the agent-driven harvest. |
| `skillify <candidate>` | — | Scaffold an ACKED harvest candidate into a new skill (see Skillify below). |
| `--with-script` | no | (skillify) Also scaffold a `<name>-commands.js` backing module + wire-up notes. |
| `--dry-run` | no | (skillify) Show what would be created without writing files. |

## Execution

### Deterministic scans (1-3)

1. Run `./scripts/<agent> workspace-review`. This executes three read-only scans:
   - **Scan 1 — Skill drift & self-containment.** Reuses `skills_validate` over all skills (no reimplementation), diffs a freshly generated index against the committed `skills/INDEX.md` for staleness, and greps every `skills/*/` dir for hardcoded absolute paths (`/Users/` or `~/Developer/malvin`). SCHEMA.md mandates self-containment but the validator doesn't enforce it, so these surface here.
   - **Scan 2 — Memory / pointer integrity.** Cross-checks `MEMORY.md` `feedback_*` references against on-disk `memory/feedback_*.md` files. Flags orphans (on disk, not indexed) and broken pointers (indexed, missing).
   - **Scan 3 — Tracking drift.** Flags `in_progress` tasks with `failed` workers, and FDs that look implemented-in-code but are still `status:design`/`open`/`planned` (best-effort heuristic — advisory, verify before acting).
2. Read the report. The scans never mutate anything — they regenerate the index into a temp comparison and restore the committed bytes.

### Agent-driven harvest (4)

3. Follow `prompts/workspace-review.md` (rendered by the agent) to run the **feedback & repeated-action harvest**: read `memory/feedback_*.md`, `MEMORY.md`, recent `memory/YYYY-MM-DD.md`, and best-effort usage signal to surface recurring frustrations / repeated tool sequences that are candidates to become skills. Output is RANKED candidate skills, each with a skillify sketch (proposed purpose, whether a backing script is needed, optional hook).
4. **Advisory + ack-gated.** Nothing is created. Surface the candidates to the user. Promote a candidate to a real skill only on their explicit ack (mirror the pulse/boot ack-gated model).

### Skillify (after ack)

5. Once the user acks a candidate, run `./scripts/<agent> workspace-review skillify <candidate> [--with-script]`. This scaffolds `skills/<candidate>/` from the SCHEMA template, stubs a backing script if needed, prints the CLI wire-up steps, and emits the 10-step skill-authoring checklist as a worker-dispatch plan. It scaffolds + checklists — it does NOT fully autogenerate the skill.
6. Wire `cli_command` into `scripts/<agent>.js` (route + `SKILL_BY_COMMAND`) if the skill has a CLI path, then run `./scripts/<agent> skills validate <candidate>` until it passes and `./scripts/<agent> skills sync` to regenerate the index + command pointer.

#### Why skillify is a sub-command, not a top-level skill

Candidate SELECTION lives in the harvest (scan 4) — that's the only place a candidate gets identified and ranked. A bare `/skillify` has no entry point: there's nothing to skillify until the harvest names a candidate and the user acks it. Folding it in as `workspace-review skillify <candidate>` keeps selection and scaffolding in one coherent flow.

## Examples

```
/workspace-review
→ Runs scans 1-3 (skill drift, memory integrity, tracking drift), then points at
  the agent-driven harvest. Catches orphan feedback files and implemented-but-open FDs.

/workspace-review skillify pull-before-research --dry-run
→ Shows the skills/pull-before-research/ scaffold + FD-019 checklist without writing.

/workspace-review skillify pull-before-research --with-script
→ Scaffolds skills/pull-before-research/{pull-before-research.md, pull-before-research-commands.js}
  + prints CLI wire-up steps + the 10-step worker plan.
```

## Graceful Degradation

If `memory`, `fd`, or `task` skills/data are unavailable, the relevant scan reports what it could not read and the others still run. The skillify scaffold refuses if the target `skills/<name>/` already exists.

## Metrics

Covered automatically via the `scripts/<agent>.js` CLI chokepoint: every `<agent> workspace-review ...` invocation logs a row to `.metrics/skills.jsonl` (skill `workspace-review`, measured `duration_ms`, `ok` from exit status, `trigger: cli`). No per-skill code needed. When an agent runs the harvest (scan 4) without a CLI call, it should additionally log via the shared helper — never hand-write the JSON:

```bash
source scripts/lib/skills.sh
skills_log_event workspace-review harvest /workspace-review <duration_ms> true "" "<model-id>"
```
