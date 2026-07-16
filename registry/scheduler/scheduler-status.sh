#!/usr/bin/env bash
# skills/scheduler/scheduler-status.sh — read-only status view for the
# out-of-band scheduler. The first of three jobs-UI surfaces.
#
# PURE READ + FORMAT. It NEVER runs a job, never spawns claude -p, never mutates
# state. It reads:
#   - jobs/*/*.md            (one self-contained per-job def — same glob the
#                             scheduler uses; naturally excludes jobs/README.md)
#   - .scheduler/state/<id>.json   (last_run, last_result_hash, in_flight)
#   - .metrics/scheduler.jsonl     (run history → last result + exit code)
#   - skills/scheduler/install.sh --status   (is the LaunchAgent LOADED?)
#
# DUE-CHECK PARITY: the NEXT-DUE computation here MIRRORS the due-check semantics
# in scheduler.sh (is_due / days_allows_today / within_active_hours / the
# every-vs-times split). The frontmatter parser (frontmatter / fm_get /
# fm_get_list) and the time/day helpers are sourced directly from scheduler.sh so
# there is ONE source of truth for due-ness; the only thing this file adds is the
# inverse: "given those gates, what is the next datetime the scheduler WOULD fire
# this job?" Computed against the same gates, in the job's tz.
#
# Output modes:
#   (default)  aligned human table + launchd status line + legend
#   --json     a stable, documented JSON object (the SHARED DATA LAYER a future
#              menubar plugin + dashboard page would consume). See JSON SCHEMA
#              below.
#
# ── JSON SCHEMA (stable; snake_case) ────────────────────────────────────────
# {
#   "scheduler_loaded": bool,        # is the com.agent.scheduler LaunchAgent loaded (macOS)?
#   "generated_at":     iso8601,     # when this snapshot was produced (UTC)
#   "jobs": [
#     {
#       "id":              str,      # job id (state-file key)
#       "schedule_human":  str,      # "10:00,14:00,18:30 Mon-Fri UTC" | "every 1h Mon-Fri"
#       "schedule_raw":    str,      # the raw `every:` value or `times:` list joined by ","
#       "days":            str,      # raw days spec ("mon-fri" | "all" | ...)
#       "tz":              str,      # IANA tz
#       "times":           [str]|null,  # list of HH:MM (when a times: schedule), else null
#       "every":           str|null, # the every: duration (when an interval schedule), else null
#       "active_hours":    str,      # raw active_hours window ("" if none)
#       "last_run_epoch":  int|null, # state last_run (null = never)
#       "last_run_iso":    str|null, # last_run as local ISO-8601, or null
#       "next_due_iso":    str|null, # next datetime the scheduler would fire (local ISO), or null
#       "last_result":     str,      # "ok" | "failed" | "unknown" (from metrics)
#       "last_exit_code":  int|null, # exit code of the most recent run, or null
#       "last_delivered":  bool|null,# Telegram delivery sentinel of the most recent run
#                                    #   (true|false for jobs that self-deliver, e.g.
#                                    #    slack-pulse; null when the job emits no sentinel)
#       "notify":          str,      # notify policy (silent|on-change|always|error)
#       "in_flight":       bool,     # is a claim currently held (running)?
#       "enabled":         bool      # false only when the def sets `enabled: false`
#     }, ...
#   ]
# }
# ─────────────────────────────────────────────────────────────────────────────
#
# bash 3.2 compatible (macOS /bin/bash): no associative arrays, no mapfile, no
# ${var,,}. jq + BSD date only.

set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:$PATH"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR" || exit 1

JOBS_DIR="$ROOT_DIR/jobs"
STATE_DIR="$ROOT_DIR/.scheduler/state"
METRICS_FILE="$ROOT_DIR/.metrics/scheduler.jsonl"
INSTALL_SH="$ROOT_DIR/skills/scheduler/install.sh"
SCHEDULER_SH="$ROOT_DIR/skills/scheduler/scheduler.sh"

NOW_EPOCH="$(date +%s)"

# Field separator for internal records. MUST be non-whitespace: `read` with a
# whitespace IFS (TAB included) collapses consecutive separators, which would
# drop EMPTY fields (e.g. an absent `every:`) and shift every later column. The
# ASCII Unit Separator (0x1f) never appears in our data and is not whitespace, so
# `IFS=$SEP read` preserves empty fields positionally.
SEP=$'\x1f'

# ── Reuse the scheduler's parser + gate helpers (ONE source of truth) ─────────
# We need scheduler.sh's frontmatter parser (frontmatter / fm_get / fm_get_list)
# and its time/day gate helpers (epoch_for_today_hhmm, minutes_now, hhmm_to_min,
# within_active_hours, day_num, days_allows_today, duration_to_seconds) plus the
# state readers (state_file / state_read) so due-ness is computed identically.
#
# Sourcing scheduler.sh wholesale is unsafe: its TOP-LEVEL code re-derives
# ROOT_DIR (from THIS sourced path), `cd`s there, `mkdir`s state dirs, and runs
# `main "$@"` — all of which would clobber our paths / fire a tick / touch the FS.
# So we extract ONLY the function definitions (brace-tracked) into a temp file and
# source that. No top-level statements survive → no cd, no mkdir, no tick.
SCHED_LIB="$(mktemp -t agent-sched-lib.XXXXXX)"
trap 'rm -f "$SCHED_LIB"' EXIT
awk '
  # Detect a function header:  name() {  /  name () {  / one-liners / trailing
  # comments after the opening brace. We require the opening { to be on the
  # header line (true for every function in scheduler.sh) and count braces ON
  # that line too, so one-liners (name() { ...; }) close immediately.
  !infn && /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\([[:space:]]*\)[[:space:]]*\{/ {
    infn = 1; depth = 0; print
    n = gsub(/\{/, "{"); depth += n
    n = gsub(/\}/, "}"); depth -= n
    if (depth <= 0) infn = 0
    next
  }
  infn {
    print
    # Track brace depth so nested blocks inside the function are kept whole.
    # (Literal braces in scheduler.sh jq strings are balanced, so they net 0.)
    n = gsub(/\{/, "{"); depth += n
    n = gsub(/\}/, "}"); depth -= n
    if (depth <= 0) infn = 0
    next
  }
' "$SCHEDULER_SH" > "$SCHED_LIB"
# A couple of helpers reference STALE_CLAIM_SECONDS at call time; not needed for
# the status view (we never claim), but define a harmless default in case.
STALE_CLAIM_SECONDS="${STALE_CLAIM_SECONDS:-1800}"
# shellcheck disable=SC1090
source "$SCHED_LIB"

# ── Schedule humanizer ───────────────────────────────────────────────────────
# tz_abbrev <tz> — short label for the table (the system abbrev from date for
# the given IANA tz, else the tz itself).
tz_abbrev() {
  local tz="$1"
  case "$tz" in
    "") echo "" ;;
    *) TZ="$tz" date +%Z 2>/dev/null || echo "$tz" ;;
  esac
}

# days_human <days-spec> — "mon-fri" -> "Mon-Fri", "all"/"" -> "" (every day).
# BSD sed has no \b; tokens are 3-letter day names delimited only by - and ,
# (and string ends), so a plain literal substitution is unambiguous here.
days_human() {
  local spec="$1"
  [[ -z "$spec" || "$spec" == "all" ]] && { echo ""; return; }
  printf '%s' "$spec" \
    | sed -e 's/mon/Mon/g' -e 's/tue/Tue/g' -e 's/wed/Wed/g' -e 's/thu/Thu/g' \
          -e 's/fri/Fri/g' -e 's/sat/Sat/g' -e 's/sun/Sun/g'
}

# schedule_human <every> <times-joined> <days> <tz>
schedule_human() {
  local every="$1" times="$2" days="$3" tz="$4"
  local dh ab core
  dh="$(days_human "$days")"
  ab="$(tz_abbrev "$tz")"
  if [[ -n "$every" ]]; then
    core="every $every"
  else
    core="$times"
  fi
  local out="$core"
  [[ -n "$dh" ]] && out="$out $dh"
  [[ -n "$ab" ]] && out="$out $ab"
  printf '%s' "$out"
}

# ── Next-due computation (INVERSE of scheduler.sh is_due, SAME gates) ──────────
# For `every`: next = last_run + interval (or now if never run / already past).
# For `times`: the next scheduled HH:MM (today or a following allowed day) that
#   the scheduler would fire. Honors days_allows_today + within_active_hours by
#   reusing those exact helpers from scheduler.sh.
#
# Echoes an epoch, or empty when undeterminable.
next_due_epoch() {
  local id="$1" every="$2" tz="$3" days="$4" active="$5"
  shift 5
  # remaining args = times list (HH:MM ...)
  local times=("$@")

  local last_run
  last_run="$(state_read "$id" '.last_run' 0)"
  [[ "$last_run" =~ ^[0-9]+$ ]] || last_run=0

  if [[ -n "$every" ]]; then
    local interval; interval="$(duration_to_seconds "$every")"
    (( interval <= 0 )) && { echo ""; return; }
    local cand=$(( last_run + interval ))
    # If it's already overdue (or never ran), the scheduler would fire it on the
    # very next tick that passes the gates — surface "now" as the soonest.
    (( cand < NOW_EPOCH )) && cand="$NOW_EPOCH"
    echo "$cand"
    return
  fi

  # times: schedule. Walk forward day by day (today + up to 13 more) and, for
  # each day that passes days_allows_today, evaluate each HH:MM. A candidate is
  # valid when it is >= now, > last_run, and (for that day's clock) inside
  # active_hours. Return the earliest such epoch.
  (( ${#times[@]} == 0 )) && { echo ""; return; }

  local offset day_ymd hhmm cand_epoch hh mm cand_min smin emin
  local best=""
  for offset in $(seq 0 13); do
    day_ymd="$(TZ="$tz" date -j -v+"${offset}"d +%Y-%m-%d 2>/dev/null)"
    [[ -z "$day_ymd" ]] && continue
    # Day-of-week gate: reuse the SAME mon-fri / list logic via a probe on that
    # date's %u, mirroring days_allows_today (which keys off "today"). We
    # re-implement the gate against an arbitrary date by computing its dow and
    # running the same spec parse scheduler.sh uses.
    _date_allows_spec "$tz" "$days" "$day_ymd" || continue

    for hhmm in "${times[@]}"; do
      [[ -z "$hhmm" ]] && continue
      cand_epoch="$(TZ="$tz" date -j -f "%Y-%m-%d %H:%M" "$day_ymd $hhmm" "+%s" 2>/dev/null)"
      [[ -z "$cand_epoch" ]] && continue
      # Must be in the future AND newer than last_run (scheduler fires once per
      # scheduled time, so a time already consumed by last_run is skipped).
      (( cand_epoch < NOW_EPOCH )) && continue
      (( cand_epoch <= last_run )) && continue
      # active_hours gate for THAT scheduled time (same min-of-day comparison as
      # within_active_hours, evaluated at the candidate time).
      if [[ -n "$active" ]]; then
        cand_min="$(hhmm_to_min "$hhmm")"
        smin="$(hhmm_to_min "${active%%-*}")"
        emin="$(hhmm_to_min "${active##*-}")"
        if (( smin <= emin )); then
          (( cand_min >= smin && cand_min <= emin )) || continue
        else
          (( cand_min >= smin || cand_min <= emin )) || continue
        fi
      fi
      if [[ -z "$best" || cand_epoch -lt best ]]; then
        best="$cand_epoch"
      fi
    done
    # Found a candidate today/this-day → it's the earliest for this day; since we
    # walk days in order, the first day that yields any candidate holds the
    # global minimum across its own times. Stop once we have one.
    [[ -n "$best" ]] && break
  done
  echo "$best"
}

# _date_allows_spec <tz> <days-spec> <YYYY-MM-DD> — 0 if the given DATE is
# allowed by the days spec. Mirrors days_allows_today but for an arbitrary date
# (days_allows_today only ever checks "today"). Same spec grammar: empty/all,
# lo-hi range, or comma list of mon..sun.
_date_allows_spec() {
  local tz="$1" spec="$2" ymd="$3"
  [[ -z "$spec" || "$spec" == "all" ]] && return 0
  local dow
  dow="$(TZ="$tz" date -j -f "%Y-%m-%d" "$ymd" +%u 2>/dev/null)"
  [[ -z "$dow" ]] && return 1
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

# ── Metrics lookup: most recent run for a job ────────────────────────────────
# last_result <id> -> echoes "result\texit_code\tdelivered"  (result:
# ok|failed|unknown, exit_code: integer or empty, delivered: true|false|"").
# Reads the LAST matching `dispatched` line. `delivered` is the optional
# slack-pulse-style delivery sentinel captured by scheduler.sh (empty/absent for
# jobs that don't emit it).
last_result() {
  local id="$1"
  [[ -f "$METRICS_FILE" ]] || { printf 'unknown\t\t'; return; }
  local line
  line="$(grep -F "\"job\":\"$id\"" "$METRICS_FILE" 2>/dev/null \
            | grep -F '"event":"dispatched"' | tail -n 1)"
  if [[ -z "$line" ]]; then
    printf 'unknown\t\t'
    return
  fi
  local ec ok delivered
  ec="$(printf '%s' "$line" | jq -r '.exit_code // empty' 2>/dev/null)"
  ok="$(printf '%s' "$line" | jq -r '.ok // empty' 2>/dev/null)"
  # delivered is true/false/null in the row; map null/absent to empty string.
  # NB: jq's `//` treats `false` as a fallthrough, so test presence explicitly.
  delivered="$(printf '%s' "$line" | jq -r 'if has("delivered") and .delivered != null then (.delivered | tostring) else "" end' 2>/dev/null)"
  if [[ "$ok" == "true" ]]; then
    printf 'ok\t%s\t%s' "$ec" "$delivered"
  else
    printf 'failed\t%s\t%s' "$ec" "$delivered"
  fi
}

# ── Relative time formatter ──────────────────────────────────────────────────
# rel_time <epoch> -> "3m ago" / "in 2h" / "2d ago" (relative to NOW_EPOCH).
rel_time() {
  local then="$1" diff sign suffix abs
  [[ -z "$then" || ! "$then" =~ ^[0-9]+$ ]] && { echo ""; return; }
  diff=$(( then - NOW_EPOCH ))
  if (( diff < 0 )); then abs=$(( -diff )); suffix="ago"; else abs="$diff"; suffix="in"; fi
  local unit
  if (( abs < 60 )); then unit="${abs}s"
  elif (( abs < 3600 )); then unit="$(( abs / 60 ))m"
  elif (( abs < 86400 )); then unit="$(( abs / 3600 ))h"
  else unit="$(( abs / 86400 ))d"; fi
  if [[ "$suffix" == "ago" ]]; then echo "${unit} ago"; else echo "in ${unit}"; fi
}

# local_iso <epoch> -> local ISO-8601 with offset, or empty.
local_iso() {
  local e="$1"
  [[ -z "$e" || ! "$e" =~ ^[0-9]+$ ]] && { echo ""; return; }
  date -r "$e" "+%Y-%m-%dT%H:%M:%S%z" 2>/dev/null
}

# short_local <epoch> -> "Jun 04 14:00" (compact, for the human table).
short_local() {
  local e="$1"
  [[ -z "$e" || ! "$e" =~ ^[0-9]+$ ]] && { echo ""; return; }
  date -r "$e" "+%b %d %H:%M" 2>/dev/null
}

# ── Per-job field extraction (shared by both render modes) ────────────────────
# Echoes a SEP-separated record:
#   id  schedule_human  schedule_raw  days  tz  times_csv  every  active
#   last_run_epoch  last_result  last_exit  notify  in_flight  enabled
#   next_due_epoch  delivered
job_record() {
  local file="$1"
  local fm; fm="$(frontmatter "$file")"
  local id; id="$(fm_get "$fm" id)"
  [[ -z "$id" ]] && id="$(basename "$file" .md)"

  local tz days every active notify enabled_raw
  tz="$(fm_get "$fm" tz)";        tz="${tz:-${AGENT_SCHEDULER_TZ:-UTC}}"
  days="$(fm_get "$fm" days)"
  every="$(fm_get "$fm" every)"
  active="$(fm_get "$fm" active_hours)"
  notify="$(fm_get "$fm" notify)"; notify="${notify:-silent}"
  enabled_raw="$(fm_get "$fm" enabled)"
  local enabled="true"
  [[ "$enabled_raw" == "false" ]] && enabled="false"

  # times list -> array + csv
  local times_arr=() t
  while IFS= read -r t; do [[ -n "$t" ]] && times_arr+=("$t"); done < <(fm_get_list "$fm" times)
  local times_csv=""
  local first=1
  for t in "${times_arr[@]:-}"; do
    [[ -z "$t" ]] && continue
    if (( first )); then times_csv="$t"; first=0; else times_csv="$times_csv,$t"; fi
  done

  local schedule_raw
  if [[ -n "$every" ]]; then schedule_raw="$every"; else schedule_raw="$times_csv"; fi
  local schum; schum="$(schedule_human "$every" "$times_csv" "$days" "$tz")"

  local last_run; last_run="$(state_read "$id" '.last_run' "")"
  [[ "$last_run" =~ ^[0-9]+$ ]] || last_run=""
  local in_flight_raw; in_flight_raw="$(state_read "$id" '.in_flight' "")"
  local in_flight="false"
  [[ -n "$in_flight_raw" && "$in_flight_raw" != "null" && "$in_flight_raw" =~ ^[0-9]+$ ]] && in_flight="true"

  local lr; lr="$(last_result "$id")"
  # lr = "result\texit_code\tdelivered" — split on TAB positionally.
  local result exit_code delivered
  IFS=$'\t' read -r result exit_code delivered <<EOF
$lr
EOF

  local nd=""
  if [[ "$enabled" == "true" ]]; then
    nd="$(next_due_epoch "$id" "$every" "$tz" "$days" "$active" "${times_arr[@]:-}")"
  fi

  printf '%s' "$id"; printf '%s' "$SEP"
  printf '%s' "$schum"; printf '%s' "$SEP"
  printf '%s' "$schedule_raw"; printf '%s' "$SEP"
  printf '%s' "$days"; printf '%s' "$SEP"
  printf '%s' "$tz"; printf '%s' "$SEP"
  printf '%s' "$times_csv"; printf '%s' "$SEP"
  printf '%s' "$every"; printf '%s' "$SEP"
  printf '%s' "$active"; printf '%s' "$SEP"
  printf '%s' "${last_run:-}"; printf '%s' "$SEP"
  printf '%s' "$result"; printf '%s' "$SEP"
  printf '%s' "$exit_code"; printf '%s' "$SEP"
  printf '%s' "$notify"; printf '%s' "$SEP"
  printf '%s' "$in_flight"; printf '%s' "$SEP"
  printf '%s' "$enabled"; printf '%s' "$SEP"
  printf '%s' "${nd:-}"; printf '%s' "$SEP"
  printf '%s\n' "${delivered:-}"
}

# ── Scheduler loaded? (reuse install.sh --status) ────────────────────────────
# Capture the install.sh --status output into a var FIRST, then grep the string.
# Piping `install.sh --status | grep -q` would let grep -q close the pipe early;
# under our `set -o pipefail`, install.sh (which has its own `set -euo pipefail`
# + a trailing tail) dies on SIGPIPE and the pipeline reports failure → false
# negative. Capturing avoids the broken-pipe race entirely.
scheduler_loaded() {
  [[ -f "$INSTALL_SH" ]] || { echo "false"; return; }
  local out
  out="$(bash "$INSTALL_SH" --status 2>/dev/null)"
  case "$out" in
    *"State: LOADED"*) echo "true" ;;
    *) echo "false" ;;
  esac
}

# ── Collect all job files ────────────────────────────────────────────────────
collect_files() {
  shopt -s nullglob
  local f
  for f in "$JOBS_DIR"/*/*.md; do
    [[ "$(basename "$f")" == "README.md" ]] && continue
    printf '%s\n' "$f"
  done
  shopt -u nullglob
}

# ── JSON renderer ────────────────────────────────────────────────────────────
render_json() {
  local loaded; loaded="$(scheduler_loaded)"
  local gen; gen="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Build the jobs array incrementally with jq.
  local jobs_json="[]"
  local file rec
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    rec="$(job_record "$file")"
    IFS="$SEP" read -r id schum sraw days tz times_csv every active last_run result exit_code notify in_flight enabled nd delivered <<EOF
$rec
EOF

    # times -> JSON array or null
    local times_json="null"
    if [[ -z "$every" && -n "$times_csv" ]]; then
      times_json="$(printf '%s' "$times_csv" | jq -Rc 'split(",")')"
    fi
    local every_json="null"
    [[ -n "$every" ]] && every_json="$(printf '%s' "$every" | jq -Rc .)"

    local last_run_epoch_json="null" last_run_iso_json="null"
    if [[ -n "$last_run" ]]; then
      last_run_epoch_json="$last_run"
      local lri; lri="$(local_iso "$last_run")"
      [[ -n "$lri" ]] && last_run_iso_json="$(printf '%s' "$lri" | jq -Rc .)"
    fi

    local next_due_json="null"
    if [[ -n "$nd" ]]; then
      local ndi; ndi="$(local_iso "$nd")"
      [[ -n "$ndi" ]] && next_due_json="$(printf '%s' "$ndi" | jq -Rc .)"
    fi

    local exit_json="null"
    [[ -n "$exit_code" && "$exit_code" =~ ^-?[0-9]+$ ]] && exit_json="$exit_code"

    local delivered_json="null"
    case "$delivered" in
      true) delivered_json="true" ;;
      false) delivered_json="false" ;;
    esac

    local obj
    obj="$(jq -nc \
      --arg id "$id" \
      --arg schedule_human "$schum" \
      --arg schedule_raw "$sraw" \
      --arg days "$days" \
      --arg tz "$tz" \
      --argjson times "$times_json" \
      --argjson every "$every_json" \
      --arg active_hours "$active" \
      --argjson last_run_epoch "$last_run_epoch_json" \
      --argjson last_run_iso "$last_run_iso_json" \
      --argjson next_due_iso "$next_due_json" \
      --arg last_result "$result" \
      --argjson last_exit_code "$exit_json" \
      --argjson last_delivered "$delivered_json" \
      --arg notify "$notify" \
      --argjson in_flight "$in_flight" \
      --argjson enabled "$enabled" \
      '{
        id:$id, schedule_human:$schedule_human, schedule_raw:$schedule_raw,
        days:$days, tz:$tz, times:$times, every:$every, active_hours:$active_hours,
        last_run_epoch:$last_run_epoch, last_run_iso:$last_run_iso,
        next_due_iso:$next_due_iso, last_result:$last_result,
        last_exit_code:$last_exit_code, last_delivered:$last_delivered, notify:$notify,
        in_flight:$in_flight, enabled:$enabled
      }')"
    jobs_json="$(printf '%s' "$jobs_json" | jq -c --argjson o "$obj" '. + [$o]')"
  done < <(collect_files)

  jq -nc \
    --argjson scheduler_loaded "$loaded" \
    --arg generated_at "$gen" \
    --argjson jobs "$jobs_json" \
    '{scheduler_loaded:$scheduler_loaded, generated_at:$generated_at, jobs:$jobs}'
}

# ── Human table renderer ─────────────────────────────────────────────────────
render_human() {
  local loaded; loaded="$(scheduler_loaded)"
  local loaded_label
  if [[ "$loaded" == "true" ]]; then loaded_label="LOADED"; else loaded_label="NOT LOADED"; fi

  printf 'Scheduler: %s  (com.agent.scheduler)\n' "$loaded_label"
  printf '\n'

  # Header + rows assembled into a single buffer, then column-aligned.
  # Columns: JOB | SCHEDULE | LAST RUN | NEXT DUE | LAST RESULT | NOTIFY | STATE
  local buf
  buf="JOB\tSCHEDULE\tLAST RUN\tNEXT DUE\tLAST RESULT\tNOTIFY\tSTATE\n"

  local file rec
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    rec="$(job_record "$file")"
    IFS="$SEP" read -r id schum sraw days tz times_csv every active last_run result exit_code notify in_flight enabled nd delivered <<EOF
$rec
EOF

    # LAST RUN cell
    local lr_cell
    if [[ -n "$last_run" ]]; then
      lr_cell="$(rel_time "$last_run") ($(short_local "$last_run"))"
    else
      lr_cell="never"
    fi

    # NEXT DUE cell
    local nd_cell
    if [[ "$enabled" != "true" ]]; then
      nd_cell="disabled"
    elif [[ -n "$nd" ]]; then
      nd_cell="$(rel_time "$nd") ($(short_local "$nd"))"
    else
      nd_cell="-"
    fi

    # LAST RESULT cell
    local res_cell="$result"
    if [[ "$result" == "failed" && -n "$exit_code" ]]; then
      res_cell="failed(exit $exit_code)"
    elif [[ "$result" == "ok" && -n "$exit_code" && "$exit_code" != "0" ]]; then
      res_cell="ok(exit $exit_code)"
    fi
    # Delivery sentinel (self-delivering jobs like slack-pulse) — append a
    # sent/not-sent tag so a notify:silent job's Telegram delivery is visible.
    # Jobs that emit no sentinel ($delivered empty) get no tag → no clutter.
    if [[ "$delivered" == "true" ]]; then
      res_cell="$res_cell (sent)"
    elif [[ "$delivered" == "false" ]]; then
      res_cell="$res_cell (not sent)"
    fi

    # STATE cell
    local state_cell="idle"
    [[ "$in_flight" == "true" ]] && state_cell="running"

    buf="${buf}${id}\t${schum}\t${lr_cell}\t${nd_cell}\t${res_cell}\t${notify}\t${state_cell}\n"
  done < <(collect_files)

  # Align with column -t over the tab-separated buffer.
  printf '%b' "$buf" | column -t -s $'\t'

  # Legend / last-tick line.
  printf '\n'
  local last_tick=""
  if [[ -f "$METRICS_FILE" ]]; then
    last_tick="$(tail -n 1 "$METRICS_FILE" 2>/dev/null | jq -r '.at // empty' 2>/dev/null)"
  fi
  if [[ -n "$last_tick" ]]; then
    # Convert the UTC metrics ts to a local short form for readability.
    local lt_epoch lt_local
    lt_epoch="$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$last_tick" "+%s" 2>/dev/null)"
    if [[ -n "$lt_epoch" ]]; then
      lt_local="$(short_local "$lt_epoch") ($(rel_time "$lt_epoch"))"
    else
      lt_local="$last_tick"
    fi
    printf 'Last dispatch: %s   |   times in %s\n' "$lt_local" "$(date +%Z 2>/dev/null)"
  fi
  printf 'Legend: NEXT DUE = next datetime the scheduler would fire (same gates as a real tick). STATE: running = in_flight claim held.\n'
  printf 'JSON data layer: bash skills/scheduler/scheduler-status.sh --json\n'
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  if [[ ! -d "$JOBS_DIR" ]]; then
    if [[ "${1:-}" == "--json" ]]; then
      jq -nc --arg g "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{scheduler_loaded:false, generated_at:$g, jobs:[]}'
    else
      printf 'No jobs/ dir at %s\n' "$JOBS_DIR"
    fi
    exit 0
  fi

  case "${1:-}" in
    --json) render_json ;;
    ""|--human) render_human ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
      ;;
    *)
      printf 'Unknown argument: %s\nUsage: %s [--json|--human|--help]\n' "$1" "$0" >&2
      exit 2
      ;;
  esac
}

main "$@"
