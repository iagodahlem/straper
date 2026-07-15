---
name: review
description: Pre-PR review fan-out — apply the Domain-Specific Spawn Rules to a worktree diff and emit ready-to-dispatch parallel reviewer prompts
version: 1
visibility: user
triggers:
  - /review
backing_script: review-commands.js
depends_on: []
composes: []
---

## Purpose

Automate the pre-PR review fan-out (Orchestration Pipeline + Domain-Specific Spawn Rules). Given a worktree, it computes the diff, applies the spawn rules deterministically, and emits one ready-to-dispatch parallel-subagent prompt per matched reviewer. It does not spawn the subagents — the orchestrator dispatches them in parallel (up to 5, read-only) and synthesizes the findings.

## Arguments

```
/review [<worktree>] [--base <branch>] [--ci]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `<worktree>` | no | Worktree name under `workspaces/`. Auto-detected from cwd if omitted. |
| `--base <branch>` | no | Base branch for the diff. Defaults to the repo's default branch (usually `main`). |
| `--ci` | no | Signal that CI checks are failing on the PR. Adds a Test Results Analyzer pass. |

## Execution

1. Run the backing helper to compute the diff and matched reviewers:
   ```bash
   node skills/review/review-commands.js <worktree> [--base <branch>] [--ci]
   ```
   The helper:
   a. Resolves the worktree path (`workspaces/<worktree>`) and its repo.
   b. Computes the changed files and diff stat against `origin/<base>...HEAD`.
   c. Resolves the linked task/FD context (so reviewers get the "why").
   d. Applies the Domain-Specific Spawn Rules (see below) and prints one ready-to-dispatch prompt per matched reviewer.
   e. Runs the comment-density advisory check on the same diff (see below) and prints a warning line per flagged file — silent when nothing crosses the threshold.

2. Read the emitted prompts. Each is pre-filled with the changed-file list, the task/FD context, the matched `agents/<profile>.md` reference, and the mandatory boilerplate ("Read the repo's `AGENTS.md` or `CLAUDE.md`" + "run `/investigate <repo>` before any repo read" + "read-only").

3. Dispatch the prompts as parallel subagents — up to 5 at a time, all read-only — using the `subagent_type` named in each prompt. Skip any pass marked optional whose `agents/<profile>.md` does not exist.

4. Collect every reviewer's structured report and synthesize: dedupe overlapping findings, rank by severity (Must fix → Suggestions → Nits), and surface blocking issues first.

5. Hand the synthesis back to the orchestrator. Blocking findings gate the PR; the clean diff proceeds to PR preparation (`pr-preparer`).

### Domain-Specific Spawn Rules

Applied deterministically by the backing helper from an ordered rule set. Each matched rule contributes its reviewers (deduped by profile — first seen per profile wins, so order matters). The rule set is read from `review.rules` in `config/workspace.json` when present; otherwise the generic defaults below apply.

Generic defaults (no config):

| Condition | Reviewer | Profile |
|-----------|----------|---------|
| Always | Code Reviewer | `agents/code-reviewer.md` |
| Repo contains `go.mod` | Go Reviewer | `agents/go-reviewer.md` |
| `auth\|token\|secret\|session\|credential\|password` paths | Security Reviewer | `agents/security-reviewer.md` |

Each rule is `{ label?, match, reviewers[] }`. A rule fires when every condition in `match` holds; supported conditions are `always`, `repo` (exact name), `repoHasFile` (worktree contains the file, e.g. `go.mod`), `pathPattern` (regex over changed files), `minFiles` (changed-file count `>=`), `crossRepo`, and `ciFailures` (from `--ci`). Add rules for your own repos, security-sensitive paths, CI triage, docs passes, or accessibility audits by extending `review.rules`.

### Comment-density advisory

Backed by `skills/review/comment-density.js`. Runs on every invocation as part of the diff computation, alongside (not part of) the Domain-Specific Spawn Rules above — it's advisory only, never a reviewer dispatch and never a blocking gate. The rationale: individually-defensible comments still add up to a wall of prose in aggregate.

For each changed file with a recognized extension (`.js`/`.ts`/`.tsx`/`.go`/... for `//` + `/* */`, `.sh`/`.py`/`.exp`/... for `#`, `.sql` for `--`), it checks the lines ADDED in the diff (unrecognized extensions, e.g. `.md`/`.json`, are skipped — not evaluated) for two independent signals, either of which flags the file:

- **Ratio** — comment lines / total added lines >= 16%.
- **Chunks** — count of "comment (or comment block) immediately followed by code" repeats (an approximation of "one comment per sequential step", not a precise measurement) >= 5, at a rate of >= 0.10 per added code line.

Files with fewer than 20 non-blank added lines are skipped outright — too small a sample for either signal to mean anything.

Thresholds were calibrated against real diffs, not guessed. Representative calibration points:

| File | Source | Ratio | Chunk-flagged | Verdict |
|------|--------|-------|----------------|---------|
| a comment-heavy shell hook | diff | 47.6% | yes (22 chunks) | flagged (both signals) |
| a comment-heavy expect script | diff | 42.1% | yes (7 chunks) | flagged (both signals) |
| a moderately-commented shell script | diff | 17.3% | no | flagged (ratio only) |
| a normal library file | whole file (comparison) | 7.9% | no | clean |
| a lightly-commented module | whole file (comparison) | 0.6% | no | clean |

Output format, one line per flagged file, printed once after the diff stat and before the matched-reviewers list:

```
⚠ Comment density: skills/foo/bar.sh — 34% comment lines (12/35 added lines), consider trimming to a minimal comment density
```

When the chunk signal also fires, the line adds a clause: `..., 6 comment-before-code chunks across 18 code lines (one comment per step), consider trimming ...`. No output at all — not even a header — when no file crosses either threshold, following the self-suppressing convention for the common/clean case.

This is a per-line prefix heuristic, not a parser: it can't distinguish "one giant JSDoc wall" from "one comment per sequential step" (both trip the ratio signal), doesn't see into a block comment the diff doesn't itself open, and doesn't special-case quoted or renamed paths in the patch header. That imprecision is intentional — it's cheap, language-agnostic, and catches the comment-density complaint either way; precision on which exact pattern is present isn't the goal.

## Examples

```
/review web--yourname--feature-x
→ Diff stat + matched reviewers (Code Reviewer, Security Reviewer, Technical Writer),
  one ready-to-dispatch prompt each. The orchestrator dispatches in parallel and synthesizes.

/review api--yourname--fix-pagination
→ Go-module diff → Code Reviewer + Go Reviewer (+ Security Reviewer if a rule matches).

/review web--yourname--feature-x --ci
→ Adds a Test Results Analyzer pass for the failing CI checks.

/review
→ Auto-detect worktree from cwd, emit the matched reviewer prompts.
```

## Graceful Degradation

- If the worktree has no linked task, the emitted prompts say so and ask the orchestrator to supply the task/FD context — the fan-out still runs.
- The Accessibility Auditor pass is optional (deferred per `TOOLS.md`). The helper marks it and notes whether `agents/accessibility-auditor.md` exists; skip it when the profile is absent.
- If a matched profile file is missing, the prompt falls back to the inline role description so the reviewer still has direction.

## Metrics

After emitting the reviewer prompts, log the invocation by calling the shared helper — never
hand-write the JSON. Source the skills library and call `skills_log_event`:

```bash
source scripts/lib/skills.sh
skills_log_event review fan-out /review <duration_ms> true "" "<model-id>"
```

`skills_log_event` builds the row via jq and pins `at` to UTC `Z`. If `.metrics/` is unavailable,
skip silently — never fail the run over metrics.
