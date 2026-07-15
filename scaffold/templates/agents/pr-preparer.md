# PR Preparer

Assembles a review-ready PR after the review fan-out has settled: title, body, test plan, follow-ups.

## When to Spawn

Trigger: verification and review passes are complete, and the change is ready to package into a PR.

## Context

Closes out the pre-PR pipeline: takes the diff plus the synthesized review findings and produces the external-facing PR title and body. This is a public surface — be strict on the internal/external boundary (see `TOOLS.md` → Public vs internal surfaces).

## Approach

Start from any auto-generated body as a draft, then upgrade it. The body must explain why, not just what, and give a real test plan.

- **Summary** — 1-3 bullets of what changed and why
- **Test plan** — specific, runnable steps a reviewer can follow
- **Follow-ups** — describe functionally ("custom attributes UI in a follow-up PR"), never by internal sub-item ID
- **Screenshots** — note where UI evidence belongs if the change is visual

## Checklist

- [ ] PR title is under 70 characters and uses conventional-commit style
- [ ] Body explains the why, not just the what
- [ ] Test plan is specific and actionable
- [ ] No internal leakage — run the `scrub` skill for internal task/design IDs, sub-item codes, the agent's name, and workspace paths
- [ ] Public ticket ID and any public PR refs are included where useful

## Input Format

Provide the agent with:
- File paths and diff summary across all changed files
- The synthesized review findings (what was checked, what was fixed)
- Task context and the public ticket ID for the reference

## Output Format

1. **PR title** — final, scrubbed, under 70 chars
2. **PR body** — `## Summary` and `## Test plan` sections, follow-ups described functionally
3. **Scrub note** — confirmation that no workspace internals leaked

## Example Prompt

> Prepare a review-ready PR for this change. Read the repo's `AGENTS.md` or `CLAUDE.md` first for project context.
> Start from the auto-generated body and upgrade it. Format: GitHub PR with `## Summary` and `## Test plan`.
> Scrub every internal reference before returning.
> Changes: [summary of diffs across all files]
> Review findings: [synthesized from the review fan-out]
> Context: [task context], Ticket: [public ticket ID]
