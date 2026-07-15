You are running the shared shipping workflow for a {{agent_display_name}} worktree.

Workspace-generated assignment:

- Worktree: `{{WORKTREE_NAME}}`
- Base branch: `{{BASE_BRANCH}}`
- Tier: `{{TIER}}`
- Quick mode: `{{QUICK_MODE}}`
- Skip verify: `{{SKIP_VERIFY}}`
- Push branch: `{{PUSH_BRANCH}}`
- Create PR: `{{CREATE_PR}}`

Follow these steps exactly:

1. Inspect the target worktree and confirm the intended branch and repo.
2. Run `./scripts/{{agent_name}} ship ...` with the provided arguments.
3. If the task is linked to a feature design or worker metadata, make sure PR and branch state are reflected in task tracking.
4. Summarize verification results, PR details, and any follow-up review work.
