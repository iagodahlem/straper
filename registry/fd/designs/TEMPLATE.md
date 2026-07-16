---
id: FD-XXX
title:
status: planned  # planned | design | open | in_progress | verification | complete | archived
effort: medium   # small | medium | large
priority: medium # low | medium | high | critical
repo:
provider_hint:
profile_hint:
branch_suffix:
verification_command:
tasks: []        # linked TASK-xxx IDs
---

## Problem

[What problem are we solving? Why does it matter?]

## Context

[Research findings, backend state, design references, prior art. Include links to relevant code, PRs, or external resources.]

## Solution

[Chosen approach. Be specific enough that an agent can implement without additional context.]

## Files to Modify

[Explicit list of files that need changes. This is what makes the design executable by agents.]

- `path/to/file.ts` -- description of change
- `path/to/new-file.ts` (new) -- what this file does

## Sub-items

[Break the work into ordered, independently-executable pieces with dependencies.]

| Step | What | Depends on | Status |
|------|------|------------|--------|
| A1   |      |            | todo   |
| A2   |      |            | todo   |

### Sub-item conventions

- **A-items** (A1, A2...) -- feature implementation steps
- **F-items** (F1, F2...) -- fixes discovered during QA (added after initial implementation)
- **R-items** (R1, R2...) -- refactoring tasks (can be backlogged)
- **T-items** (T1, T2...) -- test writing (e2e, integration, unit)

### Branching

Each sub-item gets its own branch. Combined branch uses **rebase** (never merge) for clean linear history:
```bash
git checkout <combined-branch>
git rebase <sub-item-branch>
```

## Verification

[How to validate the implementation -- typecheck, lint, visual QA, test scenarios.]

- [ ] Verification step 1
- [ ] Verification step 2

## Open Questions

[Unresolved decisions that may affect implementation.]

- [ ] Question 1
