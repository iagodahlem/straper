#!/usr/bin/env bash
# skills/notify/notify.sh — Malvin notification fan-out.
#
# Usage (as a library):   source skills/notify/notify.sh
# Usage (as a CLI):       skills/notify/notify.sh <channel> <title> <body>
#                         skills/notify/notify.sh gloss "text with TASK-125"
#
# Cloned from skills/slack-status/slack.sh: a sourceable lib of functions plus a
# CLI entrypoint, all of which **no-op silently (exit 0) when unconfigured** —
# exactly as slack.sh does for a missing Slack token.
#
# Channels:
#   telegram  — outbound sendMessage to the user's own chat (Phase 1, implemented)
#   terminal  — at-desk macOS banner via terminal-notifier (A5, implemented)
#   slack     — DRAFT-ONLY stub (NEVER auto-posts — SOUL.md boundary)
#   memory    — harvest sink stub (A2 owns the real sink)
#
# Long messages: telegram_send_chunked splits a multi-block payload (e.g. the
# scheduled slack-pulse drafts) across multiple sends so each stays under the
# Telegram ~4096-char cap.
#
# SECRETS: the chat id is non-secret (.env: TELEGRAM_CHAT_ID). The bot token is a
# live credential resolved with a TWO-TIER strategy:
#   1. PRIMARY — TELEGRAM_BOT_TOKEN read directly from .env (gitignored). This is
#      the headless-safe path: a launchd / `claude -p` run has NO GUI 1Password
#      session, so a runtime `op read` BLOCKS (it waits for a biometric/desktop
#      unlock that never comes) and hangs the whole job. Reading the token from
#      .env removes that hang entirely.
#   2. FALLBACK — `op read "$TELEGRAM_BOT_TOKEN_OP_REF"` ONLY when the direct
#      token is empty (e.g. an interactive box where .env was never populated but
#      a 1Password session is live). Best-effort; never blocks a configured run.
# The token in .env is NEVER committed (.env is gitignored). Populate it once
# from 1Password — see projects/malvin-heartbeat/notes/telegram-setup.md.

# Resolve workspace root relative to this script (matches slack.sh).
_NOTIFY_ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# --- Config loading ----------------------------------------------------------
# Loads TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN, and TELEGRAM_BOT_TOKEN_OP_REF from
# $ROOT_DIR/.env if not already set in the environment. Only those keys; other
# vars are ignored. The token (TELEGRAM_BOT_TOKEN) may contain `=` so it is split
# only on the FIRST `=`.
notify_load_config() {
  local env_file="$_NOTIFY_ROOT_DIR/.env"
  [[ -f "$env_file" ]] || return 0

  if [[ -z "${TELEGRAM_CHAT_ID:-}" ]]; then
    local chat
    chat="$(grep -E '^TELEGRAM_CHAT_ID=' "$env_file" | head -1 | cut -d= -f2-)"
    [[ -n "$chat" ]] && export TELEGRAM_CHAT_ID="$chat"
  fi

  if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    local tok
    tok="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$env_file" | head -1 | cut -d= -f2-)"
    [[ -n "$tok" ]] && export TELEGRAM_BOT_TOKEN="$tok"
  fi

  if [[ -z "${TELEGRAM_BOT_TOKEN_OP_REF:-}" ]]; then
    local ref
    ref="$(grep -E '^TELEGRAM_BOT_TOKEN_OP_REF=' "$env_file" | head -1 | cut -d= -f2-)"
    [[ -n "$ref" ]] && export TELEGRAM_BOT_TOKEN_OP_REF="$ref"
  fi
}

# Resolves the bot token. Prints it on stdout, or nothing if unresolvable.
#
# PRIMARY: TELEGRAM_BOT_TOKEN (direct from .env / env). This path does NOT call
# `op`, so it never blocks in a headless launchd / `claude -p` context (no GUI
# 1Password session to unlock). This is the load-bearing fix — see the SECRETS
# note at the top of this file.
#
# FALLBACK: `op read "$TELEGRAM_BOT_TOKEN_OP_REF"` ONLY when the direct token is
# empty. The op read is intentionally bounded with `timeout` so that even the
# fallback can never hang a job indefinitely if it is reached headless.
notify_telegram_token() {
  notify_load_config

  # Primary: direct token, no op call.
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    printf '%s' "$TELEGRAM_BOT_TOKEN"
    return 0
  fi

  # Fallback: 1Password (best-effort, bounded so it cannot hang).
  [[ -n "${TELEGRAM_BOT_TOKEN_OP_REF:-}" ]] || return 0
  command -v op >/dev/null 2>&1 || return 0
  if command -v timeout >/dev/null 2>&1; then
    timeout 15 op read "$TELEGRAM_BOT_TOKEN_OP_REF" 2>/dev/null || return 0
  else
    op read "$TELEGRAM_BOT_TOKEN_OP_REF" 2>/dev/null || return 0
  fi
}

# Returns 0 if Telegram is fully configured (chat id present AND a token
# resolvable), 1 otherwise. Used to decide silent no-op.
notify_telegram_configured() {
  notify_load_config
  [[ -n "${TELEGRAM_CHAT_ID:-}" ]] || return 1
  local tok; tok="$(notify_telegram_token)"
  [[ -n "$tok" ]]
}

# Returns 0 if the terminal transport is usable (terminal-notifier on PATH),
# 1 otherwise. Used to decide silent no-op — mirrors notify_telegram_configured.
# `brew install terminal-notifier` is the one manual step; until then this
# returns 1 and the terminal channel no-ops cleanly.
notify_terminal_configured() {
  command -v terminal-notifier >/dev/null 2>&1
}

# Bundle id of the user's terminal app (default: ghostty). terminal-notifier's
# -activate focuses this app when the banner is clicked. Override via
# NOTIFY_TERMINAL_BUNDLE_ID.
NOTIFY_TERMINAL_BUNDLE_ID="${NOTIFY_TERMINAL_BUNDLE_ID:-com.mitchellh.ghostty}"

# --- Scrub -------------------------------------------------------------------
# Strips internal workspace references from outbound text (SOUL.md / TOOLS.md
# "Public vs internal surfaces"). Reads stdin, writes scrubbed text to stdout.
#   - FD-XXX / TASK-XXX  -> removed
#   - standalone A1/A2/A3/F1/R1/T1 sub-item codes -> removed
#   - the word "Malvin" -> "the assistant"
#   - workspace paths (workspaces/ plans/ designs/ agents/ tasks/) -> stripped
#
# Word boundaries differ between GNU sed (\b) and BSD/macOS sed ([[:<:]]/[[:>:]]).
# Probe once and pick the right tokens so the scrub actually fires on macOS.
_NOTIFY_WB_L=""
_NOTIFY_WB_R=""
_notify_init_word_boundaries() {
  [[ -n "$_NOTIFY_WB_L" ]] && return 0
  if printf 'x' | sed -E 's/\bx\b/y/' 2>/dev/null | grep -q '^y$'; then
    _NOTIFY_WB_L='\b'; _NOTIFY_WB_R='\b'          # GNU sed
  else
    _NOTIFY_WB_L='[[:<:]]'; _NOTIFY_WB_R='[[:>:]]' # BSD/macOS sed
  fi
}

notify_scrub() {
  _notify_init_word_boundaries
  local L="$_NOTIFY_WB_L" R="$_NOTIFY_WB_R"
  sed -E \
    -e "s/${L}(FD|TASK)-[0-9]+${R}//g" \
    -e "s/${L}[AFRT][0-9]+${R}//g" \
    -e "s/${L}Malvin${R}/the assistant/g" \
    -e "s#${L}(workspaces|plans|designs|agents|tasks)/[A-Za-z0-9._/-]*##g" \
    | sed -E 's/[[:space:]]{2,}/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//'
}

# Convenience: scrub a single argument string.
notify_scrub_str() { printf '%s' "$1" | notify_scrub; }

# --- Gloss ids ---------------------------------------------------------------
# Expands bare TASK-XXX / FD-XXX tokens into "TASK-XXX (title)" / "FD-XXX
# (title)" — the opposite move from notify_scrub, which DELETES those same
# tokens. Telegram is the user's own private bot chat (not covered by TOOLS.md's
# "Public vs internal surfaces" external table), so a bare id there just
# leaves a confusing gap; what the user wants is the id expanded with its title so
# they don't have to go look it up mid-conversation across parallel sessions.
#
# Title lookup:
#   TASK-XXX -> jq -r '.title // empty' "$_NOTIFY_ROOT_DIR/tasks/TASK-XXX.json"
#               (skipped if jq is absent or the file doesn't exist)
#   FD-XXX   -> YAML frontmatter `title:` in
#               "$_NOTIFY_ROOT_DIR/designs/FD-XXX.md", read via _notify_fm
#               (mirrors the _pulse_fm awk idiom in scripts/session-start.sh —
#               not sourced from there; this file has no dependency on it)
#
# Idempotent: a token already immediately followed by " (" in the text (i.e.
# already glossed) is left alone, so a second gloss pass over already-glossed
# text is a no-op. A token with no resolvable title (missing file, empty
# title, jq absent) is left bare — this never errors or fails a send.
#
# Substitution uses bash's own ${text//pattern/replacement}, NOT sed: a
# task/FD title is arbitrary free text that may contain `&`, `/`, parens,
# etc. Bash's pattern substitution treats the replacement side literally (no
# metacharacter escaping needed); sed's replacement side treats `&` and `/`
# specially and would need fragile per-title escaping.
notify_gloss_ids() {
  local text
  if [[ -n "${1:-}" ]]; then
    text="$1"
  else
    text="$(cat)"
  fi
  [[ -z "$text" ]] && { printf '%s' "$text"; return 0; }

  local id title fm_file
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    # Idempotency guard — already glossed if immediately followed by " (".
    [[ "$text" == *"${id} ("* ]] && continue

    title=""
    case "$id" in
      TASK-*)
        if command -v jq >/dev/null 2>&1 && [[ -f "$_NOTIFY_ROOT_DIR/tasks/${id}.json" ]]; then
          title="$(jq -r '.title // empty' "$_NOTIFY_ROOT_DIR/tasks/${id}.json" 2>/dev/null)"
        fi
        ;;
      FD-*)
        fm_file="$_NOTIFY_ROOT_DIR/designs/${id}.md"
        [[ -f "$fm_file" ]] && title="$(_notify_fm "$fm_file" title)"
        ;;
    esac

    [[ -n "$title" ]] && text="${text//$id/${id} (${title})}"
  done < <(printf '%s' "$text" | grep -oE '(TASK|FD)-[0-9]+' | sort -u)

  printf '%s' "$text"
}

# Convenience: gloss a single argument string. notify_gloss_ids already takes
# $1 directly (arg-based is the primary path; stdin is only a fallback), so
# this is a thin alias — kept for call-site symmetry with notify_scrub_str in
# notify_dispatch, not a separate stdin-filter split.
notify_gloss_ids_str() { notify_gloss_ids "$1"; }

# _notify_fm <file> <key> — read a scalar YAML frontmatter value (first
# fence-delimited block). Mirrors the _pulse_fm awk idiom in
# scripts/session-start.sh (~lines 139-151): stops at the closing --- fence,
# strips surrounding quotes. Not sourced from there — this file has no
# dependency on session-start.sh, just the same shape.
_notify_fm() {
  awk -v k="$2" '
    NR==1 && $0=="---"{f=1; next}
    f && $0=="---"{exit}
    f && $0 ~ "^"k"[[:space:]]*:" {
      sub("^"k"[[:space:]]*:[[:space:]]*", "")
      sub(/[[:space:]]+$/, "")
      gsub(/^"|"$/, "")
      print; exit
    }' "$1" 2>/dev/null
}

# --- Telegram transport ------------------------------------------------------
# telegram_send "<message>"
# Sends a Telegram message to TELEGRAM_CHAT_ID. Silent no-op (return 0) when
# unconfigured, exactly like slack.sh for a missing token.
telegram_send() {
  notify_load_config
  if ! notify_telegram_configured; then
    return 0   # silent no-op — unconfigured
  fi

  local message="${1:-}"
  [[ -z "$message" ]] && return 0

  local token; token="$(notify_telegram_token)"
  [[ -n "$token" ]] || return 0

  local response ok
  response="$(curl -s -X POST \
    "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${message}")"

  ok="$(printf '%s' "$response" | grep -o '"ok":[^,}]*' | head -1 | cut -d: -f2 | tr -d ' "')"
  if [[ "$ok" != "true" ]]; then
    local desc
    desc="$(printf '%s' "$response" | grep -o '"description":"[^"]*"' | head -1 | cut -d'"' -f4)"
    echo "Warning: telegram_send failed: ${desc:-unknown error}" >&2
    return 1
  fi
  return 0
}

# telegram_send_chunked "<message>" [max_chars]
# Sends a (possibly long) message, splitting it across multiple sendMessage
# calls so each stays under Telegram's ~4096-char cap. Default chunk size 3500
# leaves headroom. Splits on paragraph (blank-line) boundaries first, then on
# single newlines, and only hard-cuts a line longer than the cap as a last
# resort — so a paste-ready draft block is never torn mid-line if it fits.
#
# Reads stdin if no "$1" is given, so a caller can pipe a built-up message:
#   printf '%s' "$big" | telegram_send_chunked
# Silent no-op (return 0) when Telegram is unconfigured, exactly like
# telegram_send. Returns non-zero if any chunk send fails.
telegram_send_chunked() {
  local max="${2:-3500}"
  local message
  if [[ -n "${1:-}" ]]; then
    message="$1"
  else
    message="$(cat)"
  fi
  [[ -z "$message" ]] && return 0

  # Short path — one send.
  if (( ${#message} <= max )); then
    telegram_send "$message"
    return $?
  fi

  # Greedy line-accumulation: append whole lines to a buffer until the next line
  # would overflow `max`, then flush the buffer as one chunk. A single line that
  # itself exceeds `max` is hard-split into max-sized pieces.
  local rc=0 buf="" line piece
  while IFS= read -r line || [[ -n "$line" ]]; do
    if (( ${#line} > max )); then
      # Flush whatever is buffered first.
      if [[ -n "$buf" ]]; then
        telegram_send "$buf" || rc=1
        buf=""
      fi
      # Hard-split the over-long line.
      while (( ${#line} > max )); do
        piece="${line:0:$max}"
        telegram_send "$piece" || rc=1
        line="${line:$max}"
      done
      buf="$line"
      continue
    fi

    if [[ -z "$buf" ]]; then
      buf="$line"
    elif (( ${#buf} + 1 + ${#line} > max )); then
      telegram_send "$buf" || rc=1
      buf="$line"
    else
      buf="$buf"$'\n'"$line"
    fi
  done <<< "$message"

  [[ -n "$buf" ]] && { telegram_send "$buf" || rc=1; }
  return $rc
}

# --- Stub transports (documented placeholders for later phases) --------------

# terminal_notify "<title>" "<body>" [group]
# At-desk macOS banner via terminal-notifier. Clicking the banner focuses
# the configured terminal app (-activate), so the user lands back in the terminal that needs them.
#
# Silent no-op (return 0) when terminal-notifier is not on PATH — exactly like
# telegram_send no-ops when Telegram is unconfigured. `brew install
# terminal-notifier` is the one manual step (see
# projects/malvin-heartbeat/notes/macos-notifier.md).
#
# macOS gotchas baked in here (do NOT undo these):
#   * We use terminal-notifier, NOT `osascript -e 'display notification'`:
#     osascript banners open Script Editor when clicked, which is useless.
#   * We pass `-activate <bundle-id>` ALONE. We deliberately do NOT pass
#     `-sender` — combining `-sender` with `-activate` breaks click-to-focus on
#     macOS Sequoia (15.x+). `-activate` by itself is the working path.
#   * ghostty's AppleScript support is limited: `-activate` focuses the ghostty
#     APP, not a specific tab/window. App-level focus is the accepted floor —
#     we intentionally do NOT attempt fragile per-tab/window AppleScript.
#   * `-group <id>` coalesces repeat banners (per session_id) so a chatty
#     session replaces its previous banner instead of stacking them.
terminal_notify() {
  notify_terminal_configured || return 0   # silent no-op — terminal-notifier absent

  local title="${1:-}" body="${2:-}" group="${3:-}"
  [[ -z "$title" && -z "$body" ]] && return 0

  local args=(-title "${title:-Malvin}" -message "${body:-}")
  args+=(-activate "$NOTIFY_TERMINAL_BUNDLE_ID")
  [[ -n "$group" ]] && args+=(-group "$group")

  terminal-notifier "${args[@]}" >/dev/null 2>&1 || return 0
  return 0
}

# slack_notify "<title>" "<body>" — DRAFT-ONLY. NEVER auto-posts (SOUL.md
# boundary). Stub: logs that a draft would be produced and no-ops.
slack_notify() {
  echo "[notify] slack transport is draft-only (no auto-post): ${1:-}" >&2
  return 0
}

# memory_notify "<title>" "<body>" — harvest sink (A2 owns the real writer).
# Stub: no-ops here so the router has a target.
memory_notify() {
  echo "[notify] memory sink owned by harvest mode (A2): ${1:-}" >&2
  return 0
}

# --- Router ------------------------------------------------------------------
# notify_dispatch "<channel>" "<title>" "<body>" [group]
# Routes to the right transport. Scrubs internal refs from title+body before
# any outbound delivery — EXCEPT telegram, which glosses bare TASK-XXX/FD-XXX
# ids into "ID (title)" instead of stripping them (see the telegram case
# below for why). The optional 4th arg is a coalescing group id (used by
# the terminal channel, e.g. a session_id). Returns the transport's real exit
# code (audit fix F4 — previously always returned 0, so a real Telegram
# delivery failure was silently swallowed and nothing recorded it). Existing
# callers already treat a non-zero return as non-fatal (the scheduler's
# `|| log "$id: notify failed (non-fatal)"`, the attention hook's `|| true`),
# so this is safe to propagate. Unknown channels and the non-telegram stub
# transports still always return 0 — only telegram's outcome is meaningful.
#
# Every telegram dispatch attempt also appends a JSON line to
# .metrics/notify.jsonl via _notify_log_telegram_metric (audit fix F4) —
# {at, transport, ok, title} — so a delivery failure leaves forensic evidence
# even when a caller swallows the return code.
_notify_log_telegram_metric() {
  local title="$1" exit_code="$2" ok="true"
  (( exit_code == 0 )) || ok="false"
  command -v jq >/dev/null 2>&1 || return 0
  local metrics_dir="$_NOTIFY_ROOT_DIR/.metrics"
  local metrics_file="$metrics_dir/notify.jsonl"
  local at; at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ( mkdir -p "$metrics_dir" 2>/dev/null \
    && jq -cn \
      --arg at "$at" \
      --arg transport "telegram" \
      --argjson ok "$ok" \
      --arg title "${title:0:60}" \
      '{at:$at, transport:$transport, ok:$ok, title:$title}' \
      >> "$metrics_file"
  ) >/dev/null 2>&1 || true
  return 0
}

notify_dispatch() {
  local channel="${1:-}" title="${2:-}" body="${3:-}" group="${4:-}"

  local s_title s_body
  s_title="$(notify_scrub_str "$title")"
  s_body="$(notify_scrub_str "$body")"

  local rc=0
  case "$channel" in
    telegram)
      # Telegram is the user's own private bot chat directly to them — it is not a
      # public/external surface and isn't even listed in TOOLS.md's "Public vs
      # internal surfaces" table (that table only covers GitHub PR bodies /
      # commits / Slack / customer docs). So telegram GLOSSES bare
      # TASK-XXX/FD-XXX ids (expands them with their title) instead of using
      # notify_scrub_str's strip-everything behavior — deleting a bare id just
      # leaves the user a confusing gap.
      # Do NOT "fix" this back to uniform scrubbing: slack (below) is the one
      # channel that keeps the full strip, since it could plausibly become a
      # real external post later and must never leak workspace refs.
      local g_title g_body msg
      g_title="$(notify_gloss_ids_str "$title")"
      g_body="$(notify_gloss_ids_str "$body")"
      if [[ -n "$g_body" ]]; then
        msg="$(printf '%s\n\n%s' "$g_title" "$g_body")"
      else
        msg="$g_title"
      fi
      telegram_send "$msg"
      rc=$?
      _notify_log_telegram_metric "$g_title" "$rc"
      ;;
    terminal)
      terminal_notify "$s_title" "$s_body" "$group"
      rc=$?
      ;;
    slack)
      slack_notify "$s_title" "$s_body"
      rc=$?
      ;;
    memory)
      memory_notify "$s_title" "$s_body"
      rc=$?
      ;;
    *)
      echo "[notify] unknown channel '$channel' — no-op" >&2
      rc=0
      ;;
  esac
  return "$rc"
}

# --- CLI entrypoint ----------------------------------------------------------
# Only runs when executed directly, not when sourced.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-}" in
    check)
      if notify_telegram_configured; then
        echo "Telegram configured (chat_id set, token resolvable)."
      else
        echo "Telegram not configured (silent no-op mode)."
      fi
      if notify_terminal_configured; then
        echo "Terminal configured (terminal-notifier on PATH; -activate ${NOTIFY_TERMINAL_BUNDLE_ID})."
      else
        echo "Terminal not configured (terminal-notifier absent — silent no-op; brew install terminal-notifier)."
      fi
      ;;
    gloss)
      printf '%s\n' "$(notify_gloss_ids "${2:-}")"
      ;;
    *)
      notify_dispatch "${1:-telegram}" "${2:-}" "${3:-}" "${4:-}"
      ;;
  esac
fi
