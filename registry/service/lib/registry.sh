#!/usr/bin/env bash
# skills/service/lib/registry.sh — Read/write the service process registry.
#
# The service harness tracks every dev server the agent starts as one JSON
# record per service at .state/<id>.json (skill-local, gitignored runtime
# state). One file per record avoids write contention when several services
# start in parallel; logs live at .state/logs/<id>.log.
#
# This library is the CRUD + liveness layer: create, list, get, update-status,
# remove — plus a PID-reuse-proof liveness check (cloned verbatim from
# skills/session/sessions.sh) and a stale-record reaper. It carries no port or
# spawn logic — see lib/ports.sh (allocation) and service.sh (CLI + spawn).
#
# Usage:
#   source skills/service/lib/registry.sh            # library mode
#   bash skills/service/lib/registry.sh <verb> ...   # direct CLI (debug/tests)
#
# Config + state are skill-owned (see skills/SCHEMA.md → Skill-owned config and
# state): config/services.json holds settings; .state/ holds runtime. Requires
# jq. Deliberately does NOT set -e: sourced into callers that have their own
# errexit policy, and several helpers are predicates that return non-zero as
# normal control flow.

# Idempotent include guard (if-form is safe under a caller's `set -e`).
if [ -n "${_SERVICE_REGISTRY_SH:-}" ]; then
  return 0 2>/dev/null || true
fi
_SERVICE_REGISTRY_SH=1

set -uo pipefail

# ---------------------------------------------------------------------------
# Paths & config
# ---------------------------------------------------------------------------

# _service_root — Absolute skill directory (this file lives at
# skills/service/lib/, so the skill root is one level up). Config and runtime
# state are resolved against it, keeping the skill self-contained.
_service_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

_services_config_file() {
  echo "$(_service_root)/config/services.json"
}

# _services_config_get <key> — Read a top-level scalar from config/services.json.
_services_config_get() {
  local key="$1"
  jq -r ".$key // empty" "$(_services_config_file)"
}

# service_registry_dir — Absolute path to the runtime records dir (.state).
service_registry_dir() {
  local sub
  sub="$(_services_config_get services_dir)"
  [ -n "$sub" ] || sub=".state"
  echo "$(_service_root)/$sub"
}

# service_registry_log_dir — Absolute path to the logs dir (.state/logs).
service_registry_log_dir() {
  local sub
  sub="$(_services_config_get log_dir)"
  [ -n "$sub" ] || sub=".state/logs"
  echo "$(_service_root)/$sub"
}

# service_registry_log_relpath <id> — Skill-relative log path stored in records.
service_registry_log_relpath() {
  local sub
  sub="$(_services_config_get log_dir)"
  [ -n "$sub" ] || sub=".state/logs"
  echo "$sub/$1.log"
}

# service_registry_ensure — Create the records + logs dirs if missing.
service_registry_ensure() {
  mkdir -p "$(service_registry_dir)" "$(service_registry_log_dir)"
}

# service_registry_file <id> — Absolute path to a record file.
service_registry_file() {
  echo "$(service_registry_dir)/$1.json"
}

# ---------------------------------------------------------------------------
# ID + liveness (cloned from skills/session/sessions.sh — PID-reuse safe)
# ---------------------------------------------------------------------------

# service_generate_id — Unique 6-char hex id (regenerates on collision).
service_generate_id() {
  local dir id
  dir="$(service_registry_dir)"
  while true; do
    id="$(openssl rand -hex 3 2>/dev/null || head -c 3 /dev/urandom | xxd -p | head -c 6)"
    if [ ! -f "$dir/$id.json" ]; then
      echo "$id"
      return 0
    fi
  done
}

# service_proc_start <pid> — Kernel start-time string for a PID (empty if dead).
# The start-time defeats PID reuse: a recycled PID has a different start-time.
service_proc_start() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

# service_pid_matches <pid> <recorded_start> — True iff the process is alive AND
# (when a start-time was recorded) its live start-time still matches. Legacy
# records without a recorded start-time fall back to a bare liveness check.
service_pid_matches() {
  local pid="$1"
  local recorded="${2:-}"
  [ -n "$pid" ] && [ "$pid" != "null" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [ -n "$recorded" ] && [ "$recorded" != "null" ] || return 0
  local live
  live="$(service_proc_start "$pid")"
  [ "$live" = "$recorded" ]
}

# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

# service_registry_create <id> <json> — Write a new record (validated via jq).
service_registry_create() {
  local id="$1" json="$2"
  service_registry_ensure
  local file
  file="$(service_registry_file "$id")"
  if ! printf '%s' "$json" | jq -e '.' >"$file" 2>/dev/null; then
    rm -f "$file"
    echo "service_registry_create: invalid JSON for '$id'" >&2
    return 1
  fi
}

# service_registry_get <id> — Print one record (pretty). Non-zero if missing.
service_registry_get() {
  local file
  file="$(service_registry_file "$1")"
  if [ ! -f "$file" ]; then
    echo "service_registry_get: no record '$1'" >&2
    return 1
  fi
  jq '.' "$file"
}

# service_registry_exists <id> — True if a record file exists.
service_registry_exists() {
  [ -f "$(service_registry_file "$1")" ]
}

# service_registry_list [--active] — Print records as NDJSON (one per line).
# --active limits to non-terminal status (starting|running|unhealthy).
service_registry_list() {
  local mode="all"
  [ "${1:-}" = "--active" ] && mode="active"
  local dir file status
  dir="$(service_registry_dir)"
  [ -d "$dir" ] || return 0
  for file in "$dir"/*.json; do
    [ -f "$file" ] || continue
    if [ "$mode" = "active" ]; then
      status="$(jq -r '.status // ""' "$file" 2>/dev/null || echo "")"
      case "$status" in
        starting|running|unhealthy) ;;
        *) continue ;;
      esac
    fi
    jq -c '.' "$file" 2>/dev/null || true
  done
}

# service_registry_apply <id> <jq-filter> [jq-args...] — Atomic in-place update.
service_registry_apply() {
  local id="$1"
  shift
  local filter="$1"
  shift
  local file tmp
  file="$(service_registry_file "$id")"
  [ -f "$file" ] || {
    echo "service_registry_apply: no record '$id'" >&2
    return 1
  }
  tmp="$(mktemp)"
  if jq "$@" "$filter" "$file" >"$tmp" 2>/dev/null; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
    echo "service_registry_apply: jq update failed for '$id'" >&2
    return 1
  fi
}

# service_registry_update_status <id> <status> — Flip status; stamp stopped_at
# on terminal states (stopped|crashed).
service_registry_update_status() {
  local id="$1" status="$2" now
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  service_registry_apply "$id" \
    '.status = $s | (if ($s == "stopped" or $s == "crashed") then .stopped_at = $now else . end)' \
    --arg s "$status" --arg now "$now"
}

# service_registry_remove <id> — Delete a record file (and its log).
service_registry_remove() {
  local id="$1" file log
  file="$(service_registry_file "$id")"
  log="$(service_registry_log_dir)/$id.log"
  rm -f "$file" "$log"
}

# ---------------------------------------------------------------------------
# Derived queries
# ---------------------------------------------------------------------------

# service_registry_active_ports — Every port held by an active record (one per
# line). Consumed by the allocator to skip agent-managed reservations.
service_registry_active_ports() {
  service_registry_list --active 2>/dev/null | jq -r '.ports[]?.port' 2>/dev/null || true
}

# service_registry_cleanup_stale — Flip active records whose process is gone (or
# whose PID was recycled) to "crashed". Safe to call before any list/status.
service_registry_cleanup_stale() {
  local dir file status pid proc_start id
  dir="$(service_registry_dir)"
  [ -d "$dir" ] || return 0
  for file in "$dir"/*.json; do
    [ -f "$file" ] || continue
    status="$(jq -r '.status // ""' "$file" 2>/dev/null || echo "")"
    case "$status" in
      starting|running|unhealthy) ;;
      *) continue ;;
    esac
    pid="$(jq -r '.pid // ""' "$file" 2>/dev/null || echo "")"
    proc_start="$(jq -r '.proc_start // ""' "$file" 2>/dev/null || echo "")"
    id="$(jq -r '.id' "$file" 2>/dev/null || echo "")"
    [ -n "$id" ] || continue
    if ! service_pid_matches "$pid" "$proc_start"; then
      service_registry_update_status "$id" "crashed" >/dev/null 2>&1 || true
    fi
  done
}

# ---------------------------------------------------------------------------
# Direct CLI (debug/tests) — `bash skills/service/lib/registry.sh <verb> ...`
# ---------------------------------------------------------------------------
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  _verb="${1:-}"
  shift 2>/dev/null || true
  case "$_verb" in
    list) service_registry_list "$@" ;;
    get) service_registry_get "$@" ;;
    update-status) service_registry_update_status "$@" ;;
    remove) service_registry_remove "$@" ;;
    active-ports) service_registry_active_ports ;;
    cleanup) service_registry_cleanup_stale ;;
    dir) service_registry_dir ;;
    *)
      echo "usage: registry.sh <list|get|update-status|remove|active-ports|cleanup|dir>" >&2
      exit 1
      ;;
  esac
fi
