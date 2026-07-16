#!/usr/bin/env bash
# safe-force-push.sh — a PreToolUse hook that blocks an UNSAFE
# `git push --force*`.
#
# Why this exists: `--force-with-lease` only checks your LOCAL tracking ref, not
# the real remote state, so a force-push can still silently overwrite commits
# someone else pushed to the same branch while you worked elsewhere. The fix has
# to be structural: a hook that ALWAYS fetches and checks before allowing a
# force-push, not a reminder to "remember to fetch."
#
# Protocol (the standard PreToolUse hook contract):
#   * JSON payload on stdin. `.tool_name`, and for Bash `.tool_input.command`.
#   * Exit 0 -> allow. Exit 2 -> block, reason on stderr (shown to the model).
#   * Fail OPEN (exit 0, silent where possible) whenever the hook cannot even
#     determine whether something is unsafe: missing jq, empty payload,
#     non-Bash tool, no git-push-force in the command, no resolvable repo, no
#     resolvable branch. These are all "hook doesn't apply / can't evaluate"
#     cases, not "verified safe" cases — a hook that errors out must never
#     accidentally block unrelated work.
#   * The ONE deliberate exception is fail-CLOSED: once we've identified a real
#     repo + remote + branch and the safety fetch itself fails for a reason
#     other than "branch doesn't exist yet" (network, auth, timeout), we cannot
#     prove the push is safe, so we block rather than guess. This is narrower
#     than, and distinct from, the fail-open default above — see the "genuine
#     fetch failure" branch below.
#
# What "safe" means here: after fetching the specific remote branch being pushed
# to, does that just-fetched state contain any commit the local branch doesn't
# have? If yes, someone moved origin since this branch last saw it -> BLOCK. If
# no, the local branch is a strict descendant of (or equal to) origin, so a
# force-push only rewrites commits this branch already fully accounts for ->
# ALLOW. This is the overwhelmingly common legitimate case (fetched, rebased,
# force-pushing your own rework) and must not be broken.

set -u

if ! command -v jq >/dev/null 2>&1; then
  printf 'safe-force-push.sh: jq not installed, skipping force-push safety check\n' >&2
  exit 0
fi

payload="$(cat)"
if [ -z "${payload}" ]; then
  exit 0
fi

tool_name="$(printf '%s' "${payload}" | jq -r '.tool_name // empty')"
if [ "${tool_name}" != "Bash" ]; then
  exit 0
fi

command_str="$(printf '%s' "${payload}" | jq -r '.tool_input.command // empty')"
if [ -z "${command_str}" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 1: does this command contain a `git push` invocation carrying a force
# flag at all? Everything below this point only runs once a force-push is
# actually found, so a normal command exits fast with no git calls, no network.
#
# Break the command into loose "segments" on shell chain/pipe operators (&&,
# ||, ;, &, |) so a force flag or subcommand belonging to a DIFFERENT chained
# command is never misattributed to an unrelated `git push` elsewhere on the
# same line — e.g. `git branch -f foo && git push origin foo` must NOT be
# flagged: the -f there belongs to `git branch`. This is a light textual split,
# not a real shell parser. (Order matters below: replace the two-char operators
# before their one-char prefixes so `&&`/`||` aren't first split as a stray
# `&`/`|` each.)
normalized="${command_str//&&/$'\n'}"
normalized="${normalized//'||'/$'\n'}"
normalized="${normalized//;/$'\n'}"
normalized="${normalized//&/$'\n'}"
normalized="${normalized//'|'/$'\n'}"

is_git_push_segment() {
  # "git" as its own token (start of segment, or preceded by whitespace/a
  # subshell paren) followed eventually by "push" as its own token. Requiring
  # whitespace immediately after "git" and around "push" is what keeps this
  # from matching "digit push", "mygit push", "git pushsomething", etc.
  #
  # NOTE: the patterns are held in variables rather than written literally
  # inside `[[ =~ ... ]]` — a literal `(` inside a `[...]` bracket expression
  # there trips up bash's OWN parser (paren-balancing at the shell-syntax
  # level, before the string ever reaches the regex engine). Routing through a
  # variable sidesteps that entirely (confirmed under bash 3.2).
  local re_git='(^|[[:space:](])git([[:space:]])'
  local re_push='(^|[[:space:]])push([[:space:]]|$)'
  [[ "$1" =~ $re_git ]] || return 1
  [[ "$1" =~ $re_push ]] || return 1
  return 0
}

has_force_flag() {
  # --force, --force-with-lease (bare, or =<refname>[:<expected>]), or a bare
  # -f — each required to stand as its own whitespace-delimited token so
  # `--force-if-includes` (a real, separate push flag that does nothing without
  # --force/--force-with-lease alongside it) is never mistaken for a force flag
  # by itself. See the NOTE above re: pattern-in-a-variable.
  local re_force='(^|[[:space:]])(--force(-with-lease(=[^[:space:]]*)?)?|-f)([[:space:]]|$)'
  [[ "$1" =~ $re_force ]]
}

matched_seg=""
line=""
while IFS= read -r line || [ -n "${line}" ]; do
  trimmed="$(printf '%s' "${line}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  [ -z "${trimmed}" ] && continue
  if is_git_push_segment "${trimmed}" && has_force_flag "${trimmed}"; then
    matched_seg="${trimmed}"
    break
  fi
done <<< "${normalized}"

if [ -z "${matched_seg}" ]; then
  exit 0
fi
# NOTE: only the FIRST matching segment is checked. A single Bash call chaining
# two independent force-pushes would only have its first one verified — an
# accepted limitation rather than a reason to write a real shell parser here.

# ---------------------------------------------------------------------------
# Step 2: resolve the repo directory the push will actually run in.
#
# The PreToolUse payload carries a top-level `cwd` — the persistent shell's
# current directory, i.e. where the command is about to run — UNLESS the
# command's OWN text starts with its own `cd <dir> &&`, in which case `cwd` is
# NOT predicted forward and still reports the directory *before* that cd. We
# special-case exactly that one gap below, and treat the field as best-effort
# (it may be absent) rather than assuming it is always present.
#
# Priority: explicit leading `cd <dir> &&`/`;` prefix on the WHOLE command >
# payload cwd > this hook process's own inherited cwd (bare `git`, no -C).
#
# Known gap (not handled — not a full parser): an explicit `git -C <dir> push`
# on the matched segment is not specially parsed.
cd_prefix_dir=""
re_cd_prefix='^[[:space:]]*\(?[[:space:]]*cd[[:space:]]+([^[:space:]&;|]+)'
if [[ "${command_str}" =~ ${re_cd_prefix} ]]; then
  cd_prefix_dir="${BASH_REMATCH[1]}"
  cd_prefix_dir="${cd_prefix_dir%\"}"; cd_prefix_dir="${cd_prefix_dir#\"}"
  cd_prefix_dir="${cd_prefix_dir%\'}"; cd_prefix_dir="${cd_prefix_dir#\'}"
fi

payload_cwd="$(printf '%s' "${payload}" | jq -r '.cwd // .workspace.current_dir // empty' 2>/dev/null)"

resolve_dir() {
  # Resolves $1 (possibly relative) against base dir $2 to an absolute path.
  # Best-effort: on failure, echoes $1 unchanged and lets the caller's
  # is-inside-work-tree validation below catch it.
  case "$1" in
    /*) printf '%s' "$1"; return 0 ;;
  esac
  if [ -n "${2:-}" ]; then
    if out="$( cd "$2" 2>/dev/null && cd "$1" 2>/dev/null && pwd )"; then
      printf '%s' "${out}"
      return 0
    fi
  fi
  printf '%s' "$1"
}

repo_dir=""
if [ -n "${cd_prefix_dir}" ]; then
  repo_dir="$(resolve_dir "${cd_prefix_dir}" "${payload_cwd}")"
elif [ -n "${payload_cwd}" ]; then
  repo_dir="${payload_cwd}"
fi
# else: repo_dir stays empty -> git calls below omit -C, falling back to this
# hook process's own inherited cwd as a last-resort best-effort default.

if [ -n "${repo_dir}" ]; then
  git_cmd=(git -C "${repo_dir}")
else
  git_cmd=(git)
fi

if ! "${git_cmd[@]}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # No git repo resolvable at all: "hook can't evaluate", not "verified unsafe"
  # -> fail OPEN. The agent's own `git push` is about to fail on its own too.
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 3: best-effort remote + branch parsing from the matched segment. Don't
# assume the branch being pushed is the checked-out one — an explicit
# remote/refspec argument (`git push --force origin some-branch`, or
# `origin HEAD:some-branch`) always wins over the current-branch default.
post_push="${matched_seg#*push}"

# Word-splitting post_push on whitespace (unquoted `for`) is safe here
# specifically because git ref/remote names cannot contain whitespace.
pos=()
skip_next=0
for tok in ${post_push}; do
  if [ "${skip_next}" = "1" ]; then
    skip_next=0
    continue
  fi
  case "${tok}" in
    -o|--push-option|--receive-pack|--exec)
      # Recognized push flags that take a SEPARATE (non-glued) value token —
      # skip that value too so it's never mistaken for a positional arg.
      skip_next=1
      ;;
    -*)
      : # any other flag (bare or =value glued) — not a positional arg
      ;;
    *)
      pos+=("${tok}")
      ;;
  esac
done

remote="origin"
refspec=""
pos_count="${#pos[@]}"
if [ "${pos_count}" -ge 2 ]; then
  remote="${pos[0]:-origin}"
  refspec="${pos[1]:-}"
elif [ "${pos_count}" -eq 1 ]; then
  # One positional arg: is it a remote name (`git push origin`) or a refspec
  # with an implied default remote (`git push some-branch`)? Disambiguate
  # against the repo's actually configured remotes.
  if "${git_cmd[@]}" remote 2>/dev/null | grep -qxF "${pos[0]:-}"; then
    remote="${pos[0]:-origin}"
  else
    refspec="${pos[0]:-}"
  fi
fi

# --force-with-lease=<refname>[:<expected>] names its ref directly — use it as a
# refspec source when no positional refspec was found above.
re_lease='--force-with-lease=([^[:space:]]+)'
if [ -z "${refspec}" ] && [[ "${matched_seg}" =~ ${re_lease} ]]; then
  lease_val="${BASH_REMATCH[1]}"
  refspec="${lease_val%%:*}"
fi

if [[ "${refspec}" == *:* ]]; then
  local_ref="${refspec%%:*}"
  remote_branch="${refspec#*:}"
else
  local_ref="${refspec}"
  remote_branch="${refspec}"
fi
local_ref="${local_ref#refs/heads/}"
remote_branch="${remote_branch#refs/heads/}"

if [ -z "${local_ref}" ] || [ "${local_ref}" = "HEAD" ] || [ -z "${remote_branch}" ]; then
  cur_branch="$("${git_cmd[@]}" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ -z "${local_ref}" ] || [ "${local_ref}" = "HEAD" ]; then
    local_ref="${cur_branch}"
  fi
  if [ -z "${remote_branch}" ]; then
    remote_branch="${cur_branch}"
  fi
fi

if [ -z "${remote_branch}" ] || [ -z "${local_ref}" ]; then
  # Couldn't resolve a branch at all (e.g. detached HEAD with no explicit
  # refspec and no upstream) -> can't evaluate -> fail open.
  exit 0
fi

if ! "${git_cmd[@]}" rev-parse --verify --quiet "${local_ref}" >/dev/null 2>&1; then
  # local_ref doesn't resolve to a real commit here -> can't evaluate; the push
  # itself would fail for the same reason regardless of this hook.
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 4: fetch the SPECIFIC remote branch and see what it actually has.
# Bounded with `timeout` (falls back to unbounded if `timeout` isn't on PATH)
# so a hung network call can't hang the tool call forever.
if command -v timeout >/dev/null 2>&1; then
  fetch_err="$(timeout 15 "${git_cmd[@]}" fetch "${remote}" "${remote_branch}" 2>&1 1>/dev/null)"
  fetch_rc=$?
else
  fetch_err="$("${git_cmd[@]}" fetch "${remote}" "${remote_branch}" 2>&1 1>/dev/null)"
  fetch_rc=$?
fi

if [ "${fetch_rc}" -ne 0 ]; then
  if printf '%s' "${fetch_err}" | grep -qi "couldn.t find remote ref\|couldn.t find remote branch\|unable to find remote ref"; then
    # A force-push to a brand-new remote branch. There is nothing on origin yet
    # to clobber -> ALLOW.
    exit 0
  fi

  # Genuine fetch failure (network, auth, timeout, ...). We DID identify a real
  # repo/remote/branch, but cannot verify origin's current state. This is the
  # one deliberate fail-CLOSED case (see header): we cannot prove the push is
  # safe, so we refuse to guess rather than silently allow an unverifiable
  # force-push.
  hint="${fetch_err}"
  if [ "${fetch_rc}" -eq 124 ]; then
    hint="timed out after 15s"
  fi
  [ -n "${hint}" ] || hint="unknown error (exit ${fetch_rc})"
  {
    printf 'Blocked by safe-force-push: could not verify origin state before this force-push.\n'
    printf '`git fetch %s %s` failed in %s: %s\n' "${remote}" "${remote_branch}" "${repo_dir:-<hook working directory>}" "${hint}"
    printf 'Refusing to allow an unverifiable force-push rather than risk silently overwriting commits.\n'
    printf 'Check connectivity/auth (e.g. run the fetch manually) and retry.\n'
  } >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Step 5: does origin (just fetched into FETCH_HEAD) have commits this local
# branch hasn't seen? FETCH_HEAD always reflects exactly what was just fetched,
# sidestepping any question of whether the remote-tracking ref got updated.
ahead_count="$("${git_cmd[@]}" rev-list --count "${local_ref}..FETCH_HEAD" 2>/dev/null)"
case "${ahead_count}" in
  ''|*[!0-9]*)
    # rev-list didn't produce a clean count -> can't evaluate -> fail open.
    exit 0
    ;;
esac

if [ "${ahead_count}" -gt 0 ]; then
  # Before blocking: is origin's fetched tip actually a PRIOR STATE OF THIS
  # BRANCH that we ourselves rewrote — a normal rebase/amend + force-push of our
  # own work, the case this header promises to allow? After a rebase our old tip
  # is no longer an ancestor of the new tip, so it surfaces as an "unseen" commit
  # on origin even though WE created it and pushed it last. Mirror git's own
  # --force-if-includes: if origin's tip appears anywhere in THIS branch's
  # reflog, we demonstrably had it locally and moved past it -> safe self-rewrite,
  # ALLOW. A commit someone else pushed that we never had can never be in our own
  # branch's reflog, so this can only ever permit our own rewrites, never the
  # foreign-clobber shape (which falls through to BLOCK below).
  fetch_head_sha="$("${git_cmd[@]}" rev-parse --verify --quiet FETCH_HEAD 2>/dev/null)"
  if [ -n "${fetch_head_sha}" ] \
     && "${git_cmd[@]}" log -g --format='%H' "${local_ref}" 2>/dev/null | grep -qxF "${fetch_head_sha}"; then
    exit 0
  fi

  # Unsafe case: origin has commits this local branch has never seen — someone
  # pushed to this branch while this agent worked elsewhere. BLOCK.
  {
    printf 'Blocked by safe-force-push: origin/%s has %s commit(s) this local branch has not seen.\n' "${remote_branch}" "${ahead_count}"
    printf 'Force-pushing now would silently overwrite them.\n'
    printf 'Fix: run `git fetch %s %s` in %s, inspect `git log %s..FETCH_HEAD`, and reconcile (rebase the new commits in, or ask a teammate) before retrying the force-push.\n' "${remote}" "${remote_branch}" "${repo_dir:-<hook working directory>}" "${local_ref}"
    printf '`--force-with-lease` alone will NOT catch this — it only checks your LOCAL tracking ref, not the real remote state.\n'
  } >&2
  exit 2
fi

# Safe, common case: the agent itself just fetched+rebased and is force-pushing
# its own rebase result. Origin has nothing beyond what the local branch already
# accounts for -> ALLOW. This is the overwhelmingly common legitimate path.
exit 0
