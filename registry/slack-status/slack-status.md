---
name: slack-status
description: Manage Slack status directly from the agent with session-aware priority resolution
version: 1
visibility: user
triggers:
  - /slack-status
backing_script: slack.sh
cli_command: slack-status
depends_on:
  - session
composes: []
---

# Slack Status Skill

## Purpose

Manage your Slack status directly from the agent via `skills/slack-status/slack.sh`, with session-aware priority resolution: when sessions are tracked, status reflects the most recent public session instead of being set ad hoc.

## Arguments

```
/slack-status <text> [--emoji <emoji>] [--expires <minutes>]
/slack-status clear
/slack-status clear-all
/slack-status check
/slack-status queue
```

## Mode Detection

**Standalone mode**: No session awareness. Direct API calls only. Active when `.sessions/` does not exist or `skills/session/sessions.sh` is unavailable.

**Session-aware mode**: Active when `.sessions/` exists and `skills/session/sessions.sh` is available (FD-003 A1 landed). In this mode, Slack status is driven by the session registry — only `public` sessions are eligible.

To detect the current mode:

```bash
ROOT_DIR="$(pwd)" source skills/slack-status/slack.sh
if slack_sessions_available; then
  echo "Session-aware mode"
else
  echo "Standalone mode"
fi
```

## Execution

### `check`

Verify token validity:

```bash
ROOT_DIR="$(pwd)" source skills/slack-status/slack.sh
slack_check_token
```

- If token is valid: report "Token valid (user: <name>)"
- If no token: report "No Slack token configured. Add SLACK_USER_TOKEN to .env"
- If invalid: report the error from the API

### `<text> [--emoji <emoji>] [--expires <minutes>]`

Set Slack status:

```bash
ROOT_DIR="$(pwd)" source skills/slack-status/slack.sh
slack_set_status "<emoji>" "<text>" [expiration_minutes]
```

- Parse `--emoji` from arguments (default: `:speech_balloon:` if not provided)
- Parse `--expires <minutes>` from arguments (default: 0 = no expiration)
- `<text>` is everything that isn't a flag or flag value
- Text max 100 chars, plain text only
- Emoji must be in `:name:` format
- Report: "Status set: <emoji> <text>" (with expiration note if set)
- If no token: report "No Slack token configured"

### `clear`

Clear Slack status:

```bash
ROOT_DIR="$(pwd)" source skills/slack-status/slack.sh
slack_clear_status
```

- Report: "Status cleared"
- If no token: report "No Slack token configured"

### `clear-all`

Clear Slack status and (in session-aware mode) close all active sessions:

```bash
ROOT_DIR="$(pwd)" source skills/slack-status/slack.sh
slack_clear_status
```

**Standalone mode**: equivalent to `clear`.

**Session-aware mode**: also close all active sessions in the registry:

```bash
ROOT_DIR="$(pwd)" source skills/slack-status/slack.sh skills/session/sessions.sh
slack_clear_status
# Close every active session
while IFS= read -r session_json; do
  id="$(echo "$session_json" | jq -r '.id')"
  session_close "$id" "Closed via /slack-status clear-all"
done < <(session_list_active)
```

- Report: "Status cleared. Closed N sessions." (or "Status cleared" if no active sessions)
- If no token: still close sessions, report "Token not configured — Slack status not cleared. Closed N sessions."

### `queue`

Show active sessions and their Slack status eligibility.

**Standalone mode**: report "Session tracker not available. Use /slack-status <text> to set status directly."

**Session-aware mode**: list all active sessions, split by visibility:

```bash
ROOT_DIR="$(pwd)" source skills/session/sessions.sh
# Public sessions (eligible for Slack)
session_list_public
# All active sessions (to find internal ones)
session_list_active
```

Output format:

```
Public sessions (Slack-eligible):
  :wrench:  Wiring SCIM attributes       started 2h ago   [current]
  :eyes:    Reviewing PRs                started 30m ago

Internal sessions (hidden from Slack):
  :gear:    Tuning the engine            started 45m ago  (internal — hidden from Slack)
```

Rules:
- Sort public sessions by `started_at` descending; mark the top one as `[current]` (it wins the status)
- Show internal sessions separately with "(internal — hidden from Slack)" label
- If no public sessions: show "No public sessions active — Slack status will be cleared on next session end"
- If no sessions at all: show "No active sessions"
- For each session, show: emoji, name, started_at (relative: "2h ago", "30m ago"), and visibility label for internal ones

Duration helper (compute relative time from `started_at` ISO 8601):

```bash
started="2026-03-19T14:30:00Z"
start_epoch="$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$started" +%s 2>/dev/null || date -d "$started" +%s)"
now_epoch="$(date +%s)"
diff_secs=$(( now_epoch - start_epoch ))
hours=$(( diff_secs / 3600 ))
mins=$(( (diff_secs % 3600) / 60 ))
if [[ $hours -gt 0 ]]; then
  echo "${hours}h ${mins}m ago"
else
  echo "${mins}m ago"
fi
```

## Session-Aware Mode: Priority Resolution

When multiple public sessions are active, the one with the **most recent `started_at`** wins (it's the session the user is actively in). This becomes the Slack status.

If the session's visibility changes mid-session (e.g., a public session pivots to internal work), the skill should:
1. Call `/session visibility internal` to update the session record
2. Re-resolve Slack status via `slack_resolve_session_status` and update accordingly

## Graceful Degradation

- No `.env` or no token → report clearly, never crash
- Slack API error → surface the error message to the user
- No session tracker → standalone mode (report if `queue` or `clear-all` is used)
- All active sessions are internal → Slack status clears (or stays cleared)

## Examples

```
/slack-status check
→ Token valid (user: yourname)

/slack-status "reviewing PRs" --emoji :eyes:
→ Status set: :eyes: reviewing PRs

/slack-status "deep work" --emoji :headphones: --expires 90
→ Status set: :headphones: deep work (expires in 90 minutes)

/slack-status clear
→ Status cleared

/slack-status queue          (session-aware mode)
→ Public sessions (Slack-eligible):
    :wrench:  Wiring SCIM attributes  started 2h ago  [current]
  Internal sessions (hidden from Slack):
    :gear:    Tuning the engine       started 45m ago  (internal — hidden from Slack)

/slack-status clear-all      (session-aware mode)
→ Status cleared. Closed 2 sessions.
```
