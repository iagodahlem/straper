#!/usr/bin/env bash
# skills/repos/repos.sh — keep base clones under repos/ fast-forwarded so
# worktrees never branch off ancient commits.
#
# Usage (as a library):   source skills/repos/repos.sh
# Usage (as a CLI):       skills/repos/repos.sh sync <name>
#                         skills/repos/repos.sh sync --all
#                         skills/repos/repos.sh status [<name>] [--json]
#                         skills/repos/repos.sh guard <name>
#
# A stale repos/<name> clone is a repeat failure mode: a worktree cut from it
# branches off a commit that's days or weeks behind origin, and the work that
# lands looks based on current main when it isn't. This skill makes "is my
# base clone current" a single command instead of a manual `git fetch` +
# `git log` check nobody remembers to run.
#
# Sourceable, no top-level `set -e`/`set -u` (matches skills/notify/notify.sh)
# so a caller can source it without inheriting stricter shell options. The CLI
# entrypoint below is the only place this script runs unguarded.
#
# Never resets, never force-pushes, never force-checks-out. `repos_sync`
# refuses (with a clear stderr message) on a dirty clone, a clone with local
# commits not on its upstream, or a clone not sitting on its default branch --
# the caller decides what to do about that, this script never guesses.

# Resolve workspace root relative to this script's own location (matches
# scrub.sh / notify.sh): two levels up from skills/repos/repos.sh.
_REPOS_MODULE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_REPOS_ROOT_DIR="${ROOT_DIR:-$(cd "${_REPOS_MODULE_DIR}/../.." && pwd)}"

repos_root_dir() {
  printf '%s' "${_REPOS_ROOT_DIR}"
}

repos_clones_dir() {
  printf '%s/repos' "${_REPOS_ROOT_DIR}"
}

repos_repo_path() {
  printf '%s/%s' "$(repos_clones_dir)" "$1"
}

# --- Config ------------------------------------------------------------------
# skills/repos/config/repos.json — skill-owned config (see docs/concepts.md,
# "Skill-owned config and jobs"). Non-secret, tracked in git. Missing file or
# missing jq both degrade to the built-in default rather than erroring.
_REPOS_DEFAULT_STALENESS_DAYS=7

repos_config_staleness_days() {
  local config_file="${_REPOS_MODULE_DIR}/config/repos.json"
  if [[ -f "$config_file" ]] && command -v jq >/dev/null 2>&1; then
    local value
    value="$(jq -r '.staleness_days // empty' "$config_file" 2>/dev/null)"
    if [[ "$value" =~ ^[0-9]+$ ]]; then
      printf '%s' "$value"
      return 0
    fi
  fi
  printf '%s' "${_REPOS_DEFAULT_STALENESS_DAYS}"
}

# --- Git helpers ---------------------------------------------------------------

repos_is_clone() {
  local repo_path="$1"
  [[ -d "${repo_path}/.git" ]] || [[ -f "${repo_path}/.git" ]]
}

repos_is_dirty() {
  local repo_path="$1"
  [[ -n "$(git -C "$repo_path" status --porcelain 2>/dev/null)" ]]
}

# repos_default_branch <repo_path> — the clone's default branch, detected
# (never hardcoded to "main"). Prefers the cached refs/remotes/origin/HEAD
# symref (no network call); falls back to asking the remote directly and
# caching the answer locally (git remote set-head --auto) when the symref was
# never set (a clone that predates `git clone`'s auto-symref, or one that was
# fetched with --no-tags/shallow options that skip it). Falls back to "main"
# only if the remote itself can't be reached.
repos_default_branch() {
  local repo_path="$1"
  local branch
  branch="$(git -C "$repo_path" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
  if [[ -n "$branch" ]]; then
    printf '%s' "${branch#origin/}"
    return 0
  fi

  if git -C "$repo_path" remote set-head origin --auto >/dev/null 2>&1; then
    branch="$(git -C "$repo_path" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
    if [[ -n "$branch" ]]; then
      printf '%s' "${branch#origin/}"
      return 0
    fi
  fi

  printf 'main'
}

# repos_list_clones — one clone name per line, every directory directly under
# repos/ that looks like a git clone. Silent (no output, exit 0) if repos/
# doesn't exist.
repos_list_clones() {
  local root; root="$(repos_clones_dir)"
  [[ -d "$root" ]] || return 0
  local d name
  for d in "$root"/*/; do
    [[ -d "$d" ]] || continue
    name="$(basename "$d")"
    if repos_is_clone "${root}/${name}"; then
      printf '%s\n' "$name"
    fi
  done
}

# --- Sync ----------------------------------------------------------------------

# repos_sync <name> — fast-forward repos/<name> to its default branch's
# upstream. Refuses (clear stderr message, non-zero exit) rather than
# resetting or forcing anything when the clone:
#   - doesn't exist / isn't a git clone
#   - is in detached HEAD
#   - is checked out on a branch other than its default branch
#   - has uncommitted changes (dirty working tree or index)
#   - has local commits not present on its upstream
# On success, prints one summary line: "<name>: <old>..<new> (<n> commits, <branch>)"
# or "<name>: already up to date (<sha>, <branch>)".
repos_sync() {
  local name="$1"
  if [[ -z "$name" ]]; then
    echo "repos sync: missing repo name" >&2
    return 2
  fi

  local repo_path; repo_path="$(repos_repo_path "$name")"

  if ! repos_is_clone "$repo_path"; then
    echo "repos sync: not a git clone: repos/${name}" >&2
    return 1
  fi

  local branch; branch="$(repos_default_branch "$repo_path")"

  local current_branch
  current_branch="$(git -C "$repo_path" symbolic-ref --quiet --short HEAD 2>/dev/null)"
  if [[ -z "$current_branch" ]]; then
    echo "repos sync: repos/${name} is in detached HEAD -- refusing to sync. Check out ${branch} manually first (never reset, never force)." >&2
    return 1
  fi
  if [[ "$current_branch" != "$branch" ]]; then
    echo "repos sync: repos/${name} is on '${current_branch}', not its default branch '${branch}' -- refusing to sync. Base clones under repos/ are expected to stay on the default branch; worktrees branch off it, not the clone itself." >&2
    return 1
  fi

  if repos_is_dirty "$repo_path"; then
    echo "repos sync: repos/${name} has uncommitted changes -- refusing to sync (never reset, never force). Commit or clean up the clone first." >&2
    return 1
  fi

  if git -C "$repo_path" rev-parse --verify --quiet "refs/remotes/origin/${branch}" >/dev/null 2>&1; then
    local ahead
    ahead="$(git -C "$repo_path" rev-list --count "origin/${branch}..HEAD" 2>/dev/null)"
    ahead="${ahead:-0}"
    if [[ "$ahead" -gt 0 ]]; then
      echo "repos sync: repos/${name} has ${ahead} local commit(s) not on origin/${branch} -- refusing to sync (never reset, never force). Push them upstream or remove them first." >&2
      return 1
    fi
  fi

  local old_sha; old_sha="$(git -C "$repo_path" rev-parse --short HEAD 2>/dev/null)"

  local fetch_err
  if ! fetch_err="$(git -C "$repo_path" fetch origin --quiet 2>&1)"; then
    echo "repos sync: repos/${name} git fetch failed: ${fetch_err}" >&2
    return 1
  fi

  local merge_err
  if ! merge_err="$(git -C "$repo_path" merge --ff-only "origin/${branch}" --quiet 2>&1)"; then
    echo "repos sync: repos/${name} cannot fast-forward -- local ${branch} and origin/${branch} have diverged. Resolve manually (never reset, never force): ${merge_err}" >&2
    return 1
  fi

  local new_sha; new_sha="$(git -C "$repo_path" rev-parse --short HEAD 2>/dev/null)"

  if [[ "$old_sha" == "$new_sha" ]]; then
    echo "${name}: already up to date (${new_sha}, ${branch})"
  else
    local count; count="$(git -C "$repo_path" rev-list --count "${old_sha}..${new_sha}" 2>/dev/null)"
    count="${count:-0}"
    local noun="commits"
    [[ "$count" == "1" ]] && noun="commit"
    echo "${name}: ${old_sha}..${new_sha} (${count} ${noun}, ${branch})"
  fi
  return 0
}

# repos_sync_all — sync every clone under repos/, one summary/failure line
# each (from repos_sync itself). Returns non-zero if any clone failed.
repos_sync_all() {
  local root; root="$(repos_clones_dir)"
  if [[ ! -d "$root" ]]; then
    echo "repos sync --all: no repos/ directory found" >&2
    return 1
  fi

  local failures=0
  local synced=0
  local name
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    synced=$((synced + 1))
    if ! repos_sync "$name"; then
      failures=$((failures + 1))
    fi
  done < <(repos_list_clones)

  if [[ "$synced" -eq 0 ]]; then
    echo "repos sync --all: no clones found under repos/"
    return 0
  fi

  if [[ "$failures" -gt 0 ]]; then
    echo "repos sync --all: ${failures}/${synced} clone(s) failed" >&2
    return 1
  fi
  return 0
}

# --- Status --------------------------------------------------------------------

# _repos_status_fields <name> — computes name/branch/ahead/behind/dirty for one
# clone via exactly one `git fetch` (never mutates beyond that: read-only
# rev-list/status checks after). Prints five tab-separated fields, or a single
# "<name>\tNOTFOUND" row when the clone doesn't exist. Internal helper shared
# by both the plain-text and --json renderers so the fetch only happens once
# per clone regardless of output format.
_repos_status_fields() {
  local name="$1"
  local repo_path; repo_path="$(repos_repo_path "$name")"

  if ! repos_is_clone "$repo_path"; then
    printf '%s\tNOTFOUND\t0\t0\tfalse\n' "$name"
    return 1
  fi

  git -C "$repo_path" fetch origin --quiet 2>/dev/null

  local branch
  branch="$(git -C "$repo_path" symbolic-ref --quiet --short HEAD 2>/dev/null)"
  [[ -z "$branch" ]] && branch="DETACHED"

  local default_branch; default_branch="$(repos_default_branch "$repo_path")"
  local ahead=0 behind=0
  if git -C "$repo_path" rev-parse --verify --quiet "refs/remotes/origin/${default_branch}" >/dev/null 2>&1; then
    ahead="$(git -C "$repo_path" rev-list --count "origin/${default_branch}..HEAD" 2>/dev/null)"
    behind="$(git -C "$repo_path" rev-list --count "HEAD..origin/${default_branch}" 2>/dev/null)"
    ahead="${ahead:-0}"
    behind="${behind:-0}"
  fi

  local dirty="false"
  repos_is_dirty "$repo_path" && dirty="true"

  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$branch" "$ahead" "$behind" "$dirty"
}

# repos_status [<name>] [--json] — one line per clone (or every clone under
# repos/ when no name is given): name, current branch, ahead/behind its
# default branch's upstream (via a single `git fetch` per clone), dirty/clean.
repos_status() {
  local json=0
  local target=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json)
        json=1
        shift
        ;;
      -*)
        echo "repos status: unknown option: $1" >&2
        return 2
        ;;
      *)
        target="$1"
        shift
        ;;
    esac
  done

  local names=()
  if [[ -n "$target" ]]; then
    names=("$target")
  else
    local n
    while IFS= read -r n; do
      names+=("$n")
    done < <(repos_list_clones)
  fi

  if [[ "${#names[@]}" -eq 0 ]]; then
    if [[ "$json" -eq 1 ]]; then
      echo '[]'
    else
      echo "No clones found under repos/."
    fi
    return 0
  fi

  if [[ "$json" -eq 1 ]] && ! command -v jq >/dev/null 2>&1; then
    echo "repos status --json: jq is required for JSON output" >&2
    return 2
  fi

  local rc=0
  local rows=""
  local name fields branch ahead behind dirty
  for name in "${names[@]}"; do
    fields="$(_repos_status_fields "$name")" || rc=1
    IFS=$'\t' read -r _ branch ahead behind dirty <<<"$fields"

    if [[ "$json" -eq 1 ]]; then
      rows+="$(jq -n --arg name "$name" --arg branch "$branch" --argjson ahead "$ahead" --argjson behind "$behind" --argjson dirty "$dirty" \
        '{name: $name, branch: $branch, ahead: $ahead, behind: $behind, dirty: $dirty}')"$'\n'
    else
      if [[ "$branch" == "NOTFOUND" ]]; then
        echo "${name}: not found under repos/"
      else
        local dirty_label="clean"
        [[ "$dirty" == "true" ]] && dirty_label="dirty"
        echo "${name}: branch=${branch} ahead=${ahead} behind=${behind} ${dirty_label}"
      fi
    fi
  done

  if [[ "$json" -eq 1 ]]; then
    printf '%s' "$rows" | jq -s '.'
  fi

  return "$rc"
}

# --- Staleness guard -------------------------------------------------------

# repos_staleness_guard <name> — advisory-only: warns to stderr (never fails,
# always returns 0) when repos/<name>'s HEAD is older than the configured
# threshold (default 7 days, skills/repos/config/repos.json ->
# staleness_days), or when it's behind its default branch's upstream
# according to whatever remote-tracking refs are already cached locally (no
# network call -- that's what makes this cheap enough for a worktree module
# to call unconditionally; `repos sync` is the one that actually fetches).
# Silently returns 0 with no output when the clone doesn't exist -- feature
# detection for callers, not an error.
repos_staleness_guard() {
  local name="$1"
  [[ -z "$name" ]] && return 0

  local repo_path; repo_path="$(repos_repo_path "$name")"
  repos_is_clone "$repo_path" || return 0

  local threshold; threshold="$(repos_config_staleness_days)"

  local head_epoch
  head_epoch="$(git -C "$repo_path" log -1 --format=%ct 2>/dev/null)"
  if [[ -n "$head_epoch" ]]; then
    local now_epoch days_old
    now_epoch="$(date -u +%s)"
    days_old=$(((now_epoch - head_epoch) / 86400))
    if [[ "$days_old" -gt "$threshold" ]]; then
      echo "repos: repos/${name} HEAD is ${days_old} day(s) old (threshold: ${threshold}) -- run \`repos sync ${name}\` before branching off it." >&2
    fi
  fi

  local branch; branch="$(repos_default_branch "$repo_path")"
  if git -C "$repo_path" rev-parse --verify --quiet "refs/remotes/origin/${branch}" >/dev/null 2>&1; then
    local behind
    behind="$(git -C "$repo_path" rev-list --count "HEAD..origin/${branch}" 2>/dev/null)"
    if [[ -n "$behind" ]] && [[ "$behind" -gt 0 ]]; then
      echo "repos: repos/${name} is ${behind} commit(s) behind origin/${branch} as of its last fetch -- run \`repos sync ${name}\` before branching off it." >&2
    fi
  fi

  return 0
}

# --- CLI entrypoint ----------------------------------------------------------
# Only runs when executed directly, not when sourced.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-}" in
    sync)
      shift
      if [[ "${1:-}" == "--all" ]]; then
        repos_sync_all
        exit $?
      fi
      repos_sync "${1:-}"
      exit $?
      ;;
    status)
      shift
      repos_status "$@"
      exit $?
      ;;
    guard)
      shift
      repos_staleness_guard "${1:-}"
      exit $?
      ;;
    -h|--help|"")
      cat <<USAGE_EOF
Usage: repos.sh sync <name>
       repos.sh sync --all
       repos.sh status [<name>] [--json]
       repos.sh guard <name>

sync    Fast-forward repos/<name> to its default branch's upstream (git fetch
        + git merge --ff-only). Refuses on dirty state or local commits ahead
        of upstream -- never resets, never forces.
sync --all
        Sync every clone under repos/. Prints one line per clone; exits
        non-zero if any failed.
status  One line per clone: branch, ahead/behind upstream (single fetch),
        dirty/clean. Omit <name> to list every clone. --json for machine output.
guard   Advisory-only staleness check (stderr warnings, always exits 0). No
        network call -- checks HEAD age and cached ahead/behind state.
USAGE_EOF
      exit 0
      ;;
    *)
      echo "repos.sh: unknown command: ${1}" >&2
      echo "Usage: repos.sh <sync|status|guard> [args]" >&2
      exit 2
      ;;
  esac
fi
