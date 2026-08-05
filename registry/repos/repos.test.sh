#!/usr/bin/env bash
set -u
# skills/repos/repos.test.sh — self-running bash harness for repos.sh.
#
# Run via: bash skills/repos/repos.test.sh
#
# No test framework — follows the scripts/tests/*.test.sh / skills/scrub/
# scrub.test.sh convention: numbered cases, a report_case helper, a final
# PASS/FAIL summary, and a matching process exit code.
#
# Everything here runs against a throwaway workspace built from real (but
# fully local, no network) git repos under a mktemp dir — never a real
# repos/<name> clone. The script under test is COPIED into a fake
# skills/repos/ tree inside that throwaway workspace (mirroring exactly what
# a vendored install looks like) so its default ROOT_DIR auto-detection and
# skill-local config resolution behave exactly as they would in a real
# workspace, with nothing hardcoded or faked via env-var overrides.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TMP_ROOT="$(mktemp -d -t repos-tests.XXXXXX)"
trap 'rm -rf "${TMP_ROOT}"' EXIT

WORKSPACE_ROOT="${TMP_ROOT}/workspace"
FAKE_SKILL_DIR="${WORKSPACE_ROOT}/skills/repos"
UPSTREAM_ROOT="${TMP_ROOT}/upstream"

mkdir -p "${FAKE_SKILL_DIR}/config" "${WORKSPACE_ROOT}/repos" "${UPSTREAM_ROOT}"
cp "${SCRIPT_DIR}/repos.sh" "${FAKE_SKILL_DIR}/repos.sh"
cp "${SCRIPT_DIR}/config/repos.json" "${FAKE_SKILL_DIR}/config/repos.json"
chmod +x "${FAKE_SKILL_DIR}/repos.sh"

REPOS="${FAKE_SKILL_DIR}/repos.sh"

if [ ! -x "${REPOS}" ]; then
  echo "ERROR: repos.sh not found or not executable: ${REPOS}" >&2
  exit 1
fi

PASSED=0
FAILED=0
CASE_NUM=0

# ---------------------------------------------------------------------------
# Git fixture helpers — everything local, no network.
# ---------------------------------------------------------------------------

_git_id() {
  git -C "$1" config user.email "test@example.com"
  git -C "$1" config user.name "Test"
}

# new_origin_and_clone <name> — creates upstream/<name> (a real git repo, one
# commit, branch renamed to "main" regardless of git's configured default),
# and clones it into workspace/repos/<name> exactly like a real base clone.
new_origin_and_clone() {
  local name="$1"
  local origin_dir="${UPSTREAM_ROOT}/${name}"
  local clone_dir="${WORKSPACE_ROOT}/repos/${name}"

  mkdir -p "${origin_dir}"
  git init --quiet "${origin_dir}" >/dev/null
  _git_id "${origin_dir}"
  echo "v1" > "${origin_dir}/file.txt"
  git -C "${origin_dir}" add file.txt
  git -C "${origin_dir}" commit --quiet -m "initial commit"
  git -C "${origin_dir}" branch -m main

  git clone --quiet "${origin_dir}" "${clone_dir}" >/dev/null 2>&1
  _git_id "${clone_dir}"
}

# new_backdated_origin_and_clone <name> <iso-date> — like new_origin_and_clone,
# but the initial (and only) commit is authored/committed at <iso-date>,
# set at commit-creation time rather than via `commit --amend` afterward.
# Amending a repo's sole (root) commit produces a brand new, parentless commit
# object with no shared history at all -- a real "unrelated histories" case
# that breaks even a same-content ff-only merge. Backdating at creation time
# avoids that entirely and keeps the clone a plain, already-current clone.
new_backdated_origin_and_clone() {
  local name="$1"
  local iso_date="$2"
  local origin_dir="${UPSTREAM_ROOT}/${name}"
  local clone_dir="${WORKSPACE_ROOT}/repos/${name}"

  mkdir -p "${origin_dir}"
  git init --quiet "${origin_dir}" >/dev/null
  _git_id "${origin_dir}"
  echo "v1" > "${origin_dir}/file.txt"
  git -C "${origin_dir}" add file.txt
  GIT_AUTHOR_DATE="${iso_date}" GIT_COMMITTER_DATE="${iso_date}" git -C "${origin_dir}" commit --quiet -m "initial commit"
  git -C "${origin_dir}" branch -m main

  git clone --quiet "${origin_dir}" "${clone_dir}" >/dev/null 2>&1
  _git_id "${clone_dir}"
}

# advance_origin <name> [n] — n new commits (default 1) on upstream/<name>.
advance_origin() {
  local name="$1"
  local n="${2:-1}"
  local origin_dir="${UPSTREAM_ROOT}/${name}"
  local i
  for ((i = 1; i <= n; i++)); do
    echo "change ${i}" >> "${origin_dir}/file.txt"
    git -C "${origin_dir}" commit --quiet -am "change ${i}"
  done
}

clone_dir_for() { printf '%s/workspace/repos/%s' "${TMP_ROOT}" "$1"; }

# new_origin_and_clone_at <name> <workspace-root> — like new_origin_and_clone,
# but clones into an arbitrary workspace root's repos/ dir instead of the
# shared WORKSPACE_ROOT. Used by the sync --all cases, which need a repos/
# directory that isn't polluted by the individually-broken clones the sync
# refusal cases above leave behind on purpose.
new_origin_and_clone_at() {
  local name="$1"
  local root="$2"
  local origin_dir="${UPSTREAM_ROOT}/${name}"
  local clone_dir="${root}/repos/${name}"

  mkdir -p "${origin_dir}" "${root}/repos"
  git init --quiet "${origin_dir}" >/dev/null
  _git_id "${origin_dir}"
  echo "v1" > "${origin_dir}/file.txt"
  git -C "${origin_dir}" add file.txt
  git -C "${origin_dir}" commit --quiet -m "initial commit"
  git -C "${origin_dir}" branch -m main

  git clone --quiet "${origin_dir}" "${clone_dir}" >/dev/null 2>&1
  _git_id "${clone_dir}"
}

# ---------------------------------------------------------------------------
# Test runner helpers
# ---------------------------------------------------------------------------

LAST_EXIT=0
LAST_STDOUT=""
LAST_STDERR=""

# run_repos <repos.sh args...> — sets LAST_EXIT/LAST_STDOUT/LAST_STDERR.
run_repos() {
  local stdout_file="${TMP_ROOT}/stdout.$$"
  local stderr_file="${TMP_ROOT}/stderr.$$"

  if "${REPOS}" "$@" >"${stdout_file}" 2>"${stderr_file}"; then
    LAST_EXIT=0
  else
    LAST_EXIT=$?
  fi
  LAST_STDOUT="$(cat "${stdout_file}")"
  LAST_STDERR="$(cat "${stderr_file}")"
  rm -f "${stdout_file}" "${stderr_file}"
}

# report_case <num> <desc> <expected_exit> <got_exit> [require_substr] [haystack]
report_case() {
  local num="$1"
  local desc="$2"
  local expected="$3"
  local got="$4"
  local require_substr="${5:-}"
  local haystack="${6:-}"

  if [ "${got}" -ne "${expected}" ]; then
    echo "FAIL: ${num}. ${desc} (exit=${got}, expected=${expected})"
    FAILED=$((FAILED + 1))
    return
  fi

  if [ -n "${require_substr}" ]; then
    case "${haystack}" in
      *"${require_substr}"*) ;;
      *)
        echo "FAIL: ${num}. ${desc} (missing '${require_substr}' in output)"
        FAILED=$((FAILED + 1))
        return
        ;;
    esac
  fi

  echo "PASS: ${num}. ${desc}"
  PASSED=$((PASSED + 1))
}

# assert_true <num> <desc> <condition-as-string-via-[- test>
assert_case() {
  local num="$1"
  local desc="$2"
  local ok="$3" # "1" for pass, "" for fail
  if [ -n "$ok" ]; then
    echo "PASS: ${num}. ${desc}"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL: ${num}. ${desc}"
    FAILED=$((FAILED + 1))
  fi
}

# ---------------------------------------------------------------------------
# Cases: sync
# ---------------------------------------------------------------------------

new_origin_and_clone "web"

# 1. sync on an already-current clone -> "already up to date", exit 0.
CASE_NUM=$((CASE_NUM + 1))
run_repos sync web
report_case "${CASE_NUM}" "sync on a current clone reports 'already up to date'" 0 "${LAST_EXIT}" "already up to date" "${LAST_STDOUT}"

# 2. sync fast-forwards when origin has advanced, reports old..new + commit count.
CASE_NUM=$((CASE_NUM + 1))
advance_origin "web" 3
run_repos sync web
report_case "${CASE_NUM}" "sync fast-forwards and reports the commit count" 0 "${LAST_EXIT}" "3 commits, main" "${LAST_STDOUT}"

CASE_NUM=$((CASE_NUM + 1))
web_head="$(git -C "$(clone_dir_for web)" rev-parse HEAD)"
web_origin_head="$(git -C "${UPSTREAM_ROOT}/web" rev-parse HEAD)"
assert_case "${CASE_NUM}" "sync leaves the clone's HEAD equal to origin's HEAD" "$([ "${web_head}" = "${web_origin_head}" ] && echo 1)"

# 3. sync refuses on a dirty working tree; leaves it untouched.
new_origin_and_clone "dirty"
CASE_NUM=$((CASE_NUM + 1))
echo "uncommitted edit" >> "$(clone_dir_for dirty)/file.txt"
advance_origin "dirty" 1
run_repos sync dirty
report_case "${CASE_NUM}" "sync refuses a dirty clone" 1 "${LAST_EXIT}" "uncommitted changes" "${LAST_STDERR}"

CASE_NUM=$((CASE_NUM + 1))
dirty_head="$(git -C "$(clone_dir_for dirty)" rev-parse HEAD)"
assert_case "${CASE_NUM}" "sync refusing a dirty clone does not advance its HEAD" "$([ "${dirty_head}" != "$(git -C "${UPSTREAM_ROOT}/dirty" rev-parse HEAD)" ] && echo 1)"

# 4. sync refuses when the clone has local commits not on its upstream.
new_origin_and_clone "ahead"
CASE_NUM=$((CASE_NUM + 1))
_git_id "$(clone_dir_for ahead)"
echo "local-only change" >> "$(clone_dir_for ahead)/file.txt"
git -C "$(clone_dir_for ahead)" commit --quiet -am "local commit not pushed anywhere"
run_repos sync ahead
report_case "${CASE_NUM}" "sync refuses a clone with local commits ahead of upstream" 1 "${LAST_EXIT}" "local commit(s)" "${LAST_STDERR}"

# 5. sync refuses on detached HEAD.
new_origin_and_clone "detached"
CASE_NUM=$((CASE_NUM + 1))
detached_sha="$(git -C "$(clone_dir_for detached)" rev-parse HEAD)"
git -C "$(clone_dir_for detached)" checkout --quiet "${detached_sha}"
run_repos sync detached
report_case "${CASE_NUM}" "sync refuses a detached-HEAD clone" 1 "${LAST_EXIT}" "detached HEAD" "${LAST_STDERR}"

# 6. sync refuses when checked out on a non-default branch.
new_origin_and_clone "sidebranch"
CASE_NUM=$((CASE_NUM + 1))
git -C "$(clone_dir_for sidebranch)" checkout --quiet -b feature/other
run_repos sync sidebranch
report_case "${CASE_NUM}" "sync refuses a clone on a non-default branch" 1 "${LAST_EXIT}" "not its default branch" "${LAST_STDERR}"

# 7. sync on a name with no clone under repos/.
CASE_NUM=$((CASE_NUM + 1))
run_repos sync does-not-exist
report_case "${CASE_NUM}" "sync on a missing clone fails clearly" 1 "${LAST_EXIT}" "not a git clone" "${LAST_STDERR}"

# 8. sync with no repo name is a usage error (exit 2).
CASE_NUM=$((CASE_NUM + 1))
run_repos sync
report_case "${CASE_NUM}" "sync with no name is a usage error (exit 2)" 2 "${LAST_EXIT}" "missing repo name" "${LAST_STDERR}"

# 9. sync refuses (does not silently reset) on a genuinely diverged history
# (origin rewrote its tip after the clone's cached remote-tracking ref was
# already equal to the old tip, so the ahead-check passes but the post-fetch
# ff-only merge cannot).
new_origin_and_clone "rewritten"
CASE_NUM=$((CASE_NUM + 1))
git -C "${UPSTREAM_ROOT}/rewritten" commit --quiet --amend -m "rewritten history"
run_repos sync rewritten
report_case "${CASE_NUM}" "sync refuses when local and origin have diverged (no ff possible)" 1 "${LAST_EXIT}" "cannot fast-forward" "${LAST_STDERR}"

CASE_NUM=$((CASE_NUM + 1))
rewritten_head="$(git -C "$(clone_dir_for rewritten)" rev-parse HEAD)"
rewritten_origin_head="$(git -C "${UPSTREAM_ROOT}/rewritten" rev-parse HEAD)"
assert_case "${CASE_NUM}" "a refused diverged sync leaves the clone's HEAD untouched" "$([ "${rewritten_head}" != "${rewritten_origin_head}" ] && echo 1)"

# 10. sync auto-detects the default branch even when refs/remotes/origin/HEAD
# was never set locally (falls back to querying the remote directly).
new_origin_and_clone "nosymref"
CASE_NUM=$((CASE_NUM + 1))
git -C "$(clone_dir_for nosymref)" remote set-head origin --delete >/dev/null 2>&1
advance_origin "nosymref" 2
run_repos sync nosymref
report_case "${CASE_NUM}" "sync detects the default branch without a cached origin/HEAD symref" 0 "${LAST_EXIT}" "2 commits, main" "${LAST_STDOUT}"

# ---------------------------------------------------------------------------
# Cases: sync --all
#
# Runs against a dedicated ALL_ROOT, isolated from WORKSPACE_ROOT/repos --
# the sync-refusal cases above leave several clones (dirty/ahead/detached/...)
# in their broken state on purpose, and sync --all must not trip over them.
# ---------------------------------------------------------------------------

ALL_ROOT="${TMP_ROOT}/all-workspace"
new_origin_and_clone_at "all-a" "${ALL_ROOT}"
new_origin_and_clone_at "all-b" "${ALL_ROOT}"
advance_origin "all-b" 2

# 11. sync --all syncs every clone, one line each, exit 0 when all succeed.
CASE_NUM=$((CASE_NUM + 1))
ROOT_DIR="${ALL_ROOT}" run_repos sync --all
all_ok=""
case "${LAST_STDOUT}" in *"all-a: already up to date"*) case "${LAST_STDOUT}" in *"all-b: "*"2 commits, main"*) all_ok=1 ;; esac ;; esac
[ "${LAST_EXIT}" -eq 0 ] || all_ok=""
assert_case "${CASE_NUM}" "sync --all reports every clone and exits 0 when all succeed" "${all_ok}"

# 12. sync --all is non-zero when at least one clone fails.
new_origin_and_clone_at "all-c" "${ALL_ROOT}"
CASE_NUM=$((CASE_NUM + 1))
echo "uncommitted" >> "${ALL_ROOT}/repos/all-c/file.txt"
ROOT_DIR="${ALL_ROOT}" run_repos sync --all
report_case "${CASE_NUM}" "sync --all exits non-zero when a clone fails" 1 "${LAST_EXIT}" "clone(s) failed" "${LAST_STDERR}"

# 13. sync --all on an empty repos/ directory (a fresh, separate workspace).
CASE_NUM=$((CASE_NUM + 1))
EMPTY_ROOT="${TMP_ROOT}/empty-workspace"
mkdir -p "${EMPTY_ROOT}/repos"
ROOT_DIR="${EMPTY_ROOT}" run_repos sync --all
report_case "${CASE_NUM}" "sync --all on an empty repos/ reports nothing to do, exit 0" 0 "${LAST_EXIT}" "no clones found" "${LAST_STDOUT}"

# 14. sync --all when repos/ itself doesn't exist.
CASE_NUM=$((CASE_NUM + 1))
NOREPOS_ROOT="${TMP_ROOT}/no-repos-dir-workspace"
mkdir -p "${NOREPOS_ROOT}"
ROOT_DIR="${NOREPOS_ROOT}" run_repos sync --all
report_case "${CASE_NUM}" "sync --all with no repos/ directory fails clearly" 1 "${LAST_EXIT}" "no repos/ directory found" "${LAST_STDERR}"

# ---------------------------------------------------------------------------
# Cases: status
# ---------------------------------------------------------------------------

new_origin_and_clone "status-clean"

# 15. status on a clean, current clone.
CASE_NUM=$((CASE_NUM + 1))
run_repos status status-clean
report_case "${CASE_NUM}" "status reports a clean, current clone" 0 "${LAST_EXIT}" "branch=main ahead=0 behind=0 clean" "${LAST_STDOUT}"

# 16. status reports behind>0 without needing (or performing) a sync first.
CASE_NUM=$((CASE_NUM + 1))
advance_origin "status-clean" 2
run_repos status status-clean
report_case "${CASE_NUM}" "status reports behind=N when origin has advanced" 0 "${LAST_EXIT}" "behind=2" "${LAST_STDOUT}"

CASE_NUM=$((CASE_NUM + 1))
status_clean_head_unchanged="$(git -C "$(clone_dir_for status-clean)" rev-parse HEAD)"
assert_case "${CASE_NUM}" "status never advances the clone (read-only)" "$([ "${status_clean_head_unchanged}" != "$(git -C "${UPSTREAM_ROOT}/status-clean" rev-parse HEAD)" ] && echo 1)"

# 17. status reports ahead>0 for local commits (report-only, does not refuse).
new_origin_and_clone "status-ahead"
CASE_NUM=$((CASE_NUM + 1))
echo "local change" >> "$(clone_dir_for status-ahead)/file.txt"
git -C "$(clone_dir_for status-ahead)" commit --quiet -am "local-only"
run_repos status status-ahead
report_case "${CASE_NUM}" "status reports ahead=N and does not refuse" 0 "${LAST_EXIT}" "ahead=1" "${LAST_STDOUT}"

# 18. status reports dirty.
new_origin_and_clone "status-dirty"
CASE_NUM=$((CASE_NUM + 1))
echo "dirty edit" >> "$(clone_dir_for status-dirty)/file.txt"
run_repos status status-dirty
report_case "${CASE_NUM}" "status reports a dirty working tree" 0 "${LAST_EXIT}" "dirty" "${LAST_STDOUT}"

# 19. status on a name with no clone.
CASE_NUM=$((CASE_NUM + 1))
run_repos status does-not-exist
report_case "${CASE_NUM}" "status on a missing clone is reported, non-zero exit" 1 "${LAST_EXIT}" "not found under repos/" "${LAST_STDOUT}"

# 20. status with no name lists every clone under repos/.
CASE_NUM=$((CASE_NUM + 1))
run_repos status
multi_ok=1
case "${LAST_STDOUT}" in *"status-clean:"*) ;; *) multi_ok="" ;; esac
case "${LAST_STDOUT}" in *"status-dirty:"*) ;; *) multi_ok="" ;; esac
assert_case "${CASE_NUM}" "status with no name reports every clone" "${multi_ok}"

# 21. status on an empty repos/ directory.
CASE_NUM=$((CASE_NUM + 1))
ROOT_DIR="${EMPTY_ROOT}" run_repos status
report_case "${CASE_NUM}" "status on an empty repos/ reports nothing found, exit 0" 0 "${LAST_EXIT}" "No clones found" "${LAST_STDOUT}"

# 22. status --json produces a well-formed array with the expected fields.
if command -v jq >/dev/null 2>&1; then
  CASE_NUM=$((CASE_NUM + 1))
  run_repos status status-clean --json
  json_name="$(printf '%s' "${LAST_STDOUT}" | jq -r '.[0].name' 2>/dev/null)"
  json_dirty="$(printf '%s' "${LAST_STDOUT}" | jq -r '.[0].dirty' 2>/dev/null)"
  json_behind="$(printf '%s' "${LAST_STDOUT}" | jq -r '.[0].behind' 2>/dev/null)"
  json_ok=""
  [ "${json_name}" = "status-clean" ] && [ "${json_dirty}" = "false" ] && [ "${json_behind}" = "2" ] && json_ok=1
  assert_case "${CASE_NUM}" "status --json emits {name, branch, ahead, behind, dirty} correctly" "${json_ok}"
else
  echo "SKIP: status --json case (jq not on PATH)"
fi

# 23. status --json on zero clones is an empty JSON array.
if command -v jq >/dev/null 2>&1; then
  CASE_NUM=$((CASE_NUM + 1))
  ROOT_DIR="${EMPTY_ROOT}" run_repos status --json
  report_case "${CASE_NUM}" "status --json on an empty repos/ is []" 0 "${LAST_EXIT}" "[]" "${LAST_STDOUT}"
fi

# ---------------------------------------------------------------------------
# Cases: guard
# ---------------------------------------------------------------------------

# 24. guard on a fresh, current, non-stale clone: silent, exit 0.
new_origin_and_clone "guard-fresh"
CASE_NUM=$((CASE_NUM + 1))
run_repos guard guard-fresh
guard_fresh_ok=""
[ "${LAST_EXIT}" -eq 0 ] && [ -z "${LAST_STDOUT}" ] && [ -z "${LAST_STDERR}" ] && guard_fresh_ok=1
assert_case "${CASE_NUM}" "guard on a fresh clone is silent and exits 0" "${guard_fresh_ok}"

# 25. guard warns when HEAD is older than the configured threshold (default 7 days).
CASE_NUM=$((CASE_NUM + 1))
# Note the trailing "+0000": date -u prints a naive local-looking string with
# no timezone marker, but git interprets a GIT_AUTHOR_DATE/GIT_COMMITTER_DATE
# string with no explicit offset as LOCAL time, not UTC -- without "+0000"
# this silently shifts the commit's real instant by the host's UTC offset.
old_date="$(date -u -d '10 days ago' '+%Y-%m-%d %H:%M:%S +0000' 2>/dev/null || date -u -v-10d '+%Y-%m-%d %H:%M:%S +0000' 2>/dev/null)"
if [ -n "${old_date}" ]; then
  new_backdated_origin_and_clone "guard-stale" "${old_date}"
  run_repos guard guard-stale
  report_case "${CASE_NUM}" "guard warns when HEAD exceeds the staleness threshold" 0 "${LAST_EXIT}" "day(s) old" "${LAST_STDERR}"
else
  echo "SKIP: guard staleness case (no portable 'date -d/-v' on this platform)"
fi

# 26. guard warns when behind cached upstream state, without fetching itself.
new_origin_and_clone "guard-behind"
CASE_NUM=$((CASE_NUM + 1))
advance_origin "guard-behind" 4
git -C "$(clone_dir_for guard-behind)" fetch --quiet origin >/dev/null 2>&1
run_repos guard guard-behind
report_case "${CASE_NUM}" "guard warns when behind its upstream's cached state" 0 "${LAST_EXIT}" "commit(s) behind" "${LAST_STDERR}"

# 27. guard on a missing clone is silent (feature-detection contract).
CASE_NUM=$((CASE_NUM + 1))
run_repos guard does-not-exist
guard_missing_ok=""
[ "${LAST_EXIT}" -eq 0 ] && [ -z "${LAST_STDOUT}" ] && [ -z "${LAST_STDERR}" ] && guard_missing_ok=1
assert_case "${CASE_NUM}" "guard on a missing clone silently exits 0" "${guard_missing_ok}"

# 28. guard's threshold is overridable via skill-local config: a 1-day-old
# commit doesn't trip the default 7-day threshold (case 24 already covers
# that, via a same-day clone) but does trip an overridden staleness_days: 0.
one_day_ago="$(date -u -d '1 day ago' '+%Y-%m-%d %H:%M:%S +0000' 2>/dev/null || date -u -v-1d '+%Y-%m-%d %H:%M:%S +0000' 2>/dev/null)"
if command -v jq >/dev/null 2>&1 && [ -n "${one_day_ago}" ]; then
  new_backdated_origin_and_clone "guard-config" "${one_day_ago}"
  CASE_NUM=$((CASE_NUM + 1))
  printf '{"staleness_days": 0}\n' > "${FAKE_SKILL_DIR}/config/repos.json"
  run_repos guard guard-config
  report_case "${CASE_NUM}" "guard honors a lower staleness_days from skill-local config" 0 "${LAST_EXIT}" "day(s) old" "${LAST_STDERR}"
  # Restore the real config for any later case.
  cp "${SCRIPT_DIR}/config/repos.json" "${FAKE_SKILL_DIR}/config/repos.json"
fi

# ---------------------------------------------------------------------------
# Cases: usage / dispatch
# ---------------------------------------------------------------------------

# 29. unknown subcommand is a usage error (exit 2).
CASE_NUM=$((CASE_NUM + 1))
run_repos bogus-command
report_case "${CASE_NUM}" "unknown subcommand is a usage error (exit 2)" 2 "${LAST_EXIT}" "unknown command" "${LAST_STDERR}"

# 30. -h/--help exits 0 with usage text.
CASE_NUM=$((CASE_NUM + 1))
run_repos --help
report_case "${CASE_NUM}" "--help exits 0 with usage text" 0 "${LAST_EXIT}" "Usage:" "${LAST_STDOUT}"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "Cases run: ${CASE_NUM}  Passed: ${PASSED}  Failed: ${FAILED}"
if [ "${FAILED}" -eq 0 ]; then
  echo "STATUS: PASS"
  exit 0
fi

echo "STATUS: FAIL"
exit 1
