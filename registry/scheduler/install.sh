#!/usr/bin/env bash
# skills/scheduler/install.sh — install / uninstall / healthcheck the
# out-of-band scheduler LaunchAgent (com.agent.scheduler).
#
# PLATFORM: macOS only. launchd/launchctl are the wall-clock trigger here. On
# Linux there is no bundled installer — wire scheduler.sh into a systemd user
# timer or a cron entry firing every 5 minutes instead (see scheduler.md
# "Platform support"). `scheduler.sh` itself (one foreground tick) is portable.
#
# This script is for the user to run manually. It is idempotent and safe to re-run.
#
# Usage:
#   bash skills/scheduler/install.sh            # install + load + kickstart
#   bash skills/scheduler/install.sh --status   # healthcheck (launchctl print)
#   bash skills/scheduler/install.sh --uninstall # bootout + remove plist
#
# What "install" does:
#   1. Copy skills/scheduler/com.agent.scheduler.plist to
#      ~/Library/LaunchAgents/com.agent.scheduler.plist with __AGENT_ROOT__
#      replaced by the resolved repo root.
#   2. launchctl bootstrap gui/<uid> <plist>   (load into the GUI domain)
#   3. launchctl enable gui/<uid>/<label>      (ensure it's enabled)
#   4. launchctl kickstart -k gui/<uid>/<label> (fire one tick now)

set -euo pipefail

LABEL="com.agent.scheduler"
# This script lives at skills/scheduler/install.sh, so the repo root is two
# levels up. The plist template sits in the SAME dir as this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/${LABEL}.plist"
TARGET="$HOME/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
SERVICE="${DOMAIN}/${LABEL}"

log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }

do_install() {
  if [[ ! -f "$TEMPLATE" ]]; then
    err "ERROR: template not found at $TEMPLATE"
    exit 1
  fi

  mkdir -p "$HOME/Library/LaunchAgents"

  # Render the template with the resolved repo root.
  # Use a temp file then move into place so a partial write can't load.
  local tmp
  tmp="$(mktemp)"
  sed "s#__AGENT_ROOT__#${ROOT_DIR}#g" "$TEMPLATE" > "$tmp"

  # If already loaded, bootout first so bootstrap doesn't error (idempotency).
  if launchctl print "$SERVICE" >/dev/null 2>&1; then
    log "Service already loaded — booting out before re-install."
    launchctl bootout "$SERVICE" 2>/dev/null || true
  fi

  mv "$tmp" "$TARGET"
  log "Installed plist -> $TARGET (root: $ROOT_DIR)"

  launchctl bootstrap "$DOMAIN" "$TARGET"
  log "Bootstrapped $SERVICE"

  launchctl enable "$SERVICE"
  log "Enabled $SERVICE"

  launchctl kickstart -k "$SERVICE"
  log "Kickstarted $SERVICE (one tick fired now)"

  log ""
  log "Done. Logs: /tmp/agent-scheduler.out  /tmp/agent-scheduler.err"
  log "Check status: bash skills/scheduler/install.sh --status"
}

do_uninstall() {
  if launchctl print "$SERVICE" >/dev/null 2>&1; then
    launchctl bootout "$SERVICE" 2>/dev/null || true
    log "Booted out $SERVICE"
  else
    log "Service not loaded — nothing to bootout."
  fi

  if [[ -f "$TARGET" ]]; then
    rm -f "$TARGET"
    log "Removed $TARGET"
  else
    log "No plist at $TARGET — nothing to remove."
  fi

  log "Uninstalled."
}

do_status() {
  log "Service: $SERVICE"
  if launchctl print "$SERVICE" >/dev/null 2>&1; then
    log "State: LOADED"
    # Surface the most relevant lines without dumping the full print.
    launchctl print "$SERVICE" 2>/dev/null \
      | grep -E '^\s*(state|pid|last exit code|program|runs) =' || true
  else
    log "State: NOT LOADED (run without flags to install)"
  fi

  if [[ -f "$TARGET" ]]; then
    log "Plist: present at $TARGET"
  else
    log "Plist: absent ($TARGET)"
  fi

  log ""
  log "Recent stderr (/tmp/agent-scheduler.err):"
  if [[ -f /tmp/agent-scheduler.err ]]; then
    tail -n 5 /tmp/agent-scheduler.err 2>/dev/null || true
  else
    log "  (none yet)"
  fi
}

main() {
  case "${1:-}" in
    --uninstall) do_uninstall ;;
    --status|--healthcheck) do_status ;;
    "" ) do_install ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
      ;;
    *)
      err "Unknown argument: $1"
      err "Usage: $0 [--uninstall|--status|--help]"
      exit 2
      ;;
  esac
}

main "$@"
