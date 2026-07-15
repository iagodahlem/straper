#!/usr/bin/env bash
# skills/slack-status/slack.sh — Core Slack API functions
#
# Usage: source skills/slack-status/slack.sh
#
# All functions no-op silently (exit 0) when no token is configured.
# Token is loaded from $ROOT_DIR/.env (SLACK_USER_TOKEN=xoxp-...).

# Resolve workspace root relative to this script
_SLACK_ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Load SLACK_USER_TOKEN from $ROOT_DIR/.env if not already set
slack_load_token() {
  if [[ -n "${SLACK_USER_TOKEN:-}" ]]; then
    return 0
  fi
  local env_file="$_SLACK_ROOT_DIR/.env"
  if [[ -f "$env_file" ]]; then
    # Only export SLACK_USER_TOKEN, ignore other vars
    local token
    token=$(grep -E '^SLACK_USER_TOKEN=' "$env_file" | head -1 | cut -d= -f2-)
    if [[ -n "$token" ]]; then
      export SLACK_USER_TOKEN="$token"
    fi
  fi
}

# Returns 0 if a token is configured, 1 otherwise
slack_token_exists() {
  slack_load_token
  [[ -n "${SLACK_USER_TOKEN:-}" ]]
}

# Calls auth.test to verify the token is valid
# Prints nothing on success; prints error to stderr on failure
slack_check_token() {
  slack_load_token
  if ! slack_token_exists; then
    return 0
  fi

  local response
  response=$(curl -s -X POST "https://slack.com/api/auth.test" \
    -H "Authorization: Bearer $SLACK_USER_TOKEN" \
    -H "Content-Type: application/json")

  local ok
  ok=$(echo "$response" | grep -o '"ok":[^,}]*' | head -1 | cut -d: -f2 | tr -d ' "')

  if [[ "$ok" == "true" ]]; then
    local user
    user=$(echo "$response" | grep -o '"user":"[^"]*"' | head -1 | cut -d'"' -f4)
    echo "Token valid (user: $user)"
    return 0
  else
    local error
    error=$(echo "$response" | grep -o '"error":"[^"]*"' | head -1 | cut -d'"' -f4)
    echo "Token invalid: ${error:-unknown error}" >&2
    return 1
  fi
}

# Sets Slack status
# Usage: slack_set_status <emoji> <text> [expiration_minutes]
#   emoji               — e.g. ":laptop:" or ":eyes:"
#   text                — plain text, max 100 chars
#   expiration_minutes  — optional; 0 or omitted = no expiration
slack_set_status() {
  slack_load_token
  if ! slack_token_exists; then
    return 0
  fi

  local emoji="${1:-}"
  local text="${2:-}"
  local expiration_minutes="${3:-0}"

  local expiration_ts=0
  if [[ "$expiration_minutes" -gt 0 ]] 2>/dev/null; then
    expiration_ts=$(( $(date +%s) + expiration_minutes * 60 ))
  fi

  local payload
  payload=$(printf '{"profile":{"status_emoji":"%s","status_text":"%s","status_expiration":%d}}' \
    "$emoji" "$text" "$expiration_ts")

  local response
  response=$(curl -s -X POST "https://slack.com/api/users.profile.set" \
    -H "Authorization: Bearer $SLACK_USER_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload")

  local ok
  ok=$(echo "$response" | grep -o '"ok":[^,}]*' | head -1 | cut -d: -f2 | tr -d ' "')

  if [[ "$ok" != "true" ]]; then
    local error
    error=$(echo "$response" | grep -o '"error":"[^"]*"' | head -1 | cut -d'"' -f4)
    echo "Warning: failed to set Slack status: ${error:-unknown error}" >&2
    return 1
  fi
  return 0
}

# Clears Slack status (both emoji and text)
slack_clear_status() {
  slack_load_token
  if ! slack_token_exists; then
    return 0
  fi
  slack_set_status "" "" 0
}

# ---------------------------------------------------------------------------
# Session-aware helpers (requires FD-003 sessions.sh)
# ---------------------------------------------------------------------------

# Returns 0 if the session tracker is available (FD-003 A1)
slack_sessions_available() {
  local root="$_SLACK_ROOT_DIR"
  [[ -d "$root/.sessions" && -f "$root/skills/session/sessions.sh" ]]
}

# Resolve status from the highest-priority public session.
# "Highest priority" = most recently started (latest started_at).
# Outputs: "<emoji>|||<name>" or empty string if no public sessions exist.
slack_resolve_session_status() {
  if ! slack_sessions_available; then
    return 0
  fi

  local root="$_SLACK_ROOT_DIR"
  local sessions_out
  sessions_out="$(
    # shellcheck disable=SC1090
    source "$root/skills/session/sessions.sh" 2>/dev/null || true
    session_list_public 2>/dev/null || true
  )"

  if [[ -z "$sessions_out" ]]; then
    return 0
  fi

  # Pick the most recently started public session (latest started_at)
  local top_session
  top_session="$(echo "$sessions_out" | jq -s 'sort_by(.started_at) | reverse | first' 2>/dev/null || echo "")"

  if [[ -z "$top_session" || "$top_session" == "null" ]]; then
    return 0
  fi

  local emoji name
  emoji="$(echo "$top_session" | jq -r '.emoji // ""')"
  name="$(echo "$top_session" | jq -r '.name // ""')"
  echo "${emoji}|||${name}"
}

# ---------------------------------------------------------------------------
# Composition interface
# ---------------------------------------------------------------------------
# These functions follow the composition naming convention:
#   <skill_name_underscored>_<action_underscored>
# They are called by skills_run_compose_pipeline when this skill is a
# compose target (e.g., compose:session.close → slack_status_resolve).

# slack_status_resolve — Resolve Slack status from remaining active sessions
#
# Called by the composition pipeline when a session closes.
# If other public sessions remain, hands off to the highest-priority one.
# If no sessions remain, clears the status.
# No-ops if no token is configured (graceful degradation).
#
# Usage: slack_status_resolve  (no arguments)
# Exit: 0 always (best-effort)
slack_status_resolve() {
  if ! slack_token_exists; then
    echo "[slack-status] No token configured -- skipping resolve" >&2
    return 0
  fi

  if slack_sessions_available; then
    local resolved
    resolved="$(slack_resolve_session_status)"
    if [[ -n "$resolved" ]]; then
      local handoff_emoji="${resolved%%|||*}"
      local handoff_text="${resolved##*|||}"
      if slack_set_status "$handoff_emoji" "$handoff_text"; then
        echo "[slack-status] Status handed off to: $handoff_emoji $handoff_text"
      fi
    else
      if slack_clear_status; then
        echo "[slack-status] Status cleared (no remaining public sessions)"
      fi
    fi
  else
    if slack_clear_status; then
      echo "[slack-status] Status cleared"
    fi
  fi

  return 0
}
