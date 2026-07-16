# The workspace CLI and the `commands.json` contract

Every generated workspace ships a CLI at `scripts/<agent>.js` (named after the agent, e.g. `nova.js`). This document describes what it is, how it finds its commands, and the contract a skill module uses to contribute commands to it.

## Two CLIs, one boundary

- **`straper`** — the npm tool. Scaffolds a workspace and runs the module lifecycle (`init`, `add`, `update`, `use`, `publish`, `status`). Authored in this repo, compiled to `dist/`, ships the registry. You run it *from outside* a workspace.
- **`<agent>`** — the workspace CLI. Generated into the workspace, thin plain JS, no build step. It is **registry-driven**: it has no hardcoded knowledge of any skill and discovers everything at runtime from the modules that are actually installed.

## How discovery works

On every invocation the dispatcher:

1. Scans `skills/*/commands.json` (installed modules only), in sorted module order.
2. Builds a command registry from those specs.
3. Routes the invoked command by **lazily** `require()`-ing the declared handler file — and only that file, only when the command runs. A module that is installed but not invoked is never loaded, so a broken or heavy module cannot slow down or break an unrelated command.
4. Falls through to a helpful error (with suggestions and the list of available commands) for an unknown command.

Three **built-ins** are served by the dispatcher itself and always work, even in a workspace with zero skills installed:

- `help` / `help <command>` — overview and per-command detail, generated from the discovered specs.
- `skills` — passthrough to `scripts/lib/skills.sh` (list, validate, stats, sync, export, import).
- `completion bash|zsh` — a shell completion script **rendered at runtime** from the discovered specs (there are no static completion files to drift).

A module may not claim `help`, `skills`, or `completion`; such a spec is ignored with a warning.

**Duplicate commands:** if two installed modules declare the same command name, the first one wins (deterministic, because modules are scanned in sorted order) and a warning is printed to stderr.

## The `commands.json` contract

A skill contributes workspace-CLI commands by placing a `commands.json` file at its module root (`skills/<name>/commands.json`). It is a JSON array of command specs:

```json
[
  {
    "command": "fd-new",
    "summary": "Create a feature design and append it to the design index.",
    "handler": "fd-commands.js#commandFdNew",
    "args": "<title>",
    "flags": [
      { "flag": "--effort <small|medium|large>", "summary": "Sizing estimate (default: medium)." },
      { "flag": "--dry-run", "summary": "Preview without writing files." }
    ],
    "subcommands": [
      { "name": "list", "summary": "List entries." }
    ],
    "metric": { "skill": "fd", "action": "new" }
  }
]
```

### Fields

| Field | Required | Meaning |
|-------|----------|---------|
| `command` | yes | The workspace-CLI command name (`fd-new`). Must not be a built-in (`help`, `skills`, `completion`). |
| `handler` | yes | `<file>#<export>`, resolved relative to the skill directory. The file is `require()`-d lazily and `<export>` must be a function taking `(args)` — the argv after the command. |
| `summary` | no | One-line help text, shown in the overview and command detail. |
| `args` | no | Positional-argument usage string for help (e.g. `<title>` or `<FD-ID> <SUB-ITEM>`). |
| `flags` | no | Array of `{ "flag": "--name <value>", "summary": "..." }`. The `flag` display string drives both help and completion: `--name` is boolean, `--name <a\|b\|c>` offers choices, `--name <value>` takes a value. |
| `subcommands` | no | Array of `{ "name": "...", "summary": "..." }` for verb-style commands (help + completion). |
| `metric` | no | Overrides metric logging. `{ "skill", "action" }`; or `{ "skill", "actionFromArg": true }` to log the first positional arg as the action (for verb-style commands). Defaults to `skill = <module name>`, `action = <command name>`. |

### Handler contract

The handler is a plain function. It receives the argument array (everything after the command name), does its work, and either returns or throws. A thrown error is printed and the CLI exits non-zero. The dispatcher wraps the call, times it, and logs a metric row to `.metrics/skills.jsonl` via `logSkillMetric`.

Handlers are loaded lazily by absolute path, so their own relative `require()`s resolve from the skill directory as usual (e.g. `../../scripts/lib/cli-utils.js`).

## Module-contributed hooks and the `hooks.json` contract

Where `commands.json` lets a module contribute *workspace-CLI commands*, `hooks.json` lets a module contribute *harness hooks* — entries wired into the workspace's `.claude/settings.json`. A skill places a `hooks.json` at its module root (`skills/<name>/hooks.json`); `straper add` and `straper update` splice its entries into settings, and `straper doctor` verifies they are still there.

```json
{
  "hooks": [
    {
      "event": "PostToolUse",
      "matcher": "Edit|Write",
      "command": "skills/auto-commit/auto-commit.sh"
    },
    {
      "event": "SessionEnd",
      "command": "skills/auto-commit/auto-commit.sh"
    }
  ]
}
```

### Fields

| Field | Required | Meaning |
|-------|----------|---------|
| `event` | yes | The harness hook event (`PostToolUse`, `SessionEnd`, `PreToolUse`, …). |
| `matcher` | no | The event matcher (e.g. `Edit|Write`). Defaults to `""` (match-all), the right value for session events. |
| `command` | yes | The command string to run, workspace-relative (e.g. `skills/<name>/<script>.sh`). |

Any other keys in an entry (e.g. a `description` or `scope` note) are treated as documentation and ignored by the installer — the harness hook object is just `{ "type": "command", "command": … }` under the resolved event/matcher group.

### How the merge works

The installer performs a **surgical JSON merge**, never a rewrite:

1. It ensures `settings.hooks[event]` exists and finds (or creates) the group whose `matcher` equals the entry's matcher.
2. It appends `{ "type": "command", "command": … }` to that group **only if** an identical command is not already present. That is what makes re-`add` idempotent.
3. Everything else in `settings.json` — the baseline `SessionStart`/`SessionEnd` hooks, the `PreToolUse` git-safety hook, permissions, any user edits — is left byte-for-byte intact. A module command that shares a matcher group with a baseline command simply coexists in that group.

### Ownership, update, and doctor

Ownership is tracked in the **lockfile**, not by tagging `settings.json` with markers. Each module's `straper.lock` entry records a `hooks` array of the `(event, matcher, command)` signatures it installed. This gives three properties:

- **Idempotent re-add** — the signature match in step 2 prevents duplicates.
- **`update` can replace** — on a version bump whose `hooks.json` changed, `update` removes the previously-locked signatures and splices the new ones. When it strips a command it only removes that command; a group left empty is dropped, but a group still holding a baseline/user command is preserved.
- **`doctor` can audit** — a lock-recorded hook that has gone missing from `settings.json` (hand-removed or clobbered) is flagged as a problem.

> **Removal:** there is no `straper remove` command yet, so uninstall-time hook cleanup is not wired. When a `remove` lands, it should strip a module's locked hook signatures the same way `update` does before re-splicing.

## Legacy fallback (transitional, deprecated)

Until registry modules ship their own `commands.json`, the dispatcher carries a small deprecated table mapping the known current commands (`fd-*`, `worker`, `worktree`, `sync-branch`, `ship*`, `session`, `session-review*`, `slack-status`) to their handler files. A legacy entry is registered **only** when no `commands.json` already declares that command **and** the module's handler file exists on disk. This keeps existing workspaces working through the transition without weakening the zero-skill boot guarantee (in a workspace with those modules absent, none of the entries register). Once the modules publish `commands.json`, those specs take precedence and the legacy table can be removed.
