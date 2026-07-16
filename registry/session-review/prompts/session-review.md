You are running the end-of-session review workflow.

Workspace-generated assignment:

- Run session-end script: `{{RUN_SESSION_END}}`
- Dry run: `{{DRY_RUN}}`

Follow these steps exactly:

1. Run `./scripts/<agent> session-review ...` with the provided arguments.
2. Review active tasks, linked feature designs, worker state, and stale worktrees.
3. Call out any blockers, missing logs, or untracked branches/worktrees.
4. If session end is enabled, confirm whether `./scripts/session-end.sh` succeeded.
