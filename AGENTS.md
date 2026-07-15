# Straper — Agent Instructions

This file tells AI coding assistants how to work on the Straper codebase itself. If you are an AI agent, read this before doing anything.

## Project Overview

Straper is a CLI tool that scaffolds AI agent workspaces. It is built with TypeScript, uses pnpm for package management, and targets Node.js 20+. After `straper init`, generated workspaces are self-contained with no runtime dependency on Straper.

## Project Structure

```
straper/
├── src/                    # TypeScript source (compiled to dist/)
│   ├── cli.ts              # Command router -- parses args, dispatches
│   ├── commands/
│   │   ├── init.ts         # straper init -- full workspace scaffold
│   │   └── status.ts       # straper status -- health check
│   ├── scaffold.ts         # Template engine ({{variable}} substitution)
│   ├── config.ts           # Global config (~/.config/straper/)
│   ├── constants.ts        # Version, paths, defaults
│   └── __tests__/          # Unit tests (alongside source)
├── scaffold/               # Files copied into generated workspaces
│   ├── templates/          # .tmpl files -- processed with variable substitution
│   ├── scripts/            # Bash/JS scripts -- copied as-is (with filename rename)
│   ├── schemas/            # JSON schemas -- copied to tasks/
│   ├── designs/            # Feature design templates -- copied to designs/
│   ├── claude/             # Becomes .claude/ in workspace (settings + skills)
│   └── config/             # Provider config templates
├── tests/                  # Integration and e2e tests
│   ├── integration/        # straper init in temp dir, verify output
│   └── e2e/                # Full lifecycle: init -> session-start -> task ops
├── docs/                   # Documentation for humans
├── bin/straper             # CLI entry point (shim -> dist/cli.js)
├── dist/                   # Compiled JS (gitignored)
├── vitest.config.ts        # Test config with unit/integration/e2e projects
├── tsconfig.json           # Strict, ESM, target ES2022
└── eslint.config.js        # Flat config with typescript-eslint
```

## Build and Run

```bash
pnpm install        # Install dependencies
pnpm build          # Compile TypeScript to dist/
pnpm typecheck      # Type-check without emitting
pnpm lint           # Lint src/ and tests/
```

Run the CLI after building:

```bash
node bin/straper --help
node bin/straper init test-agent --dir /tmp/test-agent --user "Test" --project "Test"
```

## Testing

```bash
pnpm test                # All tests (unit + integration + e2e)
pnpm test:integration    # Integration tests only
pnpm test:e2e            # End-to-end tests only
```

Unit tests live in `src/__tests__/` alongside the source they test. Integration and e2e tests live in `tests/`. All tests use vitest.

## Code Conventions

- **TypeScript, strict mode, ESM** — `type: "module"` in package.json, `.js` extensions in imports
- **No external runtime dependencies** — the CLI has zero production dependencies. Only devDependencies (typescript, vitest, eslint)
- **Generated workspaces use plain JS/bash** — scripts in `scaffold/scripts/` are not TypeScript. They run in workspaces without a build step
- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `test:`
- **No AI-generated footers or co-authored-by lines in commits**

## How the Scaffold System Works

Three types of files in `scaffold/`:

1. **`.tmpl` files** (in `templates/` and `claude/`): Read by `processScaffoldDir`, all `{{variable}}` placeholders are replaced with values from the init command, then written to the workspace with the `.tmpl` extension stripped. Example: `SOUL.md.tmpl` becomes `SOUL.md`.

2. **Renamed files** (in `scripts/`): Files with `{{agent_name}}` in their filename get renamed. Example: `{{agent_name}}.js` becomes `nova.js` if the agent is named "nova". Content is copied as-is (not template-processed).

3. **Static files** (in `schemas/`, `designs/`): Copied verbatim with no processing.

The processing pipeline is: `processScaffoldDir()` in `src/scaffold.ts` walks the source directory, dispatches each file based on its extension, and writes the result to the output directory.

## Template Variables

These variables are available in `.tmpl` files:

| Variable | Example | Source |
|----------|---------|--------|
| `{{agent_name}}` | `nova` | First argument to `straper init` |
| `{{agent_display_name}}` | `Nova` | Derived (capitalized agent_name) |
| `{{user_name}}` | `Alice Smith` | `--user` flag or global config |
| `{{user_role}}` | `Software Engineer` | `--role` flag or global config |
| `{{project_name}}` | `Acme Support` | `--project` flag or capitalized agent_name |
| `{{project_description}}` | `Customer support agent` | `--description` flag |
| `{{workspace_dir}}` | `/home/user/nova` | Resolved from `--dir` flag |
| `{{year}}` | `2026` | Current year at init time |

## How to Add Things

### New template variable

1. Add the field to `TemplateVariables` in `src/scaffold.ts`
2. Add the key to `VALID_KEYS` in the same file
3. Populate the value in the `vars` object in `src/commands/init.ts`
4. Use `{{your_variable}}` in any `.tmpl` file
5. Add a unit test in `src/__tests__/scaffold.test.ts`

### New scaffold file

1. Place the file in the appropriate `scaffold/` subdirectory
2. Use `.tmpl` extension if it needs variable substitution
3. Use `{{agent_name}}` in the filename if it should be renamed per-agent
4. The file will be automatically picked up by `processScaffoldDir` or `copyWithRename`

### New CLI command

1. Create `src/commands/yourcommand.ts` with an exported async function
2. Add the command case to the `switch` in `src/cli.ts`
3. Add help text to `printHelp()` in `src/cli.ts`
4. Add tests in `src/__tests__/`

## Testing Expectations

- Every new feature or bug fix includes tests
- Unit tests go in `src/__tests__/` alongside the module they test
- Integration tests go in `tests/integration/` — these run `straper init` in a temp directory and verify the output
- E2e tests go in `tests/e2e/` — these test the full lifecycle from init through session-start and task operations
- All tests must pass before committing: `pnpm test`
