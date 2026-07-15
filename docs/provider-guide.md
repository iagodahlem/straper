# Provider Guide

This page explains how to use a Straper workspace with different AI coding assistants. The workspace is provider-agnostic by design: AGENTS.md is the universal instruction file, and all scripts are plain bash/Node.js.

## Claude Code

Claude Code has native support. Everything works out of the box.

### What happens automatically

- Claude Code reads `CLAUDE.md` (a symlink to `AGENTS.md`) on startup
- `.claude/settings.json` configures session hooks:
  - `SessionStart` runs `./scripts/session-start.sh`
  - `SessionEnd` runs `./scripts/session-end.sh`
- `.claude/skills/<name>/SKILL.md` pointers (written by `straper add`) surface installed skills like `/fd`, `/ship`, `/worktree` as slash commands
- Allowed commands are pre-configured in `settings.json`

### Setup

No setup needed beyond `straper init`. Just `cd` into the workspace and run `claude`:

```bash
cd ~/myagent
claude
```

### Customizing

Edit `.claude/settings.json` to add more allowed commands:

```json
{
  "permissions": {
    "allow": [
      "Bash(./scripts/*)",
      "Bash(git *)",
      "Bash(pnpm *)",
      "Bash(your-tool *)"
    ]
  }
}
```

## Codex (OpenAI)

Codex reads `AGENTS.md` and the universal `.agents/skills/<name>/SKILL.md` pointers natively — it does not read `CLAUDE.md` or `.claude/`. Point it at `AGENTS.md`; installed skills are already discoverable via `.agents/skills/`.

### Setup

1. Set `AGENTS.md` as the instruction file when configuring Codex for your project
2. Run the session start script manually at the beginning of each session:

   ```bash
   ./scripts/session-start.sh
   ```

3. Run the session end script before ending:

   ```bash
   ./scripts/session-end.sh
   ```

4. Use the agent-named CLI for workspace operations:

   ```bash
   ./scripts/myagent fd-status
   ./scripts/myagent worktree my-repo my-feature
   ```

### What works

- Task tracking, memory, feature designs — all file-based, no provider dependency
- All scripts in `scripts/` work as-is
- The agent-named CLI works from the command line

### What you miss

- Automatic session hooks (you run them manually)
- Claude-style slash commands (skills are still discoverable via `.agents/skills/` pointers, and their scripts run via the CLI directly)

## Gemini CLI

Same pattern as Codex. Gemini CLI can read a markdown file as instructions.

### Setup

1. Point Gemini CLI at `AGENTS.md`
2. Run `./scripts/session-start.sh` at the beginning of each session
3. Run `./scripts/session-end.sh` before ending
4. Use the agent-named CLI for workspace operations

## Generic (Any Provider)

If your AI coding assistant can read a file and run shell commands, it can use a Straper workspace.

### Minimum requirements

1. The assistant can read `AGENTS.md` and follow the instructions in it
2. The assistant can execute bash commands (for scripts, git, jq)

### Setup

1. Point the assistant at `AGENTS.md` as its system instructions or context file
2. At the start of each session, tell the assistant to run:

   ```bash
   ./scripts/session-start.sh
   ```

3. At the end of each session:

   ```bash
   ./scripts/session-end.sh
   ```

4. For task operations:

   ```bash
   ./scripts/task create "Task title"
   ./scripts/task list
   ./scripts/task log TASK-001 "Progress note"
   ```

5. For workspace operations, use the agent-named CLI:

   ```bash
   ./scripts/myagent --help
   ```

## What Is Portable vs. Claude-Specific

| Component | Portable | Claude-specific |
|-----------|----------|-----------------|
| `AGENTS.md` | Yes — universal instructions | |
| `CLAUDE.md` | | Yes — symlink read by Claude Code |
| `SOUL.md`, `USER.md`, `TOOLS.md`, `BOOT.md` | Yes — plain markdown | |
| `MEMORY.md`, `memory/` | Yes — plain markdown | |
| `tasks/`, `designs/`, `plans/` | Yes — JSON and markdown | |
| `preferences.json` | Yes — standard JSON | |
| `scripts/` | Yes — bash and Node.js | |
| `skills/` | Yes — vendored skill code (markdown + scripts) | |
| `.agents/skills/` | Yes — universal skill pointers | |
| `.claude/settings.json` | | Yes — Claude Code config |
| `.claude/skills/` | | Yes — Claude Code skill pointers |
| `config/providers.json` | Yes — provider config | |

### Making the most of a non-Claude provider

Even without `.claude/`, you get the full workspace system. The key difference is automation: Claude Code runs session hooks and provides slash commands automatically. With other providers, you run scripts manually and use the CLI directly. The underlying functionality is identical.

If your provider supports custom commands or plugins, you can wire up the same scripts:

- Session start: `./scripts/session-start.sh`
- Session end: `./scripts/session-end.sh`
- Any skill: `./scripts/<agent-name> <command> [args]`
