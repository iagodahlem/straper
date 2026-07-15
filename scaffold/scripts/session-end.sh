#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

AGENT_NAME=$(jq -r '.agent_name // "agent"' "$ROOT_DIR/preferences.json" 2>/dev/null || echo "agent")
AGENT_DISPLAY_NAME="$(echo "${AGENT_NAME:0:1}" | tr '[:lower:]' '[:upper:]')${AGENT_NAME:1}"

TODAY="$(date +%F)"
FAILED=0

# ---------------------------------------------------------------------------
# Load skill framework for composition pipeline
# ---------------------------------------------------------------------------
COMPOSE_AVAILABLE=0
# shellcheck source=scripts/lib/skills.sh
if source "$ROOT_DIR/scripts/lib/skills.sh" 2>/dev/null; then
  if declare -f skills_run_compose_pipeline >/dev/null 2>&1; then
    COMPOSE_AVAILABLE=1
  fi
fi

echo "== $AGENT_DISPLAY_NAME Session End ($TODAY) =="
echo

# ---------------------------------------------------------------------------
# Phase 1: session-review composition pipeline (auto-commit, task, memory)
#
# The session-review skill declares composes for review-complete:
#   - auto-commit / commit-workspace-changes
#   - task / validate-continuity
#   - memory / save-daily-summary
#
# We run the composition pipeline first, then fall back to direct checks
# for the critical validations (task, memory) that must always run.
# ---------------------------------------------------------------------------

echo "[1/6] Auto-committing workspace changes"
# Try composition pipeline first, fall back to direct call
if [[ "$COMPOSE_AVAILABLE" -eq 1 ]]; then
  _compose_auto_commit_done=0
  _targets="$(skills_resolve_compose_targets session-review review-complete 2>/dev/null)" || true
  if echo "$_targets" | grep -q "auto-commit"; then
    _script="$(skills_resolve_script auto-commit 2>/dev/null)" || true
    if [[ -n "$_script" && -f "$_script" ]]; then
      "$_script" && _compose_auto_commit_done=1
    fi
  fi
  if [[ "$_compose_auto_commit_done" -eq 0 ]]; then
    if [[ -f ./skills/auto-commit/auto-commit.sh ]]; then
      ./skills/auto-commit/auto-commit.sh
    else
      echo "- auto-commit skill not installed — skipping"
    fi
  fi
elif [[ -f ./skills/auto-commit/auto-commit.sh ]]; then
  ./skills/auto-commit/auto-commit.sh
else
  echo "- auto-commit skill not installed — skipping"
fi

echo
echo "[2/6] Validating task files"
if ! ./scripts/validate-tasks.sh; then
  FAILED=1
fi

echo
echo "[3/6] Checking task continuity"
active_count=0
tasks_updated_today=0
for file in tasks/TASK-*.json; do
  [ -f "$file" ] || continue

  status="$(jq -r '.status' "$file")"
  if [ "$status" = "done" ]; then
    continue
  fi

  active_count=$((active_count + 1))
  id="$(jq -r '.id' "$file")"

  has_today_log="$(jq -r --arg day "$TODAY" 'any(.log[]?; (.date | tostring | startswith($day)))' "$file")"
  if [ "$has_today_log" = "true" ]; then
    tasks_updated_today=$((tasks_updated_today + 1))
  fi

  blockers_count="$(jq -r '.blockers | length' "$file")"

  if [ "$blockers_count" -gt 0 ] && [ "$has_today_log" != "true" ]; then
    echo "- MISSING: ${id} has blockers but no log entry for $TODAY"
    FAILED=1
  fi

  echo "- ${id}: blockers=${blockers_count}, log_today=${has_today_log}"
done

if [ "$active_count" -eq 0 ]; then
  echo "- No active tasks"
fi

if [ "$active_count" -gt 0 ] && [ "$tasks_updated_today" -eq 0 ]; then
  echo "- MISSING: no active task has a log entry for $TODAY"
  FAILED=1
fi

echo
echo "[4/6] Checking memory update"
today_memory="memory/${TODAY}.md"
if [ ! -s "$today_memory" ]; then
  echo "- MISSING: $today_memory is missing or empty"
  FAILED=1
else
  echo "- OK: $today_memory"
fi

echo
echo "[5/6] Checking task worktree references"
for file in tasks/TASK-*.json; do
  [ -f "$file" ] || continue

  id="$(jq -r '.id' "$file")"
  while IFS= read -r wt; do
    [ -n "$wt" ] || continue
    wt_path="$ROOT_DIR/$wt"
    if [ ! -d "$wt_path" ]; then
      echo "- MISSING: ${id} references non-existent worktree ${wt_path}"
      FAILED=1
    else
      echo "- OK: ${id} worktree ${wt_path}"
    fi
  done < <(jq -r '.worktrees[]?' "$file")
done

echo
echo "[6/6] Auto-cleaning stale worktrees"
cleanup_output="$(./scripts/cleanup-workspaces.sh --force 2>&1 || true)"
if echo "$cleanup_output" | grep -q "Cleaned"; then
  echo "$cleanup_output"
elif echo "$cleanup_output" | grep -q "Nothing to clean"; then
  echo "- No stale worktrees"
else
  echo "- Cleanup skipped or no worktrees found"
fi

# ---------------------------------------------------------------------------
# Phase 2: Close the session
# ---------------------------------------------------------------------------

# Session close: find and close the registered session for this process
# shellcheck source=skills/session/sessions.sh
if source "$ROOT_DIR/skills/session/sessions.sh" 2>/dev/null; then
  CLAUDE_PID="$PPID"
  CURRENT_SESSION_MARKER="$ROOT_DIR/.sessions/.current-$CLAUDE_PID"
  if [ -f "$CURRENT_SESSION_MARKER" ]; then
    SESSION_ID="$(cat "$CURRENT_SESSION_MARKER")"
    if [ -n "$SESSION_ID" ]; then
      SESSION_FILE="$ROOT_DIR/.sessions/${SESSION_ID}.json"
      if [ -f "$SESSION_FILE" ]; then
        SESSION_STATUS="$(jq -r '.status' "$SESSION_FILE")"
        if [ "$SESSION_STATUS" = "active" ]; then
          session_close "$SESSION_ID" "Session ended."
          echo "[Session] Closed: $SESSION_ID"
        else
          echo "[Session] Already closed: $SESSION_ID"
        fi
      fi
    fi
    rm -f "$CURRENT_SESSION_MARKER"
  fi
fi

# ---------------------------------------------------------------------------
# Phase 3: Composition pipeline for session close
#
# The session skill declares: composes session.close -> slack-status/resolve
# Use the composition pipeline to trigger slack status resolution.
# Falls back to direct slack calls if composition is unavailable.
# ---------------------------------------------------------------------------

echo ""
if [[ "$COMPOSE_AVAILABLE" -eq 1 ]]; then
  skills_run_compose_pipeline session close 2>&1 || true
else
  # Fallback: direct slack status resolution (pre-composition behavior)
  # shellcheck source=skills/slack-status/slack.sh
  source "$ROOT_DIR/skills/slack-status/slack.sh"
  if slack_token_exists; then
    if slack_sessions_available; then
      resolved="$(slack_resolve_session_status)"
      if [ -n "$resolved" ]; then
        handoff_emoji="${resolved%%|||*}"
        handoff_text="${resolved##*|||}"
        if slack_set_status "$handoff_emoji" "$handoff_text"; then
          echo "[Slack] Status handed off to: $handoff_emoji $handoff_text"
        fi
      else
        if slack_clear_status; then
          echo "[Slack] Status cleared (no remaining public sessions)"
        fi
      fi
    else
      if slack_clear_status; then
        echo "[Slack] Status cleared"
      fi
    fi
  fi
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "Session-end checklist failed."
  echo "Fix the issues above before ending the session."
  exit 1
fi

echo "Session-end checklist passed."
