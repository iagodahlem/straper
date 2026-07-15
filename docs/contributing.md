# Contributing

This page covers how to set up a development environment for Straper, understand the codebase, run tests, and submit changes.

## Dev Setup

```bash
git clone https://github.com/iagodahlem/straper.git
cd straper
pnpm install
pnpm build
```

Verify everything works:

```bash
pnpm typecheck    # Type-check without emitting files
pnpm lint         # Lint src/ and tests/
pnpm test         # Run all tests
```

Run the CLI:

```bash
node bin/straper --help
```

## Architecture

Straper has three distinct areas:

### src/ — The CLI

TypeScript source code compiled to `dist/`. This is the Straper CLI itself: the command router, the scaffold template engine, the global config reader/writer, and the scaffold plus skill-registry commands.

```
src/
├── cli.ts                 # Parses argv, dispatches to commands
├── commands/
│   ├── init.ts            # straper init -- builds the workspace
│   ├── adopt.ts           # straper init --adopt -- onboard an existing workspace
│   ├── add.ts             # straper add -- vendor registry modules
│   ├── use.ts             # straper use -- ephemeral skill trial
│   ├── update.ts          # straper update -- three-way merge of vendored modules
│   ├── doctor.ts          # straper doctor -- vendored-module health check
│   ├── publish.ts         # straper publish -- push a skill into a registry checkout
│   ├── migrate.ts         # straper migrate -- pre-registry workspace migration (being reworked)
│   ├── status.ts          # straper status -- workspace health
│   └── registry-shared.ts # Shared registry helpers: lockfile, pointers, hashing, base store
├── scaffold.ts            # Scaffold template engine: {{variable}} substitution, file copy/rename
├── baseline.ts            # Runtime baseline allowlist for publish self-containment checks
├── config.ts              # Read/write ~/.config/straper/ (config.json, workspaces.json)
├── constants.ts           # VERSION, SCAFFOLD_DIR, REGISTRY_DIR, defaults
└── __tests__/             # Unit tests (cli, scaffold, config)
```

Integration tests for each registry command (`add`, `update`, `doctor`, `publish`, `use`, `init --adopt`, `migrate`) live under `tests/integration/`.

Key design decisions:
- Zero production dependencies. Only devDependencies (TypeScript, vitest, eslint).
- ESM (`type: "module"`) with `.js` extensions in all imports.
- Strict TypeScript with all compiler checks enabled.

### scaffold/ — What Gets Generated

Everything in `scaffold/` is copied into new workspaces. Straper's own source code is never part of the generated workspace.

```
scaffold/
├── templates/       # .tmpl files -- variable substitution, then written to workspace root
├── scripts/         # Bash/JS scripts -- copied to scripts/ (filenames may be renamed)
├── schemas/         # JSON schemas -- copied to tasks/
├── designs/         # FD templates -- copied to designs/
├── claude/          # .tmpl files -- variable substitution, written to .claude/
└── config/          # .tmpl files -- variable substitution, written to config/
```

The distinction matters: `src/` is "Straper the tool", `scaffold/` is "what the tool produces." Changes to `scaffold/` affect all future workspaces. Changes to `src/` affect the CLI behavior.

### tests/ — Integration and E2E

```
tests/
├── integration/     # Runs straper init in a temp dir, verifies the output
└── e2e/             # Full lifecycle: init -> session-start -> task operations
```

Unit tests live alongside source in `src/__tests__/`.

## Running Tests

```bash
pnpm test                # All tests (unit + integration + e2e)
pnpm test:integration    # Integration tests only
pnpm test:e2e            # End-to-end tests only
pnpm test:watch          # Watch mode for development
```

Test runner: vitest. Configuration is in `vitest.config.ts` with three projects: `unit`, `integration`, `e2e`.

### Writing Tests

- **Unit tests** go in `src/__tests__/`. Name them `{module}.test.ts`.
- **Integration tests** go in `tests/integration/`. These create temp directories, run `straper init`, and verify the generated workspace.
- **E2E tests** go in `tests/e2e/`. These test the full lifecycle from init through session-start and task operations.

All tests should clean up temp directories after themselves.

## Adding Features

### New CLI Command

1. Create `src/commands/yourcommand.ts` with an exported async function
2. Add a case to the `switch` statement in `src/cli.ts`
3. Add help text to `printHelp()` in `src/cli.ts`
4. Add unit tests in `src/__tests__/`
5. Add integration tests if the command has side effects

### New Template Variable

1. Add the field to the `TemplateVariables` interface in `src/scaffold.ts`
2. Add the key to the `VALID_KEYS` set in the same file
3. Populate the value in the `vars` object in `src/commands/init.ts`
4. Use `{{your_variable}}` in any `.tmpl` file
5. Add a unit test in `src/__tests__/scaffold.test.ts`

### New Scaffold File

1. Place the file in the appropriate `scaffold/` subdirectory
2. Use `.tmpl` extension if it needs variable substitution
3. Use `{{agent_name}}` in the filename if it should be renamed per agent
4. The file is picked up automatically by `processScaffoldDir` — no registration needed
5. Update integration tests to verify the file appears in the generated workspace

### New Workspace Script

1. Add the script to `scaffold/scripts/`
2. Make sure it starts with `#!/usr/bin/env bash` and uses `set -euo pipefail`
3. If it needs preferences, read them with `jq -r '.key.path' preferences.json`
4. The init command automatically makes scripts in `scripts/` executable

## Code Style

- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `test:`
- **No AI-generated footers or co-authored-by trailers** in commit messages
- **Single-line commit titles** — put details in the body if needed
- **TypeScript strict mode** — no `any`, no implicit returns, no unused variables
- **ESM imports** — always use `.js` extension in import paths
- **Prefer `node:` prefix** for built-in modules (`import { readFile } from 'node:fs/promises'`)

## PR Guidelines

1. Every change has tests. Unit tests for logic, integration tests for side effects.
2. `pnpm typecheck && pnpm lint && pnpm test` must pass before submitting.
3. Keep PRs focused. One concern per PR.
4. Write a clear PR description: what changed, why, and how to test it.
5. If the change affects generated workspaces, note what users will see differently.

## Reporting Issues

When filing an issue, include:

- The command you ran and the full output
- Your Node.js version (`node --version`)
- Your operating system
- The contents of `~/.config/straper/config.json` (redact any sensitive info)
