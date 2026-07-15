---
name: session
description: Track and manage agent sessions with creative naming, visibility control, and cross-session coordination
version: 1
visibility: user
triggers:
  - /session
  - hook:SessionStart
  - hook:SessionEnd
backing_script: sessions.sh
cli_command: session
depends_on: []
composes:
  - skill: slack-status
    on: close
    action: resolve
---

# Session Skill

## Purpose

Register, track, and close work sessions. Sessions provide continuity across Claude conversations — each session is logged with a name, emoji, visibility, tags, and start time, and drives Slack status handoff on close via composition with `slack-status`.

The backing script is `skills/session/sessions.sh`. Config lives in `config/sessions.json`.

## Arguments

```
/session                               Show info for the current session
/session list [--tag <tag>]            List all active sessions
/session history                       Show recent closed sessions
/session info <id>                     Show details for a specific session
/session rename <name>                 Rename the current session
/session visibility <public|internal>  Override visibility for the current session
/session close-all                     Close all active sessions
/session resume <name-or-id>           Print the resume invocation for a session
```

Registration and close-on-exit are driven by the `SessionStart`/`SessionEnd` hooks, not invoked directly as `/session` subcommands — see `## Execution` below.

---

## On Session Start

The `SessionStart` hook (`scripts/session-start.sh`) auto-registers a session
**before** the agent runs. It:

- Derives a **provisional name** from context — the most-recently-updated
  `in_progress` task title, else the git branch, else the worktree/cwd basename
  (no longer the bare default `"Coding"`).
- Captures the **Claude `session_id`** from the hook's stdin payload and stores
  it on the record as `claude_session_id` (a PID-independent join key used by
  notify and `session resume`). If the payload lacks it, the field is `null`
  and consumers fall back to the `.current-<pid>` pointer.
- Records the process **start-time** (`proc_start`) so liveness survives PID reuse.
- Writes the `.sessions/.current-<PPID>` pointer (PPID = the Claude process).

So the agent does **not** need to register a session manually. The agent's job
at the start is to **refine the provisional record**:

1. **Refine the name** to something punchy (see Naming) via `/session rename <name>`.
2. **Reassess visibility** (see Visibility) — `/session visibility <public|internal>`.
3. **Assign tags** if useful.

If you ever need to register manually (e.g. the hook didn't run), the full
signature is:

```bash
source skills/session/sessions.sh
ID=$(session_generate_id)
# positional: id pid name emoji visibility tags [task] [branch] [worktree] [claude_session_id] [proc_start]
session_register "$ID" "$PPID" "<name>" "<emoji>" "<visibility>" '["<tag>"]' "" "" "" "" ""
```

Note: register against **`$PPID`** (the Claude process), not `$$` (the transient
shell), so the `.current-<pid>` pointer and `session_resolve_current` agree.

If context is too ambiguous, fall back to defaults from `config/sessions.json`:
- Name: `"Coding"`, emoji: `:laptop:`, visibility: `internal`

---

## Session Naming

Derive a short (2–4 word), punchy name that captures the *vibe* of the work — not the ticket number.

**Steps:**
1. Look at the active task name, what the user asked to work on, the branch name, or the worktree.
2. Pick a name that evokes the work without being literal. Action verbs work well.
3. Pick a matching emoji.
4. Run `/session rename <name>` to persist it to the record (see that command).

**Examples:**

| Context | Name | Emoji |
|---------|------|-------|
| TASK-009 SCIM Phase 2, sub-item A4 | Wiring SCIM attributes | `:wrench:` |
| TASK-013 e2e test stability | Stabilizing e2e | `:test_tube:` |
| TASK-008 feature flag cleanup | Flag cleanup sweep | `:broom:` |
| General planning / architecture discussion | Charting the course | `:compass:` |
| PR review session | Reviewing PRs | `:eyes:` |
| Workspace tooling / scripts / skills | Tuning the engine | `:gear:` |
| Updating memory or skills files | Sharpening the mind | `:brain:` |
| Debugging an issue | Hunting the bug | `:mag:` |
| Onboarding / exploring a new area | Mapping the terrain | `:map:` |

**Fallback:** If no good name can be derived, use the defaults from `config/sessions.json` (`"Coding"` / `:laptop:`).

---

## Visibility Detection

Visibility controls whether this session is eligible for Slack status (FD-004).

| Situation | Visibility |
|-----------|-----------|
| Working in a worktree under `workspaces/` (product repos) | `public` |
| Working on a TASK-xxx linked to a product repo | `public` |
| Working on this workspace's files (skills, scripts, config, memory, plans, tasks, designs) | `internal` |
| Ambiguous | `internal` (safe default) |

**Rule:** When in doubt, default to `internal`. Better to not show in Slack than to leak workspace-internal activity.

To override manually: `/session visibility public` or `/session visibility internal`.

---

## Tags

Assign one or more tags based on the type of work. Use consistent values:

| Tag | When |
|-----|------|
| `planning` | Scoping work, writing FDs, discussing architecture |
| `implementation` | Writing code, building features |
| `review` | Reviewing PRs, code review |
| `debugging` | Investigating bugs, reading logs |
| `testing` | Running tests, fixing flaky tests |
| `cleanup` | Feature flag removal, refactoring, tech debt |
| `tooling` | Working on this workspace, scripts, skills |

Multiple tags are fine: `'["implementation","debugging"]'`

---

## Execution

When the user runs any `/session` command, execute the corresponding shell logic and present the output in a readable format.

### `/session`

Show info for the current session (resolved via the `.current-<PPID>` pointer):

```bash
source skills/session/sessions.sh
session_resolve_current | jq .
```

Display: name, emoji, visibility, tags, task, branch, worktree, started_at, elapsed time.

### `/session list [--tag <tag>]`

List all active sessions:

```bash
source skills/session/sessions.sh
session_list_active [--tag <tag>]
```

Display as a table: `id  emoji  name  visibility  tags  task  elapsed`

### `/session history`

List recent closed sessions:

```bash
source skills/session/sessions.sh
session_list_recent 10
```

Display: name, emoji, task, duration, summary.

### `/session info <id>`

Show full details for a specific session:

```bash
source skills/session/sessions.sh
session_get <id> | jq .
```

### `/session rename <name>`

Persist a new name on the current session record. This is the **real** rename
mechanism: `session_resolve_current` finds the record via the `.current-<PPID>`
pointer (not `$$`), and `session_update ... name` writes it to disk.

```bash
source skills/session/sessions.sh
CURRENT=$(session_resolve_current)
ID=$(echo "$CURRENT" | jq -r '.id')
session_update "$ID" name "<new-name>"
```

Optionally also call Claude's built-in `/rename <new-name>` so the name matches
in Claude's own session picker — but the workspace record is updated by
`session_update` above regardless.

### `/session visibility <public|internal>`

Override visibility for the current session:

```bash
source skills/session/sessions.sh
CURRENT=$(session_resolve_current)
ID=$(echo "$CURRENT" | jq -r '.id')
session_update "$ID" visibility "<public|internal>"
```

### `/session close-all`

Close all active sessions with a generic summary:

```bash
source skills/session/sessions.sh
session_list_active | while read -r line; do
  ID=$(echo "$line" | jq -r '.id')
  session_close "$ID" "Session closed via close-all."
done
```

### `/session resume <name-or-id>` (a.k.a. `<agent> session resume <name-or-id>`)

Look up the most-recent session record matching a name or 6-hex id and print the
exact resume invocation. Prefer the CLI, which uses the stored
`claude_session_id` for a robust resume:

```bash
scripts/<agent> session resume "<name-or-id>"
```

- If the record has a stored `claude_session_id`, it prints `claude -r <uuid>` —
  the precise, unambiguous resume command.
- If it has no stored id (legacy records), it falls back to guidance for
  Claude's interactive picker: `claude --resume`, then select the named entry.
- Lookup: exact 6-hex id first, else case-insensitive name match (newest wins).
  Lookup scans **all** statuses (active, closed, **and `job`**), so headless
  job sessions resolve here even though they never show as active.

Note: Claude transcripts are machine-local (`~/.claude/projects/<hash>/`), so
resume only works on the machine that ran the session.

---

## Examples

```
/session
→ Shows the current session: name, emoji, visibility, tags, task, elapsed time.

/session rename "Wiring SCIM attributes"
→ Session renamed. Workspace record and Claude's session picker both updated.

/session visibility public
→ Session visibility set to public — eligible for Slack status.

/session close-all
→ Closes every active session with a generic summary.

/session resume "Wiring SCIM"
→ claude -r 3f9a21c0-...   (or picker guidance for legacy records with no stored id)
```

---

## Job Sessions (headless `claude -p` runs)

Scheduler jobs that spawn a nested `claude -p` (today only `slack-pulse`) name
and register that session so it is resumable by name — see `jobs/README.md`.
The job's `run.sh`:

1. Generates a fixed **lowercased** uuid and a human name, then passes
   `--session-id <uuid> -n "<name>"` to `claude -p` (persistence is on by default
   in `-p` mode, so a resumable transcript is written).
2. Calls `session_register_job <name> <claude_session_id> [tag] [emoji] [summary]`
   from this script.

```bash
source skills/session/sessions.sh
session_register_job "slack-pulse 2026-06-04 14:00" "$JOB_SESSION_ID" "job:slack-pulse"
```

The record is written with a dedicated **`status: "job"`** (not `active`, not
`closed`). That keeps it honest in the registry:

- excluded from `session_list_active` / `session_list_public` / `<agent> session list`
  (active view) — a finished headless run is not a live session;
- never touched by `session_cleanup_stale` (it only scans `active`), so it is
  never mislabelled a zombie;
- excluded from `session_list_recent` / `<agent> session history` (closed view);
- **still** found by `session_find_by_name_or_id` and the CLI `resume` lookup
  (both scan every status), so `<agent> session resume "<name>"` resolves it and
  prints `claude -r <uuid>`.

The registration is best-effort: jobs guard it so a failure can never abort the
run or change its exit code.

---

## On Session End

Before the session closes:

1. **Write a 1–2 sentence summary** of what was accomplished. Be specific: what was built, fixed, or decided.
2. **Close the session:**

```bash
source skills/session/sessions.sh
CURRENT=$(session_resolve_current)
ID=$(echo "$CURRENT" | jq -r '.id')
session_close "$ID" "<summary>"
```

**Good summaries:**
- "Implemented custom attribute CRUD on the overview tab. Added validation and mutation hooks."
- "Removed the `disable_organization_slug` and `allow_disable_personal_workspace` feature flags across 12 files."
- "Investigated SCIM sync failures. Root cause: missing `externalId` mapping in Entra provisioning config."

---

## Pivot Detection

If the session's work shifts significantly mid-conversation (e.g., starts on SCIM implementation but switches to PR review), detect the pivot and:

1. **Propose a new name** that matches the new work.
2. **Ask the user to confirm** (unless the pivot is obvious).
3. On confirmation:
   - Call `session_update "$ID" name "<new-name>"`
   - Call `session_update "$ID" emoji "<new-emoji>"`
   - Update tags if the type of work changed
   - If task or branch changed, update those too
   - Call `/rename <new-name>` to sync with Claude
4. **Reassess visibility** — if pivoting from product work to this workspace's tooling (or vice versa), update visibility accordingly and call `session_update "$ID" visibility "<new-visibility>"`.

**Pivot signals to watch for:**
- The user explicitly says "let's switch to..." or "actually, let's..."
- The active task/branch changes
- The work changes from one category to another (e.g., `implementation` → `review`)
- The repo context changes (product repo → this workspace)

Pivots are best-effort — catch the obvious ones, don't over-detect subtle shifts.

---

## Stale Session Handling

The `SessionStart` hook runs cleanup automatically, but you can run it manually:

```bash
source skills/session/sessions.sh
session_cleanup_stale   # close dead/stale active sessions; reap orphan .current-<pid> pointers
session_archive_old     # prune closed sessions older than retention_days, append to daily memory
```

`session_cleanup_stale` is hardened against **PID reuse**: a session stays
active only if its PID is alive **and** the live process start-time
(`proc_start`) matches the recorded one. A recycled PID (alive, different
start-time) is treated as stale and closed. Legacy records with no recorded
`proc_start` fall back to a bare liveness probe, but are additionally subject to
an absolute max-age backstop (`max_active_hours` in `config/sessions.json`,
default 168h) so a recycled PID can't keep a long-dead session "active" forever.
A session whose PID is alive **and** start-time matches is **never** age-expired,
so legitimate long-running sessions survive.

Cleanup also reaps any `.sessions/.current-<pid>` pointer whose PID is dead
(verified with `kill -0`); live pointers — including the current session — are
always preserved.

`<agent> session list` annotates any active record whose PID is dead or recycled
as `(stale)` so the list never reports zombies as live.

This prevents zombie sessions from accumulating and keeps `.sessions/` lean. Archived sessions are distilled into `memory/YYYY-MM-DD.md` under `## Sessions` before their files are removed.
