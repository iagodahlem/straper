#!/usr/bin/env bash
# skills/session/sessions.sh — Core session management functions
#
# Sessions are stored as individual JSON files in .sessions/<id>.json
# One file per session avoids write contention from parallel sessions.
#
# Usage: source skills/session/sessions.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

_sessions_config_file() {
  echo "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/config/sessions.json"
}

_sessions_config_get() {
  local key="$1"
  local config_file
  config_file="$(_sessions_config_file)"
  jq -r ".$key" "$config_file"
}

_sessions_dir() {
  local config_file
  config_file="$(_sessions_config_file)"
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  local sessions_dir
  sessions_dir="$(_sessions_config_get sessions_dir)"
  echo "$root/$sessions_dir"
}

_sessions_ensure_dir() {
  local dir
  dir="$(_sessions_dir)"
  mkdir -p "$dir"
}

_sessions_file() {
  local id="$1"
  echo "$(_sessions_dir)/${id}.json"
}

# ---------------------------------------------------------------------------
# session_generate_id — Generate a 6-char hex ID
# ---------------------------------------------------------------------------
session_generate_id() {
  # Generate random 6-char hex, ensure uniqueness by regenerating if file exists
  local dir
  dir="$(_sessions_dir)"
  local id
  while true; do
    id="$(openssl rand -hex 3 2>/dev/null || head -c 3 /dev/urandom | xxd -p | head -c 6)"
    if [[ ! -f "$dir/${id}.json" ]]; then
      echo "$id"
      return 0
    fi
  done
}

# ---------------------------------------------------------------------------
# session_proc_start — Print the kernel start-time string for a PID
#
# Usage: session_proc_start <pid>
# Returns a stable, human-readable start time ("Thu Jun  4 10:45:34 2026" on
# macOS, an elapsed/start string on GNU/Linux). Prints nothing if the PID is
# dead or unknown. Used to defeat PID reuse on liveness checks: a recycled PID
# will have a different start-time than the original session's process.
# ---------------------------------------------------------------------------
session_proc_start() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  # BSD/macOS: lstart gives an absolute, stable timestamp.
  # GNU/Linux: lstart is also supported by procps ps.
  ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

# ---------------------------------------------------------------------------
# session_pid_matches — True if <pid> is alive AND its start-time matches
#
# Usage: session_pid_matches <pid> <recorded_start>
# Returns 0 (true) when the process is alive and, if a recorded start-time is
# provided, the live start-time matches it. When no recorded start-time exists
# (older records), falls back to a bare liveness check so legacy records still
# resolve. Returns 1 (false) otherwise.
# ---------------------------------------------------------------------------
session_pid_matches() {
  local pid="$1"
  local recorded="${2:-}"
  [ -n "$pid" ] && [ "$pid" != "null" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # No recorded start-time -> legacy record; bare liveness is the best we have.
  [ -n "$recorded" ] && [ "$recorded" != "null" ] || return 0
  local live
  live="$(session_proc_start "$pid")"
  [ "$live" = "$recorded" ]
}

# ---------------------------------------------------------------------------
# _session_find_active_duplicate <pid> <proc_start> <claude_session_id>
#
# Prints the id of an already-ACTIVE record that represents the same
# process/session, or nothing if none matches. Used by session_register to
# stay idempotent across repeated SessionStart firings for one process (seen
# in practice ~20-30s apart, sharing pid+proc_start but sometimes even a
# DIFFERENT claude_session_id — so both keys are checked, either sufficient).
#
# Match rules (either is sufficient):
#   - claude_session_id is non-empty and equals the candidate's; OR
#   - pid AND proc_start both equal the candidate's (proc_start required on
#     both sides so two different processes sharing a recycled pid never
#     collide).
# ---------------------------------------------------------------------------
_session_find_active_duplicate() {
  local pid="$1"
  local proc_start="$2"
  local claude_session_id="$3"

  local dir
  dir="$(_sessions_dir)"
  [ -d "$dir" ] || return 0

  local f status rec_pid rec_proc_start rec_claude_id
  shopt -s nullglob
  for f in "$dir"/*.json; do
    [ -f "$f" ] || continue
    status="$(jq -r '.status // ""' "$f" 2>/dev/null || echo "")"
    [ "$status" = "active" ] || continue

    if [ -n "$claude_session_id" ]; then
      rec_claude_id="$(jq -r '.claude_session_id // ""' "$f" 2>/dev/null || echo "")"
      if [ -n "$rec_claude_id" ] && [ "$rec_claude_id" = "$claude_session_id" ]; then
        jq -r '.id' "$f"
        shopt -u nullglob
        return 0
      fi
    fi

    if [ -n "$pid" ] && [ -n "$proc_start" ]; then
      rec_pid="$(jq -r '.pid // empty' "$f" 2>/dev/null || echo "")"
      rec_proc_start="$(jq -r '.proc_start // ""' "$f" 2>/dev/null || echo "")"
      if [ "$rec_pid" = "$pid" ] && [ -n "$rec_proc_start" ] && [ "$rec_proc_start" = "$proc_start" ]; then
        jq -r '.id' "$f"
        shopt -u nullglob
        return 0
      fi
    fi
  done
  shopt -u nullglob
  return 0
}

# ---------------------------------------------------------------------------
# session_register — Create a new session record (idempotent per process)
#
# Usage: session_register <id> <pid> <name> <emoji> <visibility> <tags_json> \
#                         [task] [branch] [worktree] [claude_session_id] [proc_start]
#
# tags_json: JSON array string, e.g. '["implementation","review"]'
# task/branch/worktree: optional, pass "" to omit
# claude_session_id: the Claude Code session uuid from the hook payload (robust,
#   PID-independent join key for notify/resume). Pass "" if unavailable.
# proc_start: process start-time (defeats PID reuse). Auto-derived from <pid>
#   when omitted.
#
# Idempotency: before creating a new record, checks for an already-ACTIVE one
# for the SAME process/session (_session_find_active_duplicate — same
# claude_session_id, or same pid+proc_start). If found, that record is
# refreshed in place — pid/proc_start always updated to this call's values
# (so a claude_session_id match against a NEW pid, e.g. the same logical
# Claude session resuming under a different process, doesn't leave the record
# pointing at a now-stale pid); name/emoji/claude_session_id backfilled when
# the caller provided a non-empty value — and ITS id is echoed, NOT the <id>
# argument, which is only used on the create-new path. Callers must use the
# echoed id (it may differ from the id they passed in). This closes the
# SessionStart double-registration bug: repeated firings for one process
# refresh a single record instead of piling up duplicates.
# ---------------------------------------------------------------------------
session_register() {
  local id="$1"
  local pid="$2"
  local name="$3"
  local emoji="$4"
  local visibility="$5"
  local tags_json="$6"
  local task="${7:-}"
  local branch="${8:-}"
  local worktree="${9:-}"
  local claude_session_id="${10:-}"
  local proc_start="${11:-}"

  _sessions_ensure_dir

  # Auto-derive the process start-time if not supplied.
  if [ -z "$proc_start" ]; then
    proc_start="$(session_proc_start "$pid")"
  fi

  # Idempotency guard — reuse an existing active record for this process
  # instead of minting a duplicate.
  local existing_id
  existing_id="$(_session_find_active_duplicate "$pid" "$proc_start" "$claude_session_id")"

  if [ -n "$existing_id" ]; then
    local existing_file
    existing_file="$(_sessions_file "$existing_id")"
    local tmp
    tmp="$(mktemp)"
    jq --argjson pid "$pid" \
       --arg name "$name" \
       --arg emoji "$emoji" \
       --arg proc_start "$proc_start" \
       --arg claude_session_id "$claude_session_id" \
       '
       .pid = $pid
       | .name = (if $name == "" then .name else $name end)
       | .emoji = (if $emoji == "" then .emoji else $emoji end)
       | .proc_start = (if $proc_start == "" then .proc_start else $proc_start end)
       | .claude_session_id = (if $claude_session_id == "" then .claude_session_id else $claude_session_id end)
       ' "$existing_file" > "$tmp"
    mv "$tmp" "$existing_file"
    echo "$existing_id"
    return 0
  fi

  local file
  file="$(_sessions_file "$id")"
  local started_at
  started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  # Normalize optional string fields to JSON null when empty
  local task_json branch_json worktree_json claude_json proc_json
  task_json="$([ -n "$task" ] && echo "\"$task\"" || echo "null")"
  branch_json="$([ -n "$branch" ] && echo "\"$branch\"" || echo "null")"
  worktree_json="$([ -n "$worktree" ] && echo "\"$worktree\"" || echo "null")"

  jq -n \
    --arg id "$id" \
    --argjson pid "$pid" \
    --arg name "$name" \
    --arg emoji "$emoji" \
    --argjson tags "$tags_json" \
    --arg visibility "$visibility" \
    --argjson task "$task_json" \
    --argjson branch "$branch_json" \
    --argjson worktree "$worktree_json" \
    --arg claude_session_id "$claude_session_id" \
    --arg proc_start "$proc_start" \
    --arg started_at "$started_at" \
    '{
      id: $id,
      pid: $pid,
      name: $name,
      emoji: $emoji,
      status: "active",
      visibility: $visibility,
      tags: $tags,
      task: $task,
      branch: $branch,
      worktree: $worktree,
      claude_session_id: (if $claude_session_id == "" then null else $claude_session_id end),
      proc_start: (if $proc_start == "" then null else $proc_start end),
      started_at: $started_at,
      closed_at: null,
      summary: null
    }' > "$file"

  echo "$id"
}

# ---------------------------------------------------------------------------
# session_register_job — Register a finished headless `claude -p` job session
#
# Usage: session_register_job <name> <claude_session_id> [tag] [emoji] [summary]
#
# For sessions spawned by scheduler jobs (e.g. slack-pulse) that run headless
# as one-shot jobs and finish immediately — there is no live
# interactive process to track, so these are NOT "active" sessions and must not
# pollute the active view or be treated as zombies by session_cleanup_stale.
#
# The record is written with a dedicated status "job":
#   - status != "active"  -> excluded from session_list_active / session_list_public
#                            / session_cleanup_stale / `<agent> session list`
#   - status != "closed"  -> excluded from session_list_recent / `<agent> session history`
#   - still scanned by session_find_by_name_or_id (and the JS findSessionByNameOrId),
#     so `<agent> session resume <name>` resolves it and prints `claude -r <uuid>`.
#
# The claude_session_id is lowercased defensively (uuidgen emits UPPERCASE; the
# resumable transcript path uses the lowercase uuid). Best-effort: callers should
# guard this so a registry failure never aborts the job.
#
# Prints the generated session id.
# ---------------------------------------------------------------------------
session_register_job() {
  local name="$1"
  local claude_session_id="$2"
  local tag="${3:-job}"
  local emoji="${4:-:robot_face:}"
  local summary="${5:-}"

  _sessions_ensure_dir

  # Lowercase the uuid (uuidgen returns UPPERCASE on macOS; transcripts/resume use lowercase).
  claude_session_id="$(printf '%s' "$claude_session_id" | tr '[:upper:]' '[:lower:]')"

  local id
  id="$(session_generate_id)"

  local file
  file="$(_sessions_file "$id")"
  local now
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  jq -n \
    --arg id "$id" \
    --arg name "$name" \
    --arg emoji "$emoji" \
    --arg tag "$tag" \
    --arg claude_session_id "$claude_session_id" \
    --arg now "$now" \
    --arg summary "$summary" \
    '{
      id: $id,
      pid: null,
      name: $name,
      emoji: $emoji,
      status: "job",
      visibility: "internal",
      tags: [$tag],
      task: null,
      branch: null,
      worktree: null,
      claude_session_id: (if $claude_session_id == "" then null else $claude_session_id end),
      proc_start: null,
      started_at: $now,
      closed_at: $now,
      summary: (if $summary == "" then null else $summary end)
    }' > "$file"

  echo "$id"
}

# ---------------------------------------------------------------------------
# session_update — Update a single field on an existing session
#
# Usage: session_update <id> <field> <value>
#
# Supported fields: name, emoji, visibility, tags, task, branch, worktree,
#                   claude_session_id, proc_start
# For tags, value must be a JSON array string: '["implementation"]'
#
# This is the real mechanism behind the agent `/rename` flow: resolve the
# current session (via the .current-<pid> pointer) and call
#   session_update <id> name "<new-name>"
# to persist the name. See session_resolve_current.
# ---------------------------------------------------------------------------
session_update() {
  local id="$1"
  local field="$2"
  local value="$3"

  local file
  file="$(_sessions_file "$id")"
  if [[ ! -f "$file" ]]; then
    echo "session_update: session '$id' not found" >&2
    return 1
  fi

  local tmp
  tmp="$(mktemp)"

  case "$field" in
    name|emoji|visibility|task|branch|worktree|claude_session_id|proc_start)
      jq --arg field "$field" --arg value "$value" \
        '.[$field] = $value' "$file" > "$tmp"
      ;;
    tags)
      jq --argjson value "$value" \
        '.tags = $value' "$file" > "$tmp"
      ;;
    *)
      echo "session_update: unsupported field '$field'" >&2
      rm -f "$tmp"
      return 1
      ;;
  esac

  mv "$tmp" "$file"
}

# ---------------------------------------------------------------------------
# session_close — Mark a session as closed
#
# Usage: session_close <id> <summary>
# ---------------------------------------------------------------------------
session_close() {
  local id="$1"
  local summary="$2"

  local file
  file="$(_sessions_file "$id")"
  if [[ ! -f "$file" ]]; then
    echo "session_close: session '$id' not found" >&2
    return 1
  fi

  local closed_at
  closed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  local tmp
  tmp="$(mktemp)"
  jq --arg closed_at "$closed_at" --arg summary "$summary" \
    '.status = "closed" | .closed_at = $closed_at | .summary = $summary' \
    "$file" > "$tmp"
  mv "$tmp" "$file"
}

# ---------------------------------------------------------------------------
# session_get — Read and print a session JSON
#
# Usage: session_get <id>
# ---------------------------------------------------------------------------
session_get() {
  local id="$1"
  local file
  file="$(_sessions_file "$id")"
  if [[ ! -f "$file" ]]; then
    echo "session_get: session '$id' not found" >&2
    return 1
  fi
  cat "$file"
}

# ---------------------------------------------------------------------------
# session_list_active — List active sessions, optional tag filter
#
# Usage: session_list_active [--tag TAG]
# Prints one JSON object per line (NDJSON)
# ---------------------------------------------------------------------------
session_list_active() {
  local tag_filter=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tag)
        tag_filter="$2"
        shift 2
        ;;
      *)
        echo "session_list_active: unknown argument '$1'" >&2
        return 1
        ;;
    esac
  done

  local dir
  dir="$(_sessions_dir)"
  if [[ ! -d "$dir" ]]; then
    return 0
  fi

  for file in "$dir"/*.json; do
    [[ -f "$file" ]] || continue
    local status
    status="$(jq -r '.status' "$file")"
    [[ "$status" == "active" ]] || continue

    if [[ -n "$tag_filter" ]]; then
      local has_tag
      has_tag="$(jq -r --arg tag "$tag_filter" '.tags | map(select(. == $tag)) | length' "$file")"
      [[ "$has_tag" -gt 0 ]] || continue
    fi

    cat "$file"
  done
}

# ---------------------------------------------------------------------------
# session_list_public — List active sessions with visibility=public
# Used by the Slack skill to determine which status to show
#
# Usage: session_list_public
# Prints one JSON object per line (NDJSON)
# ---------------------------------------------------------------------------
session_list_public() {
  local dir
  dir="$(_sessions_dir)"
  if [[ ! -d "$dir" ]]; then
    return 0
  fi

  for file in "$dir"/*.json; do
    [[ -f "$file" ]] || continue
    local status visibility
    status="$(jq -r '.status' "$file")"
    visibility="$(jq -r '.visibility' "$file")"
    [[ "$status" == "active" && "$visibility" == "public" ]] || continue
    cat "$file"
  done
}

# ---------------------------------------------------------------------------
# session_list_recent — List n most recent closed sessions
#
# Usage: session_list_recent [n]
# Default n = 10. Prints one JSON object per line, newest first.
# ---------------------------------------------------------------------------
session_list_recent() {
  local n="${1:-10}"

  local dir
  dir="$(_sessions_dir)"
  if [[ ! -d "$dir" ]]; then
    return 0
  fi

  local closed_sessions=()
  for file in "$dir"/*.json; do
    [[ -f "$file" ]] || continue
    local status
    status="$(jq -r '.status' "$file")"
    [[ "$status" == "closed" ]] || continue
    closed_sessions+=("$file")
  done

  if [[ ${#closed_sessions[@]} -eq 0 ]]; then
    return 0
  fi

  # Sort by closed_at descending, take top n
  printf '%s\n' "${closed_sessions[@]}" | while read -r f; do
    jq -c '{closed_at: .closed_at, file: "'"$f"'"}' "$f"
  done | sort -t'"' -k4 -r | head -n "$n" | while read -r line; do
    local f
    f="$(echo "$line" | jq -r '.file')"
    cat "$f"
  done
}

# ---------------------------------------------------------------------------
# _sessions_max_active_hours — Absolute max-age (hours) for an "active" session
#
# Read from config/sessions.json (max_active_hours), default 168 (7 days). This
# is a SAFETY backstop only: a session is NEVER expired by age if its PID is
# alive and its start-time still matches (a legitimate long-running session must
# survive). Age only closes sessions whose liveness check is ambiguous (e.g. a
# legacy record with no recorded start-time on a recycled PID).
# ---------------------------------------------------------------------------
_sessions_max_active_hours() {
  local v
  v="$(_sessions_config_get max_active_hours 2>/dev/null)"
  if [ -z "$v" ] || [ "$v" = "null" ]; then
    echo "168"
  else
    echo "$v"
  fi
}

# ---------------------------------------------------------------------------
# session_cleanup_stale — Close dead/stale active sessions; reap orphan pointers
#
# Usage: session_cleanup_stale
#
# Liveness is hardened against PID reuse: a session stays active only if its PID
# is alive AND the live process start-time matches the recorded one. Legacy
# records with no recorded start-time fall back to a bare liveness check, but
# are additionally subject to an absolute max-age backstop so a recycled PID
# can't keep a long-dead session "alive" forever.
#
# Also reaps any .current-<pid> pointer whose PID is dead.
# ---------------------------------------------------------------------------
session_cleanup_stale() {
  local dir
  dir="$(_sessions_dir)"
  if [[ ! -d "$dir" ]]; then
    return 0
  fi

  local max_hours
  max_hours="$(_sessions_max_active_hours)"
  local now_epoch
  now_epoch="$(date -u +%s)"

  for file in "$dir"/*.json; do
    [[ -f "$file" ]] || continue
    local status pid id proc_start started_at
    status="$(jq -r '.status' "$file")"
    [[ "$status" == "active" ]] || continue

    pid="$(jq -r '.pid' "$file")"
    id="$(jq -r '.id' "$file")"
    proc_start="$(jq -r '.proc_start // ""' "$file")"
    started_at="$(jq -r '.started_at // ""' "$file")"

    # Primary check: PID alive AND start-time matches (PID-reuse safe).
    if session_pid_matches "$pid" "$proc_start"; then
      # Live and matched. If we have a recorded start-time we trust it fully and
      # never age-expire. Only legacy records (no proc_start) get the age check.
      if [ -n "$proc_start" ] && [ "$proc_start" != "null" ]; then
        continue
      fi
      # Legacy record: alive but unverifiable. Apply max-age backstop only.
      local start_epoch age_hours
      start_epoch="$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$started_at" +%s 2>/dev/null \
        || date -d "$started_at" +%s 2>/dev/null || echo "")"
      if [ -n "$start_epoch" ]; then
        age_hours=$(( (now_epoch - start_epoch) / 3600 ))
        if [ "$age_hours" -ge "$max_hours" ]; then
          session_close "$id" "Session expired (exceeded max active age; PID unverifiable)"
        fi
      fi
      continue
    fi

    # PID dead or start-time mismatch (PID reuse) -> stale.
    session_close "$id" "Session terminated unexpectedly"
  done

  # Reap orphan .current-<pid> pointers whose PID is dead.
  # Suppress the printed count here — callers of cleanup don't want it on stdout.
  session_reap_current_pointers >/dev/null
}

# ---------------------------------------------------------------------------
# session_reap_current_pointers — Remove .current-<pid> pointers for dead PIDs
#
# Usage: session_reap_current_pointers
# Only removes a pointer when its PID is confirmed dead (kill -0 fails). Live
# PIDs (including the currently active session) are always preserved. Prints the
# number of pointers removed.
# ---------------------------------------------------------------------------
session_reap_current_pointers() {
  local dir
  dir="$(_sessions_dir)"
  if [[ ! -d "$dir" ]]; then
    echo 0
    return 0
  fi

  local removed=0
  local ptr pid
  for ptr in "$dir"/.current-*; do
    [[ -e "$ptr" ]] || continue
    pid="${ptr##*/.current-}"
    # Guard: pid must be numeric.
    case "$pid" in
      ''|*[!0-9]*) continue ;;
    esac
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$ptr"
      removed=$(( removed + 1 ))
    fi
  done
  echo "$removed"
}

# ---------------------------------------------------------------------------
# session_resolve_current — Find the session for the current Claude process
#
# Usage: session_resolve_current
# Prints the session JSON if found, nothing if not registered.
#
# Resolution is anchored on the .current-<pid> pointer file. The session is
# registered against the Claude process PID ($PPID from the hook's perspective),
# so resolution must read the SAME pointer rather than scanning by $$ (the
# transient shell PID), which never matched and caused /rename to silently fail.
#
# Order:
#   1. .current-$PPID pointer (Claude process — the registrar's PID).
#   2. .current-$$ pointer    (in case this IS the registering shell).
#   3. Fallback: scan records for an active one whose PID is alive.
# ---------------------------------------------------------------------------
session_resolve_current() {
  local dir
  dir="$(_sessions_dir)"
  if [[ ! -d "$dir" ]]; then
    return 0
  fi

  # 1 & 2: pointer-based resolution (the canonical path).
  local candidate_pid sid file
  for candidate_pid in "$PPID" "$$"; do
    local ptr="$dir/.current-$candidate_pid"
    [[ -f "$ptr" ]] || continue
    sid="$(cat "$ptr" 2>/dev/null || true)"
    [[ -n "$sid" ]] || continue
    file="$(_sessions_file "$sid")"
    if [[ -f "$file" ]]; then
      local status
      status="$(jq -r '.status' "$file")"
      if [[ "$status" == "active" ]]; then
        cat "$file"
        return 0
      fi
    fi
  done

  # 3: fallback scan — active record whose PID is alive (start-time aware).
  for file in "$dir"/*.json; do
    [[ -f "$file" ]] || continue
    local pid status proc_start
    status="$(jq -r '.status' "$file")"
    [[ "$status" == "active" ]] || continue
    pid="$(jq -r '.pid' "$file")"
    proc_start="$(jq -r '.proc_start // ""' "$file")"
    if [[ "$pid" == "$PPID" || "$pid" == "$$" ]] && session_pid_matches "$pid" "$proc_start"; then
      cat "$file"
      return 0
    fi
  done
}

# ---------------------------------------------------------------------------
# session_find_by_name_or_id — Find a session file by ID or name
#
# Usage: session_find_by_name_or_id <id-or-name>
# Prints the session JSON if found, nothing if not found.
# Searches both active and closed sessions.
# ---------------------------------------------------------------------------
session_find_by_name_or_id() {
  local query="$1"

  local dir
  dir="$(_sessions_dir)"
  if [[ ! -d "$dir" ]]; then
    return 0
  fi

  # Try exact ID match first (6-char hex)
  if [[ "$query" =~ ^[0-9a-f]{6}$ ]]; then
    local id_file
    id_file="$dir/${query}.json"
    if [[ -f "$id_file" ]]; then
      cat "$id_file"
      return 0
    fi
  fi

  # Fall back to name match (case-insensitive, newest match wins)
  local best_file=""
  local best_time=""
  for file in "$dir"/*.json; do
    [[ -f "$file" ]] || continue
    local name
    name="$(jq -r '.name' "$file")"
    # Case-insensitive comparison
    local name_lower query_lower
    name_lower="$(echo "$name" | tr '[:upper:]' '[:lower:]')"
    query_lower="$(echo "$query" | tr '[:upper:]' '[:lower:]')"
    if [[ "$name_lower" == "$query_lower" ]]; then
      local started_at
      started_at="$(jq -r '.started_at // ""' "$file")"
      if [[ -z "$best_time" || "$started_at" > "$best_time" ]]; then
        best_time="$started_at"
        best_file="$file"
      fi
    fi
  done

  if [[ -n "$best_file" ]]; then
    cat "$best_file"
  fi
}

# ---------------------------------------------------------------------------
# _sessions_job_retention_days — Retention window (days) for status:job records
#
# Read from config/sessions.json (job_retention_days), default 30. Job records
# (headless `claude -p` job sessions, written by session_register_job) are NOT
# "closed" sessions, so session_archive_old's closed-only pass never touched
# them and they accumulated forever. They carry no live process and are kept
# only so `<agent> session resume <name>` can resolve a recent job's transcript —
# a longer window than interactive retention is fine (default 30d vs 7d closed).
# ---------------------------------------------------------------------------
_sessions_job_retention_days() {
  local v
  v="$(_sessions_config_get job_retention_days 2>/dev/null)"
  if [ -z "$v" ] || [ "$v" = "null" ]; then
    echo "30"
  else
    echo "$v"
  fi
}

# ---------------------------------------------------------------------------
# session_archive_old — Prune closed sessions older than retention_days,
# append summaries to daily memory log. Also prunes status:job records older
# than job_retention_days (see _sessions_job_retention_days).
#
# Usage: session_archive_old [days] [job_days]
# Default days pulled from config/sessions.json retention_days; job_days from
# job_retention_days. Idempotent: a no-op when nothing is past either cutoff,
# and it NEVER touches active or recent records.
# ---------------------------------------------------------------------------
session_archive_old() {
  local days="${1:-}"
  if [[ -z "$days" ]]; then
    days="$(_sessions_config_get retention_days)"
  fi
  local job_days="${2:-}"
  if [[ -z "$job_days" ]]; then
    job_days="$(_sessions_job_retention_days)"
  fi

  local dir
  dir="$(_sessions_dir)"
  if [[ ! -d "$dir" ]]; then
    return 0
  fi

  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  local memory_dir="$root/memory"
  local today
  today="$(date -u +"%Y-%m-%d")"
  local memory_file="$memory_dir/${today}.md"

  # cutoff: sessions closed before this ISO timestamp should be archived
  local cutoff
  cutoff="$(date -u -v-"${days}"d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || date -u -d "${days} days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || echo "")"

  if [[ -z "$cutoff" ]]; then
    echo "session_archive_old: could not compute cutoff date" >&2
    return 1
  fi

  # job_cutoff: status:job records older than this should be pruned. Computed
  # independently from job_retention_days; a failure here only skips job pruning
  # (the closed-session pass below still runs).
  local job_cutoff
  job_cutoff="$(date -u -v-"${job_days}"d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || date -u -d "${job_days} days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || echo "")"

  local archived_entries=()

  for file in "$dir"/*.json; do
    [[ -f "$file" ]] || continue
    local status closed_at
    status="$(jq -r '.status' "$file")"

    # status:job — headless job-session record. Prune (no memory entry; these
    # carry no narrative summary worth archiving) once past the job cutoff. Skip
    # if the cutoff couldn't be computed, leaving the record untouched.
    if [[ "$status" == "job" ]]; then
      [[ -n "$job_cutoff" ]] || continue
      local job_stamp
      job_stamp="$(jq -r '.closed_at // .started_at // ""' "$file")"
      [[ -n "$job_stamp" ]] || continue
      if [[ "$job_stamp" < "$job_cutoff" ]]; then
        rm -f "$file"
      fi
      continue
    fi

    [[ "$status" == "closed" ]] || continue

    closed_at="$(jq -r '.closed_at // ""' "$file")"
    [[ -n "$closed_at" ]] || continue

    # Compare ISO strings lexicographically (works for UTC timestamps)
    if [[ "$closed_at" < "$cutoff" ]]; then
      # Build the memory entry
      local name emoji task started_at summary duration_str
      name="$(jq -r '.name' "$file")"
      emoji="$(jq -r '.emoji' "$file")"
      task="$(jq -r '.task // ""' "$file")"
      started_at="$(jq -r '.started_at // ""' "$file")"
      summary="$(jq -r '.summary // ""' "$file")"

      # Compute duration
      duration_str=""
      if [[ -n "$started_at" && -n "$closed_at" ]]; then
        local start_epoch end_epoch diff_secs
        start_epoch="$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$started_at" +%s 2>/dev/null \
          || date -d "$started_at" +%s 2>/dev/null || echo "")"
        end_epoch="$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$closed_at" +%s 2>/dev/null \
          || date -d "$closed_at" +%s 2>/dev/null || echo "")"
        if [[ -n "$start_epoch" && -n "$end_epoch" ]]; then
          diff_secs=$(( end_epoch - start_epoch ))
          local hours=$(( diff_secs / 3600 ))
          local mins=$(( (diff_secs % 3600) / 60 ))
          if [[ $hours -gt 0 ]]; then
            duration_str="${hours}h ${mins}m"
          else
            duration_str="${mins}m"
          fi
        fi
      fi

      # Build memory entry line
      local task_part=""
      [[ -n "$task" ]] && task_part=", $task"
      local duration_part=""
      [[ -n "$duration_str" ]] && duration_part=" — $duration_str"

      local entry="- **${name}** (${emoji})${duration_part}${task_part}"
      [[ -n "$summary" ]] && entry="${entry}"$'\n'"  ${summary}"

      archived_entries+=("$entry")

      # Remove the session file
      rm -f "$file"
    fi
  done

  # Append to memory file if there are archived entries
  if [[ ${#archived_entries[@]} -gt 0 ]]; then
    mkdir -p "$memory_dir"

    # Check if ## Sessions section already exists
    local has_sessions_section=false
    if [[ -f "$memory_file" ]] && grep -q "^## Sessions" "$memory_file" 2>/dev/null; then
      has_sessions_section=true
    fi

    if [[ "$has_sessions_section" == "false" ]]; then
      # Create or append the section header
      {
        echo ""
        echo "## Sessions"
        echo ""
      } >> "$memory_file"
    fi

    for entry in "${archived_entries[@]}"; do
      echo "$entry" >> "$memory_file"
    done
  fi
}
