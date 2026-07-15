#!/usr/bin/env bash
# skills/service/service.sh — Service harness CLI (start/stop/list/logs/status/url).
#
# Starts, tracks, and stops the dev services the agent spins up (a local dev
# sandbox first) with port discipline and cross-session visibility. Invoked as
# `<agent> service <verb>` (or directly: `bash skills/service/service.sh <verb>`).
#
# start  <recipe> [--worktree <name>] [--branch <b>] [--repo] [--mode <m>]
#                 [--setup] [--timeout <secs>]
#     Resolve the recipe (config/recipes/<recipe>.json, or the hidden __test
#     recipe), resolve the cwd (worktree/base), allocate ports in reserved
#     agent bands (lib/ports.sh), reserve the registry record, spawn the
#     command DETACHED in its own process group (perl setsid — macOS ships no
#     setsid binary), capture stdout+stderr to .state/logs/<id>.log, wait for
#     readiness (HTTP poll / none), then print a human report ending in the
#     exact stop command.
# stop   <id|--all>   Group-kill the whole process tree (TERM, then KILL after a
#                     grace period), refusing to kill a recycled PID; mark
#                     stopped.
# list   [--json]     Aligned table of tracked services (reaps dead ones first).
# logs   <id> [--follow] [-n N]   tail (-f) a service's log.
# status <id>         Full record + a live liveness re-probe.
# url    <id> [--role <role>]     Print entrypoint URL(s) — the scripting hook.
#
# See plans/service-harness.md for the full design. Requires jq, perl, curl.

set -euo pipefail

# SKILL_DIR = this skill's own dir (config, libs, .state live here).
# WORKSPACE_ROOT = two levels up (repos/ and workspaces/ live there).
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
# shellcheck source=skills/service/lib/registry.sh
source "$SKILL_DIR/lib/registry.sh"
# shellcheck source=skills/service/lib/ports.sh
source "$SKILL_DIR/lib/ports.sh"

EMOJI="🔨"

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

_readiness_timeout() {
  local v
  v="$(_services_config_get readiness_timeout_secs)"
  [ -n "$v" ] && echo "$v" || echo 90
}

_stop_grace() {
  local v
  v="$(_services_config_get stop_grace_secs)"
  [ -n "$v" ] && echo "$v" || echo 10
}

_iso_to_epoch() {
  local ts="$1"
  [ -n "$ts" ] && [ "$ts" != "null" ] || return 0
  date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null \
    || date -d "$ts" +%s 2>/dev/null || echo ""
}

_human_uptime() {
  local started="$1" stopped="$2" start_epoch end_epoch secs
  start_epoch="$(_iso_to_epoch "$started")"
  [ -n "$start_epoch" ] || { echo "-"; return 0; }
  if [ -n "$stopped" ] && [ "$stopped" != "null" ]; then
    end_epoch="$(_iso_to_epoch "$stopped")"
  else
    end_epoch="$(date -u +%s)"
  fi
  [ -n "$end_epoch" ] || { echo "-"; return 0; }
  secs=$((end_epoch - start_epoch))
  [ "$secs" -lt 0 ] && secs=0
  if [ "$secs" -lt 60 ]; then
    echo "${secs}s"
  elif [ "$secs" -lt 3600 ]; then
    echo "$((secs / 60))m"
  else
    echo "$((secs / 3600))h$(((secs % 3600) / 60))m"
  fi
}

# ---------------------------------------------------------------------------
# Recipe resolution
# ---------------------------------------------------------------------------

# resolve_recipe <name> — Print the recipe JSON. The hidden __test recipe is
# synthesized inline (sleeps, binds no port, no readiness gate) so the whole
# lifecycle is exercisable with no repo checkout. Its command can be overridden
# via AGENT_SERVICE_TEST_CMD.
resolve_recipe() {
  local name="$1"
  if [ "$name" = "__test" ]; then
    local cmd="${AGENT_SERVICE_TEST_CMD:-sleep 120}"
    jq -n --arg cmd "$cmd" '{
      name: "__test",
      repo: "__test",
      description: "Hidden self-test recipe (sleep; binds no port)",
      toolchain: [],
      modes: { "default": { command: $cmd, env_ports: {} } },
      default_mode: "default",
      ports: [],
      setup: { commands: [], ready_when: [] },
      env: {}
    }'
    return 0
  fi
  local f="$SKILL_DIR/config/recipes/$name.json"
  if [ ! -f "$f" ]; then
    echo "service: unknown recipe '$name' (no $f)" >&2
    return 1
  fi
  cat "$f"
}

# resolve_cwd <recipe_json> <worktree> — Absolute working directory for the run.
resolve_cwd() {
  local recipe_json="$1" worktree="$2" repo
  repo="$(jq -r '.repo' <<<"$recipe_json")"
  if [ "$repo" = "__test" ]; then
    echo "$WORKSPACE_ROOT"
    return 0
  fi
  if [ -n "$worktree" ]; then
    echo "$WORKSPACE_ROOT/workspaces/$worktree"
    return 0
  fi
  echo "$WORKSPACE_ROOT/repos/$repo"
}

resolve_branch() {
  local cwd="$1" explicit="$2"
  if [ -n "$explicit" ]; then
    echo "$explicit"
    return 0
  fi
  git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""
}

# setup_missing <recipe_json> <cwd> — Print any ready_when paths that don't exist.
setup_missing() {
  local recipe_json="$1" cwd="$2" n i path missing=""
  n="$(jq -r '.setup.ready_when | length' <<<"$recipe_json" 2>/dev/null || echo 0)"
  [ -n "$n" ] || n=0
  i=0
  while [ "$i" -lt "$n" ]; do
    path="$(jq -r ".setup.ready_when[$i]" <<<"$recipe_json")"
    if [ ! -e "$cwd/$path" ]; then
      missing="$missing $path"
    fi
    i=$((i + 1))
  done
  echo "${missing# }"
}

# _node_path_prefix <recipe_json> — For node/pnpm recipes, echo a
# "source <node-env.sh> && " prefix. The detached spawn (and setup) run under
# `bash -l`, which sources ~/.bash_profile — NOT the user's zsh/nvm PATH — so
# pnpm/node would be missing. node-env.sh puts the workspace's Node 22 bin on
# PATH. Non-node recipes (e.g. the __test sleep) get no prefix.
_node_path_prefix() {
  local recipe_json="$1"
  if jq -e '(.toolchain // []) | (index("node") or index("pnpm"))' <<<"$recipe_json" >/dev/null 2>&1; then
    printf 'source %q && ' "$WORKSPACE_ROOT/scripts/lib/node-env.sh"
  fi
}

run_setup() {
  local recipe_json="$1" cwd="$2" n i cmd prefix
  prefix="$(_node_path_prefix "$recipe_json")"
  n="$(jq -r '.setup.commands | length' <<<"$recipe_json" 2>/dev/null || echo 0)"
  [ -n "$n" ] || n=0
  i=0
  while [ "$i" -lt "$n" ]; do
    cmd="$(jq -r ".setup.commands[$i]" <<<"$recipe_json")"
    echo "  setup: $cmd"
    ( cd "$cwd" && bash -lc "${prefix}$cmd" ) || return 1
    i=$((i + 1))
  done
}

# ---------------------------------------------------------------------------
# Allocator lock (atomic mkdir — mirrors the task/scheduler claim-before-act)
# ---------------------------------------------------------------------------

acquire_lock() {
  local lock="$1" tries=0
  until mkdir "$lock" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 200 ]; then
      echo "service: could not acquire allocator lock ($lock)" >&2
      return 1
    fi
    sleep 0.05
  done
}

release_lock() {
  rmdir "$1" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Detached spawn + readiness
# ---------------------------------------------------------------------------

# spawn_service <id> <cwd> <resolved_command> [<path_prefix>] — Launch the
# command detached in its own process/session group and record pid/pgid/
# proc_start. path_prefix (e.g. a node-env source) runs before the command but
# is kept out of the recorded command so the registry stays clean. Echoes the pid.
spawn_service() {
  local id="$1" cwd="$2" resolved_command="$3" path_prefix="${4:-}" log_abs pid proc_start
  log_abs="$(service_registry_log_dir)/$id.log"
  : >"$log_abs"

  # perl POSIX::setsid() makes the child a session+group leader (pgid == pid).
  # macOS has no setsid(1); perl ships with the OS. exec replaces perl with the
  # login shell so env-var assignments in the command reach every child (turbo +
  # both rspack servers inherit one env and one process group).
  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec: $!\n"' \
    -- bash -lc "cd $(printf '%q' "$cwd") && ${path_prefix}${resolved_command}" \
    >>"$log_abs" 2>&1 </dev/null &
  pid=$!
  proc_start="$(service_proc_start "$pid")"

  service_registry_apply "$id" \
    '.pid = $pid | .pgid = $pid | .proc_start = (if $ps == "" then null else $ps end)' \
    --argjson pid "$pid" --arg ps "$proc_start"
  echo "$pid"
}

# wait_ready <id> <timeout_secs> — Poll each port's readiness URL until all pass
# (or the process dies, or timeout). Returns 0 ready, 1 timeout, 2 crashed.
wait_ready() {
  local id="$1" timeout="$2" file probes pid proc_start deadline url code all_ok
  file="$(service_registry_file "$id")"
  probes="$(jq -r '.ports[]? | select(.url != null and .url != "") | .url' "$file" 2>/dev/null || echo "")"
  pid="$(jq -r '.pid // ""' "$file")"
  proc_start="$(jq -r '.proc_start // ""' "$file")"
  deadline=$(($(date +%s) + timeout))
  while true; do
    if ! service_pid_matches "$pid" "$proc_start"; then
      return 2
    fi
    if [ -z "$probes" ]; then
      return 0
    fi
    all_ok=1
    while IFS= read -r url; do
      [ -n "$url" ] || continue
      # `|| true` keeps command-substitution exit 0 under set -e; curl still
      # emits its %{http_code} (000 on a refused connection) before failing.
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)"
      code="${code:-000}"
      if [ "$code" != "200" ]; then
        all_ok=0
        break
      fi
    done <<<"$probes"
    if [ "$all_ok" -eq 1 ]; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      return 1
    fi
    sleep 0.5
  done
}

# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

print_report() {
  local id="$1" ready_secs="$2" file recipe worktree branch status command log_rel
  file="$(service_registry_file "$id")"
  recipe="$(jq -r '.recipe' "$file")"
  worktree="$(jq -r '.worktree // "-"' "$file")"
  branch="$(jq -r '.branch // "-"' "$file")"
  status="$(jq -r '.status' "$file")"
  command="$(jq -r '.command' "$file")"
  log_rel="$(jq -r '.log_file' "$file")"

  echo ""
  printf '%s Service started — %s  (%s)\n' "$EMOJI" "$recipe" "$id"
  printf '   worktree   %-32s branch  %s\n' "$worktree" "$branch"
  case "$status" in
    running)
      if [ -n "$ready_secs" ]; then
        printf '   status     running (ready in %ss)\n' "$ready_secs"
      else
        printf '   status     running\n'
      fi
      ;;
    unhealthy) printf '   status     unhealthy (readiness timed out)\n' ;;
    crashed) printf '   status     crashed (process exited during startup)\n' ;;
    *) printf '   status     %s\n' "$status" ;;
  esac
  printf '   command    %s\n' "$command"

  # Port lines: entrypoint ports get an arrow. Skipped entirely when portless.
  local nports i role url
  nports="$(jq -r '.ports | length' "$file")"
  if [ "$nports" -gt 0 ]; then
    echo ""
    i=0
    while [ "$i" -lt "$nports" ]; do
      role="$(jq -r ".ports[$i].role" "$file")"
      url="$(jq -r ".ports[$i].url // \"-\"" "$file")"
      if jq -e --arg u "$url" '(.urls // []) | index($u)' "$file" >/dev/null 2>&1; then
        printf '   %-10s %-44s ← open this\n' "$role" "$url"
      else
        printf '   %-10s %s\n' "$role" "$url"
      fi
      i=$((i + 1))
    done
  fi

  echo ""
  printf '   log file   %s\n' "$log_rel"
  printf '   logs       <agent> service logs %s --follow\n' "$id"
  printf '   stop       <agent> service stop %s\n' "$id"
  echo ""
  echo "   Runs across sessions. See everything: <agent> service list"

  if [ "$status" = "unhealthy" ]; then
    echo ""
    echo "   --- last log lines ---"
    tail -n 20 "$(service_registry_log_dir)/$id.log" 2>/dev/null | sed 's/^/   /' || true
  fi
}

# ---------------------------------------------------------------------------
# Verbs
# ---------------------------------------------------------------------------

cmd_start() {
  local recipe_name="" worktree="" branch="" mode="" timeout="" do_setup=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --worktree) worktree="${2:?--worktree needs a value}"; shift 2 ;;
      --branch) branch="${2:?--branch needs a value}"; shift 2 ;;
      --repo) shift ;; # explicit "use the base repos/<repo> checkout" — already the default
      --mode) mode="${2:?--mode needs a value}"; shift 2 ;;
      --timeout) timeout="${2:?--timeout needs a value}"; shift 2 ;;
      --setup) do_setup=true; shift ;;
      -*) echo "start: unknown option '$1'" >&2; return 1 ;;
      *)
        if [ -z "$recipe_name" ]; then
          recipe_name="$1"
        else
          echo "start: unexpected argument '$1'" >&2
          return 1
        fi
        shift
        ;;
    esac
  done
  [ -n "$recipe_name" ] || { echo "start: recipe/repo name required" >&2; return 1; }

  local recipe_json repo command_tpl cwd
  recipe_json="$(resolve_recipe "$recipe_name")" || return 1
  repo="$(jq -r '.repo' <<<"$recipe_json")"
  [ -n "$mode" ] || mode="$(jq -r '.default_mode' <<<"$recipe_json")"
  command_tpl="$(jq -r --arg m "$mode" '.modes[$m].command // ""' <<<"$recipe_json")"
  [ -n "$command_tpl" ] || { echo "start: mode '$mode' not found in recipe '$recipe_name'" >&2; return 1; }

  cwd="$(resolve_cwd "$recipe_json" "$worktree")"
  if [ ! -d "$cwd" ]; then
    echo "start: working directory not found: $cwd" >&2
    return 1
  fi

  # Setup precheck — refuse (with guidance) unless --setup was passed.
  local missing
  missing="$(setup_missing "$recipe_json" "$cwd")"
  if [ -n "$missing" ]; then
    if $do_setup; then
      echo "start: running setup in $cwd ..."
      run_setup "$recipe_json" "$cwd" || { echo "start: setup failed" >&2; return 1; }
    else
      echo "start: setup incomplete in $cwd (missing: $missing)" >&2
      echo "       run once with --setup, or prepare the worktree manually" >&2
      return 2
    fi
  fi

  local branch_label
  branch_label="$(resolve_branch "$cwd" "$branch")"

  # --- Allocate + reserve under the lock (closes the TOCTOU window) ----------
  service_registry_ensure
  local lock id alloc
  lock="$(service_registry_dir)/.alloc.lock"
  acquire_lock "$lock" || return 1
  id="$(service_generate_id)"
  if ! alloc="$(allocate_ports - <<<"$recipe_json")"; then
    release_lock "$lock"
    echo "start: port allocation failed" >&2
    return 1
  fi

  # Build env prefix + ports JSON array from the allocation.
  local env_prefix="" role var port url ports_json="[]"
  local -a port_objs=()
  while IFS=$'\t' read -r role var port url; do
    [ -n "$role" ] || continue
    env_prefix="${env_prefix}${var}=${port} "
    port_objs+=("$(jq -n --arg role "$role" --arg var "$var" --argjson port "$port" --arg url "$url" \
      '{role: $role, var: $var, port: $port, url: (if $url == "" then null else $url end)}')")
  done <<<"$alloc"
  if [ "${#port_objs[@]}" -gt 0 ]; then
    ports_json="$(printf '%s\n' "${port_objs[@]}" | jq -s '.')"
  fi

  # Entrypoint URLs (recipe declares which roles are entrypoints).
  local urls_json
  urls_json="$(jq -c --argjson ports "$ports_json" '
    [ .ports[] | select(.entrypoint == true) | .role ] as $entry
    | [ $ports[] | select(.role as $r | $entry | index($r)) | .url ]
    | map(select(. != null))
  ' <<<"$recipe_json")"

  local resolved_command
  if [ -n "$env_prefix" ]; then
    resolved_command="${env_prefix}${command_tpl}"
  else
    resolved_command="$command_tpl"
  fi

  local started_at record_json log_rel
  started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  log_rel="$(service_registry_log_relpath "$id")"
  record_json="$(jq -n \
    --arg id "$id" \
    --arg recipe "$recipe_name" \
    --arg repo "$repo" \
    --arg worktree "$worktree" \
    --arg branch "$branch_label" \
    --arg mode "$mode" \
    --arg command "$resolved_command" \
    --arg cwd "$cwd" \
    --argjson ports "$ports_json" \
    --argjson urls "$urls_json" \
    --arg log_file "$log_rel" \
    --arg started_at "$started_at" \
    '{
      id: $id, recipe: $recipe, repo: $repo,
      worktree: (if $worktree == "" then null else $worktree end),
      branch: (if $branch == "" then null else $branch end),
      mode: $mode, command: $command, cwd: $cwd,
      ports: $ports, urls: $urls,
      pid: null, pgid: null, proc_start: null,
      log_file: $log_file, status: "starting",
      started_at: $started_at, stopped_at: null, exit_code: null,
      ready_secs: null, summary: null
    }')"

  if ! service_registry_create "$id" "$record_json"; then
    release_lock "$lock"
    echo "start: failed to write registry record" >&2
    return 1
  fi
  release_lock "$lock"

  # --- Spawn (outside the lock — the slow part) ------------------------------
  local node_prefix
  node_prefix="$(_node_path_prefix "$recipe_json")"
  spawn_service "$id" "$cwd" "$resolved_command" "$node_prefix" >/dev/null

  # --- Wait for readiness ----------------------------------------------------
  local eff_timeout ready_secs="" rc=0 t0 t1
  eff_timeout="${timeout:-$(_readiness_timeout)}"
  t0="$(date +%s)"
  wait_ready "$id" "$eff_timeout" || rc=$?
  t1="$(date +%s)"
  case "$rc" in
    0)
      ready_secs=$((t1 - t0))
      service_registry_update_status "$id" "running"
      service_registry_apply "$id" '.ready_secs = $s' --argjson s "$ready_secs" >/dev/null 2>&1 || true
      ;;
    2) service_registry_update_status "$id" "crashed" ;;
    *) service_registry_update_status "$id" "unhealthy" ;;
  esac

  print_report "$id" "$ready_secs"
  # Non-zero only on a genuine crash (rc==2) so `start && open <url>` won't
  # proceed on a dead process. A readiness timeout (unhealthy, rc==1) stays 0 —
  # a slow first compile may still come up and we never auto-kill it.
  [ "$rc" -ne 2 ]
}

stop_one() {
  local id="$1" file pid pgid proc_start status grace deadline
  file="$(service_registry_file "$id")"
  if [ ! -f "$file" ]; then
    echo "stop: no service '$id'" >&2
    return 1
  fi
  pid="$(jq -r '.pid // ""' "$file")"
  pgid="$(jq -r '.pgid // ""' "$file")"
  proc_start="$(jq -r '.proc_start // ""' "$file")"
  status="$(jq -r '.status' "$file")"

  if [ "$status" = "stopped" ]; then
    echo "Service $id already stopped."
    return 0
  fi

  # Never kill a recycled PID/group.
  if ! service_pid_matches "$pid" "$proc_start"; then
    echo "Service $id is not alive (PID ${pid:-?} gone) — marking crashed."
    service_registry_update_status "$id" "crashed"
    return 0
  fi

  [ -n "$pgid" ] || pgid="$pid"
  kill -TERM "-$pgid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true

  grace="$(_stop_grace)"
  deadline=$(($(date +%s) + grace))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "-$pgid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    sleep 0.3
  fi

  service_registry_update_status "$id" "stopped"
  echo "Stopped service $id."
}

cmd_stop() {
  local target="" all=false rec id any=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --all) all=true; shift ;;
      -*) echo "stop: unknown option '$1'" >&2; return 1 ;;
      *) target="$1"; shift ;;
    esac
  done

  if $all; then
    while IFS= read -r rec; do
      [ -n "$rec" ] || continue
      id="$(jq -r '.id' <<<"$rec")"
      stop_one "$id"
      any=true
    done < <(service_registry_list --active)
    $any || echo "No running services."
    return 0
  fi

  [ -n "$target" ] || { echo "stop: need <id> or --all" >&2; return 1; }
  stop_one "$target"
}

cmd_list() {
  local as_json=false dir rec
  [ "${1:-}" = "--json" ] && as_json=true
  service_registry_cleanup_stale

  if $as_json; then
    service_registry_list
    return 0
  fi

  dir="$(service_registry_dir)"
  if [ ! -d "$dir" ] || ! ls "$dir"/*.json >/dev/null 2>&1; then
    echo "No services tracked."
    return 0
  fi

  printf '%-8s %-11s %-13s %-8s %-8s %-10s %s\n' "ID" "RECIPE" "PORTS" "PID" "UPTIME" "STATUS" "URL"
  while IFS= read -r rec; do
    [ -n "$rec" ] || continue
    local id recipe ports pid status url started_at stopped_at uptime
    id="$(jq -r '.id' <<<"$rec")"
    recipe="$(jq -r '.recipe' <<<"$rec")"
    ports="$(jq -r '[.ports[]?.port] | join(",")' <<<"$rec")"
    [ -n "$ports" ] || ports="-"
    pid="$(jq -r '.pid // "-"' <<<"$rec")"
    status="$(jq -r '.status' <<<"$rec")"
    url="$(jq -r '.urls[0] // "-"' <<<"$rec")"
    started_at="$(jq -r '.started_at // ""' <<<"$rec")"
    stopped_at="$(jq -r '.stopped_at // ""' <<<"$rec")"
    uptime="$(_human_uptime "$started_at" "$stopped_at")"
    printf '%-8s %-11s %-13s %-8s %-8s %-10s %s\n' \
      "$id" "$recipe" "$ports" "$pid" "$uptime" "$status" "$url"
  done < <(service_registry_list)
}

cmd_logs() {
  local id="" follow=false n="" log
  while [ $# -gt 0 ]; do
    case "$1" in
      --follow|-f) follow=true; shift ;;
      -n) n="${2:?-n needs a value}"; shift 2 ;;
      -*) echo "logs: unknown option '$1'" >&2; return 1 ;;
      *) id="$1"; shift ;;
    esac
  done
  [ -n "$id" ] || { echo "logs: need <id>" >&2; return 1; }
  log="$(service_registry_log_dir)/$id.log"
  if [ ! -f "$log" ]; then
    echo "logs: no log for '$id' ($log)" >&2
    return 1
  fi
  if $follow; then
    if [ -n "$n" ]; then tail -n "$n" -f "$log"; else tail -f "$log"; fi
  else
    if [ -n "$n" ]; then tail -n "$n" "$log"; else tail -n 200 "$log"; fi
  fi
}

cmd_status() {
  local id="" as_json=false file pid proc_start
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) as_json=true; shift ;;
      -*) echo "status: unknown option '$1'" >&2; return 1 ;;
      *) id="$1"; shift ;;
    esac
  done
  [ -n "$id" ] || { echo "status: need <id>" >&2; return 1; }
  file="$(service_registry_file "$id")"
  if [ ! -f "$file" ]; then
    echo "status: no service '$id'" >&2
    return 1
  fi
  pid="$(jq -r '.pid // ""' "$file")"
  proc_start="$(jq -r '.proc_start // ""' "$file")"
  local alive=false
  service_pid_matches "$pid" "$proc_start" && alive=true
  if $as_json; then
    # Pure JSON: the record plus a live-probe field, pipeable to jq.
    jq --argjson alive "$alive" '. + {process_alive: $alive}' "$file"
    return 0
  fi
  jq '.' "$file"
  if $alive; then
    echo "process: alive (pid $pid)"
  else
    echo "process: not alive"
  fi
}

cmd_url() {
  local id="" role="" file
  while [ $# -gt 0 ]; do
    case "$1" in
      --role) role="${2:?--role needs a value}"; shift 2 ;;
      -*) echo "url: unknown option '$1'" >&2; return 1 ;;
      *) id="$1"; shift ;;
    esac
  done
  [ -n "$id" ] || { echo "url: need <id>" >&2; return 1; }
  file="$(service_registry_file "$id")"
  if [ ! -f "$file" ]; then
    echo "url: no service '$id'" >&2
    return 1
  fi
  if [ -n "$role" ]; then
    jq -r --arg r "$role" '.ports[] | select(.role == $r) | .url' "$file"
  else
    jq -r '.urls[]? // empty' "$file"
  fi
}

usage() {
  cat <<'USAGE'
Usage: service.sh <start|stop|list|logs|status|url> [args]

  start  <recipe> [--worktree <name>] [--branch <b>] [--repo] [--mode <m>]
                  [--setup] [--timeout <secs>]
  stop   <id|--all>
  list   [--json]
  logs   <id> [--follow] [-n N]
  status <id> [--json]
  url    <id> [--role <role>]

Recipes live in config/recipes/<recipe>.json. The hidden __test recipe runs a
sleep with no ports (self-test). Runtime state lives in .state/ (gitignored).
USAGE
}

main() {
  local verb="${1:-}"
  shift 2>/dev/null || true
  case "$verb" in
    start) cmd_start "$@" ;;
    stop) cmd_stop "$@" ;;
    list) cmd_list "$@" ;;
    logs) cmd_logs "$@" ;;
    status) cmd_status "$@" ;;
    url) cmd_url "$@" ;;
    ""|-h|--help|help) usage ;;
    *) echo "service: unknown verb '$verb'" >&2; usage; return 1 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
