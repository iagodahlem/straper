# Templates

This page explains how the Straper template system works: what variables are available, how files are processed, how filenames get renamed, and how to customize generated files after init.

## How Template Processing Works

Straper uses a simple `{{variable}}` substitution system. There is no logic, no conditionals, no loops — just find-and-replace. This keeps templates readable and predictable.

When you run `straper init`, three things happen to files in `scaffold/`:

1. **`.tmpl` files** — Read as text, all `{{variable}}` placeholders are replaced with their values, then written to the workspace with the `.tmpl` extension removed. Example: `SOUL.md.tmpl` becomes `SOUL.md`.

2. **Files with `{{agent_name}}` in the filename** — The filename is rewritten with the agent name substituted. The file content is copied as-is (not template-processed). Example: `{{agent_name}}.js` becomes `nova.js`.

3. **All other files** — Copied verbatim with no changes.

## Template Variables

These variables are available in `.tmpl` files during `straper init`:

| Variable | Description | Example Value |
|----------|-------------|---------------|
| `{{agent_name}}` | The agent name you passed to `straper init`. Always lowercase. | `nova` |
| `{{agent_display_name}}` | The agent name with the first letter capitalized. | `Nova` |
| `{{user_name}}` | Your name, from the `--user` flag or global config. | `Alice Smith` |
| `{{user_role}}` | Your role, from the `--role` flag or global config. Defaults to `"Software Engineer"`. | `Software Engineer` |
| `{{project_name}}` | The project name, from the `--project` flag. Defaults to the capitalized agent name. | `Acme Support` |
| `{{project_description}}` | The project description, from the `--description` flag. Defaults to empty string. | `Customer support agent` |
| `{{workspace_dir}}` | The absolute path to the workspace directory. | `/home/user/nova` |
| `{{year}}` | The current year at init time. Used in LICENSE and copyright notices. | `2026` |

## Where Templates Live

```
scaffold/
├── templates/           # Processed with variable substitution
│   ├── AGENTS.md.tmpl   # -> AGENTS.md (main agent instructions)
│   ├── SOUL.md.tmpl     # -> SOUL.md (agent persona)
│   ├── USER.md.tmpl     # -> USER.md (user profile)
│   ├── TOOLS.md.tmpl    # -> TOOLS.md (tooling conventions)
│   ├── BOOT.md.tmpl     # -> BOOT.md (session startup)
│   ├── MEMORY.md.tmpl   # -> MEMORY.md (long-term memory)
│   ├── preferences.json.tmpl  # -> preferences.json
│   └── .gitignore.tmpl  # -> .gitignore
├── claude/              # Processed with variable substitution
│   └── settings.json.tmpl     # -> .claude/settings.json
└── config/              # Processed with variable substitution
    └── providers.json.tmpl    # -> config/providers.json
```

Skill command pointers are not scaffolded here — `straper add` writes `.claude/skills/<name>/SKILL.md` and `.agents/skills/<name>/SKILL.md` when a skill is installed. See [Concepts: The Skill Registry](concepts.md#the-skill-registry).

## Filename Variable Substitution

Files in `scaffold/scripts/` can have `{{agent_name}}` in their filename. When Straper copies these files, it replaces the placeholder with the actual agent name:

```
scaffold/scripts/{{agent_name}}.js   ->   scripts/nova.js
scaffold/scripts/{{agent_name}}      ->   scripts/nova
```

This naming gives each agent its own CLI identity. When you install the CLI to your PATH, the command matches the agent name:

```bash
nova fd-status        # in the Nova workspace
myagent fd-status    # in a different workspace
```

Only `{{agent_name}}` is supported in filenames. Content-level variables (`{{user_name}}`, etc.) are only available in `.tmpl` files.

## Customizing Generated Files After Init

Every file Straper *scaffolds* is yours to modify — once it is in your workspace, you own it completely, and Straper never touches it again. (Vendored registry skills are different: they are also yours to edit, but `straper update` can merge upstream changes into them. See [Concepts: The Skill Registry](concepts.md#the-skill-registry).)

Common customizations after init:

- **USER.md** — Fill in your team members, working style, strengths, and growth areas. The template provides a structure with placeholders.
- **SOUL.md** — Adjust the agent's persona, tone, and decision framework. Change what the agent does autonomously vs. what it checks with you first.
- **TOOLS.md** — Add project-specific tooling instructions. The template covers the general framework; you add repo-specific details.
- **MEMORY.md** — This starts mostly empty. The agent populates it over time, but you can seed it with information you want the agent to know from day one.
- **preferences.json** — Change commit style, branch prefix, worktree naming, subagent limits. See [preferences.md](preferences.md).
- **.claude/settings.json** — Add more allowed commands or modify session hooks.

## Adding Your Own Templates

If you want to modify what Straper generates for future workspaces, edit the files in `scaffold/` directly.

### Add a new template file

1. Create the file in `scaffold/templates/` with a `.tmpl` extension:

   ```
   scaffold/templates/MY_GUIDE.md.tmpl
   ```

2. Use `{{variable}}` placeholders for dynamic content:

   ```markdown
   # {{project_name}} Guide

   Written by {{user_name}}.
   ```

3. The next time you run `straper init`, the file will appear in the workspace root as `MY_GUIDE.md` with all variables substituted.

### Add a new static file

Place it in the appropriate `scaffold/` subdirectory without a `.tmpl` extension. It will be copied verbatim:

```
scaffold/scripts/my-script.sh     ->   scripts/my-script.sh
scaffold/designs/my-template.md   ->   designs/my-template.md
```

### Add a new file with agent-name substitution

Use `{{agent_name}}` in the filename (only works in `scaffold/scripts/`):

```
scaffold/scripts/{{agent_name}}-helper.sh   ->   scripts/nova-helper.sh
```

## Technical Details

The template engine is implemented in `src/scaffold.ts`. The key functions:

- `renderTemplate(content, vars)` — Replaces all `{{variable}}` placeholders in a string. Throws if a variable is not recognized.
- `processTemplate(templatePath, outputDir, vars)` — Reads a `.tmpl` file, renders it, writes the output with the `.tmpl` extension stripped.
- `processScaffoldDir(scaffoldDir, outputDir, vars)` — Walks an entire directory: processes `.tmpl` files, copies other files with filename renaming, recurses into subdirectories. Skips `.gitkeep` files.
- `copyWithRename(source, dest, vars)` — Copies a file or directory, replacing `{{agent_name}}` in filenames.
