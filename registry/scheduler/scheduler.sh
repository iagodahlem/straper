#!/usr/bin/env bash
# skills/scheduler/scheduler.sh — out-of-band scheduler dispatcher (one tick).
#
# Fired every 5 minutes by the com.agent.scheduler LaunchAgent on macOS (RunAtLoad
# + StartInterval=300); on Linux, wire this same script into a systemd user timer
# or cron entry (see scheduler.md "Platform support"). Most ticks are no-ops; only
# a genuinely-due job runs.
#
# Each tick:
#   1. Iterate jobs/*/*.md (one per-job folder def), parse YAML-ish frontmatter.
#   2. DUE-CHECK (zero-inference, pure bash/jq/date) against per-job state.
#   3. CLAIM-BEFORE-ACT — write in_flight before running so overlapping ticks
#      stand down.
#   4. DISPATCH the job's `command` (local substrate only; remote not yet wired). One
#      automatic retry after a 30s sleep on a non-zero exit — only the final
#      attempt's output feeds everything downstream.
#   5. DEDUP + NOTIFY per the job's notify policy via skills/notify/notify.sh.
#      `notify: silent` still never pages on success, but now pages on a final
#      (post-retry) failure too — see the NOTIFY policy comment in run_job().
#   6. Advance last_run only after notify completes; clear in_flight.
#   7. Append one JSON line per outcome to .metrics/scheduler.jsonl. A final
#      failure also (over)writes .metrics/job-logs/<id>-last-fail.log.
#
# Safe to run with no interactive shell profile: PATH is set defensively and
# nvm is never assumed.

set -uo pipefail

# --- Defensive PATH (launchd may give a minimal env) -------------------------
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:$PATH"

# --- Resolve ROOT_DIR robustly ----------------------------------------------
# This script lives at skills/scheduler/scheduler.sh, so the repo root is two
# levels up from its own directory.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR" || exit 1

JOBS_DIR="$ROOT_DIR/jobs"
STATE_DIR="$ROOT_DIR/.scheduler/state"
METRICS_FILE="$ROOT_DIR/.metrics/scheduler.jsonl"
JOB_LOGS_DIR="$ROOT_DIR/.metrics/job-logs"   # failure forensics — one <id>-last-fail.log, overwritten each time
NOTIFY_LIB="$ROOT_DIR/skills/notify/notify.sh"

STALE_CLAIM_SECONDS=1800    # 30 min — an in_flight claim older than this is stale
JOB_RETRY_SLEEP_SECONDS=30  # one retry, after this long, on a non-zero exit

mkdir -p "$STATE_DIR" "$ROOT_DIR/.metrics" "$JOB_LOGS_DIR"

NOW_EPOCH="$(date +%s)"

# --- Logging -----------------------------------------------------------------
log() { printf '[scheduler] %s\n' "$*"; }

# --- Metrics: one JSON line per outcome -------------------------------------
# metric <job-id> <event> <ok:true|false> [extra-json-fields]
metric() {
  local job="$1" event="$2" ok="$3" extra="${4:-}"
  local at
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local line
  line="$(jq -nc \
    --arg job "$job" --arg event "$event" --argjson ok "$ok" --arg at "$at" \
    '{job:$job,event:$event,ok:$ok,at:$at}')"
  if [[ -n "$extra" ]]; then
    line="$(printf '%s' "$line" | jq -c --argjson e "$extra" '. + $e' 2>/dev/null || printf '%s' "$line")"
  fi
  printf '%s\n' "$line" >> "$METRICS_FILE"
}

# --- Frontmatter parsing -----------------------------------------------------
# Extract the YAML-ish block between the first pair of --- fences.
frontmatter() {
  awk 'NR==1 && $0=="---"{f=1;next} f && $0=="---"{exit} f{print}' "$1"
}

# Extract the body (everything after the closing --- fence).
job_body() {
  awk 'BEGIN{n=0} /^---[[:space:]]*$/{n++; next} n>=2{print}' "$1"
}

# fm_get <frontmatter-text> <key> — scalar value, trims surrounding whitespace
# and ONLY a matched pair of wrapping quotes. A value like
#   command: echo "hi"
# keeps its embedded quotes (only fully-wrapped values like "foo" are unquoted),
# so commands with quoted args survive intact.
fm_get() {
  printf '%s\n' "$1" | awk -v k="$2" '
    $0 ~ "^"k"[[:space:]]*:" {
      sub("^"k"[[:space:]]*:[[:space:]]*", "")
      sub(/[[:space:]]+$/, "")
      # Strip a matched pair of wrapping double or single quotes only.
      if ($0 ~ /^".*"$/ || $0 ~ /^'"'"'.*'"'"'$/) {
        $0 = substr($0, 2, length($0) - 2)
      }
      print
      exit
    }'
}

# fm_get_list <frontmatter-text> <key> — values from an inline JSON-ish list
# like  times: ["10:00","14:00"]  -> one per line, quotes stripped.
fm_get_list() {
  local raw
  raw="$(fm_get "$1" "$2")"
  [[ -z "$raw" ]] && return 0
  printf '%s' "$raw" \
    | tr -d '[]' \
    | tr ',' '\n' \
    | sed -E 's/^[[:space:]]*["'"'"']?//; s/["'"'"']?[[:space:]]*$//' \
    | grep -v '^$' || true
}

# --- Time helpers (BSD date) -------------------------------------------------
# epoch_for_today_hhmm <tz> <HH:MM> — epoch of today's HH:MM in the given tz.
epoch_for_today_hhmm() {
  local tz="$1" hhmm="$2" today
  today="$(TZ="$tz" date +%Y-%m-%d)"
  TZ="$tz" date -j -f "%Y-%m-%d %H:%M" "$today $hhmm" "+%s" 2>/dev/null
}

# minutes_now <tz> — current minute-of-day (0..1439) in the given tz.
minutes_now() {
  local tz="$1" h m
  h="$(TZ="$tz" date +%H)"; m="$(TZ="$tz" date +%M)"
  echo $((10#$h * 60 + 10#$m))
}

# hhmm_to_min <HH:MM> -> minute-of-day.
hhmm_to_min() {
  local h="${1%%:*}" m="${1##*:}"
  echo $((10#$h * 60 + 10#$m))
}

# within_active_hours <tz> <HH:MM-HH:MM>  -> 0 if inside (or empty), 1 if outside.
within_active_hours() {
  local tz="$1" range="$2"
  [[ -z "$range" ]] && return 0
  local start="${range%%-*}" end="${range##*-}"
  local now smin emin
  now="$(minutes_now "$tz")"
  smin="$(hhmm_to_min "$start")"; emin="$(hhmm_to_min "$end")"
  if (( smin <= emin )); then
    (( now >= smin && now <= emin )) && return 0 || return 1
  else
    # Overnight window (e.g. 22:00-06:00)
    (( now >= smin || now <= emin )) && return 0 || return 1
  fi
}

# day_num <mon|tue|...> -> 1..7 (1=Mon), or empty for unknown.
# Plain case statement — macOS /bin/bash is 3.2 with NO associative arrays.
day_num() {
  case "$1" in
    mon) echo 1 ;; tue) echo 2 ;; wed) echo 3 ;; thu) echo 4 ;;
    fri) echo 5 ;; sat) echo 6 ;; sun) echo 7 ;;
    *) echo "" ;;
  esac
}

# days_allows_today <tz> <days-spec>  -> 0 if today is allowed (or empty/all).
# days-spec: "mon-fri", "mon,wed,fri", "all", or empty.
days_allows_today() {
  local tz="$1" spec="$2"
  [[ -z "$spec" || "$spec" == "all" ]] && return 0
  local dow            # 1=Mon .. 7=Sun
  dow="$(TZ="$tz" date +%u)"
  if [[ "$spec" == *-* ]]; then
    local lo="${spec%%-*}" hi="${spec##*-}" lon hin
    lon="$(day_num "$lo")"; lon="${lon:-1}"
    hin="$(day_num "$hi")"; hin="${hin:-7}"
    (( dow >= lon && dow <= hin )) && return 0 || return 1
  fi
  local d dn rest="$spec"
  while [[ -n "$rest" ]]; do
    d="${rest%%,*}"
    if [[ "$d" == "$rest" ]]; then rest=""; else rest="${rest#*,}"; fi
    d="$(echo "$d" | tr -d '[:space:]')"
    dn="$(day_num "$d")"
    [[ -n "$dn" && "$dn" == "$dow" ]] && return 0
  done
  return 1
}

# duration_to_seconds <30m|2h|90s|1d> -> seconds (0 on parse failure).
duration_to_seconds() {
  local d="$1" n unit
  n="$(printf '%s' "$d" | grep -oE '^[0-9]+' || echo 0)"
  unit="$(printf '%s' "$d" | grep -oE '[smhd]$' || echo m)"
  case "$unit" in
    s) echo "$n" ;;
    m) echo $((n * 60)) ;;
    h) echo $((n * 3600)) ;;
    d) echo $((n * 86400)) ;;
    *) echo 0 ;;
  esac
}

# --- State helpers -----------------------------------------------------------
state_file() { echo "$STATE_DIR/$1.json"; }

state_read() {  # state_read <id> <jq-filter> <default>
  local f; f="$(state_file "$1")"
  if [[ -f "$f" ]]; then
    jq -r "$2 // \"$3\"" "$f" 2>/dev/null || echo "$3"
  else
    echo "$3"
  fi
}

state_write() {  # state_write <id> <jq-assignment-expr>
  local id="$1" expr="$2" f
  f="$(state_file "$id")"
  local cur="{}"
  [[ -f "$f" ]] && cur="$(cat "$f")"
  printf '%s' "$cur" | jq -c "$expr" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"
}

# --- Due check ---------------------------------------------------------------
# is_due <id> <fm> -> 0 if due now, 1 otherwise. Pure bash/jq/date.
is_due() {
  local id="$1" fm="$2"
  local tz active days every
  tz="$(fm_get "$fm" tz)";          tz="${tz:-${AGENT_SCHEDULER_TZ:-UTC}}"
  active="$(fm_get "$fm" active_hours)"
  days="$(fm_get "$fm" days)"
  every="$(fm_get "$fm" every)"

  # Gates first (cheap rejections).
  days_allows_today "$tz" "$days"   || return 1
  within_active_hours "$tz" "$active" || return 1

  local last_run
  last_run="$(state_read "$id" '.last_run' 0)"
  [[ "$last_run" =~ ^[0-9]+$ ]] || last_run=0

  if [[ -n "$every" ]]; then
    # Interval schedule: due if enough time has elapsed since last_run.
    local interval; interval="$(duration_to_seconds "$every")"
    (( interval <= 0 )) && return 1
    (( NOW_EPOCH - last_run >= interval )) && return 0 || return 1
  fi

  # times: schedule — due if a scheduled HH:MM today has passed and is newer
  # than last_run (so we fire once per scheduled time, not every tick after).
  local hhmm sched_epoch
  while IFS= read -r hhmm; do
    [[ -z "$hhmm" ]] && continue
    sched_epoch="$(epoch_for_today_hhmm "$tz" "$hhmm")"
    [[ -z "$sched_epoch" ]] && continue
    if (( NOW_EPOCH >= sched_epoch && sched_epoch > last_run )); then
      return 0
    fi
  done < <(fm_get_list "$fm" times)

  return 1
}

# --- Claim (idempotency) -----------------------------------------------------
# try_claim <id> -> 0 if we own the run, 1 if another tick owns it.
try_claim() {
  local id="$1" in_flight
  in_flight="$(state_read "$id" '.in_flight' "")"
  if [[ -n "$in_flight" && "$in_flight" != "null" && "$in_flight" =~ ^[0-9]+$ ]]; then
    if (( NOW_EPOCH - in_flight < STALE_CLAIM_SECONDS )); then
      return 1   # fresh claim held by another tick — stand down
    fi
    log "$id: stale in_flight claim ($((NOW_EPOCH - in_flight))s) — reclaiming"
  fi
  state_write "$id" ".in_flight = $NOW_EPOCH"
  return 0
}

# --- Persist job output ------------------------------------------------------
# persist_after_run <id> <pathspecs> — scoped `git add <paths> && git commit` of
# ONLY the declared pathspecs after a successful job run.
#
# Why this exists: a job whose command shells out to a nested `claude -p` (e.g.
# the slack-pulse harvest) writes its holding file from a SEPARATE process. The
# workspace PostToolUse auto-commit hook only fires for the file edits of the
# interactive Claude session that owns the hook — it does NOT fire for files a
# headless `claude -p` writes. Verified 2026-06-01: a manual harvest left
# memory/pulse/<file>.md untracked. So for away-for-days scheduler runs to
# actually persist, the scheduler commits the output itself, scoped to the
# declared paths only (never `git add -A`), so it can never sweep unrelated
# working-tree changes.
#
# Read-only-friendly: if there is nothing to commit under the pathspecs, no-ops.
# Uses --no-verify (the workspace pre-commit hook validates tasks/, irrelevant
# here) and never pushes (pushing is left to the user).
persist_after_run() {
  local id="$1" specs="$2"
  [[ -z "$specs" ]] && return 0
  command -v git >/dev/null 2>&1 || { log "$id: git absent — cannot persist output"; return 0; }

  # Normalize comma/space-separated pathspecs into an array.
  local arr=() p
  specs="${specs//,/ }"
  for p in $specs; do [[ -n "$p" ]] && arr+=("$p"); done
  (( ${#arr[@]} == 0 )) && return 0

  # Anything to commit under these paths (tracked changes OR untracked files)?
  local pending
  pending="$( { git diff --name-only -- "${arr[@]}"; \
                git ls-files --others --exclude-standard -- "${arr[@]}"; } 2>/dev/null )"
  if [[ -z "$pending" ]]; then
    return 0
  fi

  git add -- "${arr[@]}" 2>/dev/null || { log "$id: git add failed — skipping persist"; return 0; }
  if git commit --no-verify -m "chore: persist $id output" >/dev/null 2>&1; then
    log "$id: persisted output ($(printf '%s\n' "$pending" | grep -c .) file(s)) under: ${arr[*]}"
  else
    log "$id: nothing committed (already clean or commit declined)"
  fi
}

# --- Ordinal formatting ("Nth consecutive failure" wording) -------------------
# ordinal_suffix <n> -> st|nd|rd|th for the given non-negative integer.
ordinal_suffix() {
  local n="$1" mod100 mod10
  mod100=$(( n % 100 ))
  if (( mod100 >= 11 && mod100 <= 13 )); then
    echo "th"
    return
  fi
  mod10=$(( n % 10 ))
  case "$mod10" in
    1) echo "st" ;;
    2) echo "nd" ;;
    3) echo "rd" ;;
    *) echo "th" ;;
  esac
}

# --- Dispatch one job --------------------------------------------------------
run_job() {
  local file="$1"
  local fm; fm="$(frontmatter "$file")"
  local id; id="$(fm_get "$fm" id)"
  [[ -z "$id" ]] && id="$(basename "$file" .md)"

  local recurring substrate notify command persist_paths
  recurring="$(fm_get "$fm" recurring)"; recurring="${recurring:-true}"
  substrate="$(fm_get "$fm" substrate)"; substrate="${substrate:-local}"
  notify="$(fm_get "$fm" notify)";       notify="${notify:-silent}"
  command="$(fm_get "$fm" command)"
  # Optional: comma/space-separated pathspecs a job's output must be committed to
  # after a successful run. Needed because a nested `claude -p` writes files
  # OUTSIDE this scheduler process, so the workspace PostToolUse auto-commit hook
  # never fires for them — without an explicit commit the holding file would sit
  # untracked and not survive an away-for-days run. See persist_after_run().
  persist_paths="$(fm_get "$fm" persist_paths)"

  # Not due? cheap exit, no metric noise.
  is_due "$id" "$fm" || return 0

  # Claim before acting.
  if ! try_claim "$id"; then
    log "$id: due but claimed by another tick — skipping"
    metric "$id" "skip_claimed" true
    return 0
  fi

  log "$id: due — dispatching (substrate=$substrate notify=$notify)"

  # Remote substrate is not wired yet — log and stand down gracefully.
  if [[ "$substrate" == "remote" ]]; then
    log "$id: remote substrate not yet wired — skipping"
    metric "$id" "skip_remote" true
    state_write "$id" ".in_flight = null | .last_run = $NOW_EPOCH"
    return 0
  fi

  if [[ -z "$command" ]]; then
    log "$id: no command defined — skipping"
    metric "$id" "no_command" false
    state_write "$id" ".in_flight = null"
    return 0
  fi

  # DISPATCH — run the command, capture stdout + exit. stderr is already
  # folded into this same capture via 2>&1 — confirmed by the failure-forensics handling;
  # nothing here leaks to the launchd log, the whole combined output is what
  # gets hashed, notified on, and (on failure) persisted to job-logs below.
  # Export AGENT_SCHEDULER_JOB into the job's environment so any nested
  # `claude -p` it launches signals the workspace SessionStart/SessionEnd hooks
  # to stand down (no boot/teardown housekeeping, no status churn for headless
  # runs). Consumers dual-read AGENT_SCHEDULER_JOB then the legacy MALVIN_ name.
  # Jobs that never spawn claude simply ignore it.
  local out exit_code retried="false"
  out="$(AGENT_SCHEDULER_JOB=1 bash -lc "$command" 2>&1)"; exit_code=$?

  # RETRY. The 5-week audit found 13 invisible hard failures,
  # all transient (API/connectivity errors like "Connection closed
  # mid-response"). One immediate retry after a short fixed sleep clears most
  # of those without ever paging the user. Only the FINAL attempt's out/exit_code
  # feeds dedup, notify, forensics, and persistence below — a fail-then-succeed
  # run is a success this tick, full stop.
  if (( exit_code != 0 )); then
    metric "$id" "retry" false \
      "$(jq -nc --argjson ec "$exit_code" '{attempt:1,exit_code:$ec}')"
    log "$id: attempt 1 failed (exit $exit_code) — retrying once in ${JOB_RETRY_SLEEP_SECONDS}s"
    retried="true"
    sleep "$JOB_RETRY_SLEEP_SECONDS"
    out="$(AGENT_SCHEDULER_JOB=1 bash -lc "$command" 2>&1)"; exit_code=$?
  fi

  # FORENSICS. On final (post-retry) failure, persist the
  # combined stdout+stderr so the next debugging session has the actual error
  # text instead of nothing. One file per job, OVERWRITTEN each run — this is a
  # debugging aid (newest failure only), not a history.
  if (( exit_code != 0 )); then
    printf '%s\n' "$out" > "$JOB_LOGS_DIR/$id-last-fail.log" 2>/dev/null
  fi

  # DELIVERED sentinel (generic, optional) — a job whose `notify` is `silent`
  # because it delivers Telegram ITSELF (e.g. slack-pulse) is otherwise invisible
  # to metrics: this scheduler never sees the send, so the metric would always say
  # notified:no. Such a job may print a deterministic `delivered_telegram=true|false`
  # line in its stdout. Capture it (last occurrence wins) and surface it as the
  # metric row's `delivered` field. Jobs that never emit it leave `delivered` null
  # — no slack-pulse-specific logic lives in the core, just this sentinel grep.
  local delivered_line delivered_json="null"
  delivered_line="$(printf '%s' "$out" | grep -oE 'delivered_telegram=(true|false)' | tail -n 1)"
  if [[ "$delivered_line" == "delivered_telegram=true" ]]; then
    delivered_json="true"
  elif [[ "$delivered_line" == "delivered_telegram=false" ]]; then
    delivered_json="false"
  fi

  # DEDUP — hash the result.
  local new_hash prev_hash
  new_hash="$(printf '%s' "$out" | shasum -a 256 2>/dev/null | cut -d' ' -f1)"
  prev_hash="$(state_read "$id" '.last_result_hash' "")"

  # FAILURE STREAK. How many ticks in a row has this job ended
  # in failure (after its own retry)? Storage mirrors last_result_hash: a plain
  # field in the same per-job state file. Reset to 0 on any success; +1 on
  # failure. Drives the "Nth consecutive failure" wording below (shown only
  # once N >= 2, so a lone blip doesn't read as a pattern).
  local prev_consecutive_failures consecutive_failures
  prev_consecutive_failures="$(state_read "$id" '.consecutive_failures' 0)"
  [[ "$prev_consecutive_failures" =~ ^[0-9]+$ ]] || prev_consecutive_failures=0
  if (( exit_code != 0 )); then
    consecutive_failures=$(( prev_consecutive_failures + 1 ))
  else
    consecutive_failures=0
  fi

  # NOTIFY policy. `silent` used to mean "never" — the silent-unless-error policy makes it
  # "silent-unless-error": jobs like slack-pulse / workspace-review-weekly /
  # brain-vault-harvest use `silent` because they deliver their OWN Telegram
  # digest on success, but a failure here means that self-delivery never even
  # ran — that must still surface. 13 such failures went unnoticed over 5
  # weeks before this fix (brain-vault-harvest silently broken 2 weeks running).
  local should_notify="no" silent_error="false"
  case "$notify" in
    always)    should_notify="yes" ;;
    error)     (( exit_code != 0 )) && should_notify="yes" ;;
    on-change) [[ "$new_hash" != "$prev_hash" ]] && should_notify="yes" ;;
    silent)    (( exit_code != 0 )) && { should_notify="yes"; silent_error="true"; } ;;
    *)         should_notify="no" ;;
  esac

  if [[ "$should_notify" == "yes" ]]; then
    if [[ -f "$NOTIFY_LIB" ]]; then
      local title body
      if [[ "$silent_error" == "true" ]]; then
        # silent-unless-error alert: distinct, terser format from the generic
        # failure notice below. This fires for jobs that normally never page,
        # so the alert needs to carry enough to act on without a login.
        local tail_lines suffix streak=""
        tail_lines="$(printf '%s\n' "$out" | awk 'NF' | tail -n 3)"
        if (( consecutive_failures >= 2 )); then
          suffix="$(ordinal_suffix "$consecutive_failures")"
          streak=" — ${consecutive_failures}${suffix} consecutive failure"
        fi
        title="⚠️ ${id} failed (exit ${exit_code})${streak}"
        body="last output tail: ${tail_lines}"
      elif (( exit_code != 0 )); then
        title="Job failed: $id (exit $exit_code)"
        body="$out"
      else
        title="Job ran: $id"
        body="$out"
      fi
      # shellcheck source=skills/notify/notify.sh
      ( source "$NOTIFY_LIB" && notify_dispatch "telegram" "$title" "$body" ) \
        || log "$id: notify failed (non-fatal)"
    else
      log "$id: notify.sh absent — degrading (no delivery)"
    fi
  fi

  # Persist job output on success (scoped to declared paths only). A nested
  # `claude -p` writes from a separate process, so the workspace PostToolUse
  # auto-commit hook never sees it — commit it here so away-for-days runs survive.
  if (( exit_code == 0 )); then
    persist_after_run "$id" "$persist_paths"
  fi

  # Advance last_run ONLY after the notify path completes; clear in_flight.
  if [[ "$recurring" == "false" ]]; then
    # One-shot: record a far-future last_run so it never re-fires.
    state_write "$id" \
      ".in_flight = null | .last_run = $NOW_EPOCH | .last_result_hash = \"$new_hash\" | .one_shot_done = true | .consecutive_failures = $consecutive_failures"
  else
    state_write "$id" \
      ".in_flight = null | .last_run = $NOW_EPOCH | .last_result_hash = \"$new_hash\" | .consecutive_failures = $consecutive_failures"
  fi

  local ok="true"; (( exit_code != 0 )) && ok="false"
  metric "$id" "dispatched" "$ok" \
    "$(jq -nc --argjson ec "$exit_code" --arg n "$should_notify" --argjson d "$delivered_json" \
        --argjson retried "$retried" --argjson cf "$consecutive_failures" \
        '{exit_code:$ec,notified:$n,delivered:$d,retried:$retried,consecutive_failures:$cf}')"

  log "$id: done (exit=$exit_code notified=$should_notify retried=$retried)"
}

# --- Main tick ---------------------------------------------------------------
main() {
  if [[ ! -d "$JOBS_DIR" ]]; then
    log "no jobs/ dir — nothing to do"
    exit 0
  fi

  shopt -s nullglob
  local any=0
  # Each job is a self-contained folder jobs/<id>/ holding <id>.md (+ optional
  # run.sh). The jobs/*/*.md glob matches those per-folder defs and naturally
  # EXCLUDES the schema doc jobs/README.md, which sits at the jobs/ root. The
  # README.md guard remains as a harmless safeguard for any doc dropped inside
  # a job folder.
  for file in "$JOBS_DIR"/*/*.md; do
    [[ "$(basename "$file")" == "README.md" ]] && continue
    any=1
    run_job "$file"
  done
  shopt -u nullglob

  (( any == 0 )) && log "no job files found"
  exit 0
}

main "$@"
