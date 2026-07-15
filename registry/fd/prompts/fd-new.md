You are preparing a new feature design entry in this workspace.

Workspace-generated assignment:

- Title: `{{TITLE}}`
- Effort: `{{EFFORT}}`
- Priority: `{{PRIORITY}}`
{{REPO_LINE}}
{{PROVIDER_HINT_LINE}}
{{PROFILE_HINT_LINE}}
{{BRANCH_SUFFIX_LINE}}
{{VERIFICATION_COMMAND_LINE}}

Follow these steps exactly:

1. Run `./scripts/<agent> fd-new ...` with the provided arguments unless the design already exists.
2. Flesh out the generated design with a concrete problem statement, context, solution, files to modify, sub-items, and verification.
3. Preserve the structured frontmatter fields so workers can self-assign later.
4. If the design is linked to an existing task, update that task with `./scripts/task design <TASK-ID> <FD-ID>`.
5. Report the new FD ID, any open questions, and the next recommended sub-items.
