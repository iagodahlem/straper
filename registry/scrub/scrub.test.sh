#!/usr/bin/env bash
set -u
# skills/scrub/scrub.test.sh — self-running bash harness for scrub.sh.
#
# Run via: bash skills/scrub/scrub.test.sh
#
# No test framework — follows the scripts/tests/*.test.sh convention
# (see scripts/tests/repo-scope.test.sh): numbered cases, a report_case
# helper, a final PASS/FAIL summary, and a matching process exit code.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRUB="${ROOT_DIR}/skills/scrub/scrub.sh"

if [ ! -x "${SCRUB}" ]; then
  echo "ERROR: scrub.sh not found or not executable: ${SCRUB}" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d -t scrub-tests.XXXXXX)"
trap 'rm -rf "${TMP_DIR}"' EXIT

PASSED=0
FAILED=0
CASE_NUM=0

# Write text content to a fixture file under TMP_DIR and return its path.
write_fixture() {
  local name="$1"
  local content="$2"
  local file="${TMP_DIR}/${name}"
  printf '%s' "${content}" > "${file}"
  printf '%s' "${file}"
}

LAST_EXIT=0
LAST_STDOUT=""
LAST_STDERR=""

# run_scrub <stdin-file-or-/dev/null> [scrub.sh args...]
# Sets LAST_EXIT, LAST_STDOUT, LAST_STDERR.
run_scrub() {
  local stdin_file="$1"
  shift
  local stdout_file="${TMP_DIR}/stdout.$$"
  local stderr_file="${TMP_DIR}/stderr.$$"

  if "${SCRUB}" "$@" < "${stdin_file}" >"${stdout_file}" 2>"${stderr_file}"; then
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

# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

# 1. Clean text via stdin -> exit 0, no stdout.
CASE_NUM=$((CASE_NUM + 1))
clean_stdin="$(write_fixture clean-stdin.txt 'Fixes the SSO wizard back-nav bug. See PROJ-123.
No internal refs here.
')"
run_scrub "${clean_stdin}"
report_case "${CASE_NUM}" "Clean text via stdin exits 0" 0 "${LAST_EXIT}"

CASE_NUM=$((CASE_NUM + 1))
if [ -z "${LAST_STDOUT}" ]; then
  echo "PASS: ${CASE_NUM}. Clean text via stdin produces no stdout"
  PASSED=$((PASSED + 1))
else
  echo "FAIL: ${CASE_NUM}. Clean text via stdin produces no stdout (got: ${LAST_STDOUT})"
  FAILED=$((FAILED + 1))
fi

# 2. fd-ref detected.
CASE_NUM=$((CASE_NUM + 1))
fd_file="$(write_fixture fd.txt 'Part of FD-020 for context.
')"
run_scrub /dev/null "${fd_file}"
report_case "${CASE_NUM}" "fd-ref detected and fails" 1 "${LAST_EXIT}" "fd-ref" "${LAST_STDOUT}"

# 3. task-ref detected.
CASE_NUM=$((CASE_NUM + 1))
task_file="$(write_fixture task.txt 'Follow-up TASK-114 tracks this.
')"
run_scrub /dev/null "${task_file}"
report_case "${CASE_NUM}" "task-ref detected and fails" 1 "${LAST_EXIT}" "task-ref" "${LAST_STDOUT}"

# 4. subitem-ref? detected, no --strict -> advisory only, exit 0.
CASE_NUM=$((CASE_NUM + 1))
subitem_file="$(write_fixture subitem.txt 'See A1 for the sub-item.
')"
run_scrub /dev/null "${subitem_file}"
report_case "${CASE_NUM}" "subitem-ref? alone is advisory (exit 0, default)" 0 "${LAST_EXIT}" "subitem-ref?" "${LAST_STDOUT}"

# 5. subitem-ref? detected, WITH --strict -> fails.
CASE_NUM=$((CASE_NUM + 1))
run_scrub /dev/null --strict "${subitem_file}"
report_case "${CASE_NUM}" "subitem-ref? fails under --strict" 1 "${LAST_EXIT}" "subitem-ref?" "${LAST_STDOUT}"

# 6. assistant-name, case-insensitive.
CASE_NUM=$((CASE_NUM + 1))
malvin_file="$(write_fixture malvin.txt 'malvin helped draft this (lowercase).
')"
run_scrub /dev/null "${malvin_file}"
report_case "${CASE_NUM}" "assistant-name matches case-insensitively" 1 "${LAST_EXIT}" "assistant-name" "${LAST_STDOUT}"

# 7. workspace-path detected (workspaces/).
CASE_NUM=$((CASE_NUM + 1))
wp_file="$(write_fixture wp.txt 'See workspaces/web--feature for the branch.
')"
run_scrub /dev/null "${wp_file}"
report_case "${CASE_NUM}" "workspace-path detected for workspaces/" 1 "${LAST_EXIT}" "workspace-path" "${LAST_STDOUT}"

# 8. workspace-path detected (~/Developer/malvin) -- also trips assistant-name.
CASE_NUM=$((CASE_NUM + 1))
home_file="$(write_fixture home.txt 'Reference ~/Developer/malvin/scripts too.
')"
run_scrub /dev/null "${home_file}"
report_case "${CASE_NUM}" "workspace-path detected for ~/Developer/malvin" 1 "${LAST_EXIT}" "workspace-path" "${LAST_STDOUT}"

# 9. stdin mode labels the source "stdin".
CASE_NUM=$((CASE_NUM + 1))
run_scrub "${fd_file}"
case "${LAST_STDOUT}" in
  stdin:1:*) label_ok=1 ;;
  *) label_ok=0 ;;
esac
if [ "${label_ok}" -eq 1 ]; then
  echo "PASS: ${CASE_NUM}. stdin mode labels the source 'stdin'"
  PASSED=$((PASSED + 1))
else
  echo "FAIL: ${CASE_NUM}. stdin mode labels the source 'stdin' (got: ${LAST_STDOUT})"
  FAILED=$((FAILED + 1))
fi

# 10. Multi-file mode: the dirty file's hits are reported...
CASE_NUM=$((CASE_NUM + 1))
run_scrub /dev/null "${clean_stdin}" "${fd_file}"
report_case "${CASE_NUM}" "multi-file mode reports the dirty file's basename" 1 "${LAST_EXIT}" "$(basename "${fd_file}")" "${LAST_STDOUT}"

# ...and the clean file contributes no hit rows.
CASE_NUM=$((CASE_NUM + 1))
case "${LAST_STDOUT}" in
  *"$(basename "${clean_stdin}")"*)
    echo "FAIL: ${CASE_NUM}. multi-file mode does not report hits for the clean file"
    FAILED=$((FAILED + 1))
    ;;
  *)
    echo "PASS: ${CASE_NUM}. multi-file mode does not report hits for the clean file"
    PASSED=$((PASSED + 1))
    ;;
esac

# 11. --quiet suppresses stdout on a dirty case but keeps exit 1.
CASE_NUM=$((CASE_NUM + 1))
run_scrub /dev/null --quiet "${fd_file}"
if [ "${LAST_EXIT}" -eq 1 ] && [ -z "${LAST_STDOUT}" ]; then
  echo "PASS: ${CASE_NUM}. --quiet suppresses stdout, keeps exit 1 on hits"
  PASSED=$((PASSED + 1))
else
  echo "FAIL: ${CASE_NUM}. --quiet suppresses stdout, keeps exit 1 on hits (exit=${LAST_EXIT}, stdout=${LAST_STDOUT})"
  FAILED=$((FAILED + 1))
fi

# 12. --quiet on clean input -> exit 0, no stdout.
CASE_NUM=$((CASE_NUM + 1))
run_scrub /dev/null --quiet "${clean_stdin}"
if [ "${LAST_EXIT}" -eq 0 ] && [ -z "${LAST_STDOUT}" ]; then
  echo "PASS: ${CASE_NUM}. --quiet on clean input exits 0 with no stdout"
  PASSED=$((PASSED + 1))
else
  echo "FAIL: ${CASE_NUM}. --quiet on clean input exits 0 with no stdout (exit=${LAST_EXIT}, stdout=${LAST_STDOUT})"
  FAILED=$((FAILED + 1))
fi

# 13. Unknown flag -> usage error, exit 2, with a stderr message.
CASE_NUM=$((CASE_NUM + 1))
run_scrub /dev/null --bogus-flag
report_case "${CASE_NUM}" "Unknown flag is a usage error (exit 2)" 2 "${LAST_EXIT}" "unknown option" "${LAST_STDERR}"

# 14. Missing file -> usage error, exit 2, with a stderr message.
CASE_NUM=$((CASE_NUM + 1))
run_scrub /dev/null "${TMP_DIR}/does-not-exist.txt"
report_case "${CASE_NUM}" "Missing file is a usage error (exit 2)" 2 "${LAST_EXIT}" "no such file" "${LAST_STDERR}"

# 15. Directory passed as a file arg -> usage error, exit 2, with a stderr message.
CASE_NUM=$((CASE_NUM + 1))
mkdir -p "${TMP_DIR}/a-directory"
run_scrub /dev/null "${TMP_DIR}/a-directory"
report_case "${CASE_NUM}" "Directory argument is a usage error (exit 2)" 2 "${LAST_EXIT}" "not a readable file" "${LAST_STDERR}"

# 16. Case sensitivity: lowercase fd-020 / task-045 do not match.
CASE_NUM=$((CASE_NUM + 1))
lower_file="$(write_fixture lower.txt 'fd-020 and task-045 in lowercase should not match.
')"
run_scrub /dev/null "${lower_file}"
report_case "${CASE_NUM}" "Lowercase fd-020/task-045 do not match (case-sensitive)" 0 "${LAST_EXIT}"

# 17. Boundary: FD-020a / TASK-045b (trailing letters) do not match.
CASE_NUM=$((CASE_NUM + 1))
boundary_file="$(write_fixture boundary.txt 'FD-020a and TASK-045b are not clean token boundaries.
')"
run_scrub /dev/null "${boundary_file}"
report_case "${CASE_NUM}" "FD-020a / TASK-045b (no boundary) do not match" 0 "${LAST_EXIT}"

# 18. -h/--help exits 0.
CASE_NUM=$((CASE_NUM + 1))
run_scrub /dev/null --help
report_case "${CASE_NUM}" "--help exits 0" 0 "${LAST_EXIT}" "Usage:" "${LAST_STDOUT}"

# 19. One line tripping two classes emits both (tasks/TASK-001.json).
CASE_NUM=$((CASE_NUM + 1))
two_class_file="$(write_fixture two-class.txt 'tasks/TASK-001.json holds the record.
')"
run_scrub /dev/null "${two_class_file}"
report_case "${CASE_NUM}" "A line tripping two classes reports workspace-path" 1 "${LAST_EXIT}" "workspace-path" "${LAST_STDOUT}"

CASE_NUM=$((CASE_NUM + 1))
report_case "${CASE_NUM}" "A line tripping two classes also reports task-ref" 1 "${LAST_EXIT}" "task-ref" "${LAST_STDOUT}"

# 20. Line number reporting: hit on line 3 of a multi-line file reports ':3:'.
CASE_NUM=$((CASE_NUM + 1))
multiline_file="$(write_fixture multiline.txt 'line one is clean
line two is clean
FD-020 is on line three
line four is clean
')"
run_scrub /dev/null "${multiline_file}"
report_case "${CASE_NUM}" "Hit on line 3 is reported with line number 3" 1 "${LAST_EXIT}" ":3: fd-ref:" "${LAST_STDOUT}"

# ---------------------------------------------------------------------------
# --profile publish cases
# ---------------------------------------------------------------------------
# Fixture config (mktemp, via write_fixture) covering one FAIL-tier class
# (identity) and one WARN-tier class (branding) -- enough to exercise tier
# handling without duplicating the real config/publish-gate.conf.
PUBLISH_FIXTURE_CFG="$(write_fixture publish-fixture.conf 'FAIL|identity|(^|[^A-Za-z0-9_])testidentity([^A-Za-z0-9_]|$)
WARN|branding|TESTBRAND_[A-Z0-9_]*
')"

# 21. FAIL-tier config class fires and fails the exit code.
CASE_NUM=$((CASE_NUM + 1))
fail_tier_file="$(write_fixture publish-fail.txt 'this line has testidentity in it
')"
SCRUB_PUBLISH_PROFILE="${PUBLISH_FIXTURE_CFG}" run_scrub /dev/null --profile publish "${fail_tier_file}"
report_case "${CASE_NUM}" "publish: FAIL-tier config class fires and fails" 1 "${LAST_EXIT}" "[FAIL] identity" "${LAST_STDOUT}"

# 22. WARN-tier config class fires but does NOT fail without --strict.
CASE_NUM=$((CASE_NUM + 1))
warn_tier_file="$(write_fixture publish-warn.txt 'this line has TESTBRAND_FOO in it
')"
SCRUB_PUBLISH_PROFILE="${PUBLISH_FIXTURE_CFG}" run_scrub /dev/null --profile publish "${warn_tier_file}"
report_case "${CASE_NUM}" "publish: WARN-tier config class prints but exits 0 (advisory, no --strict)" 0 "${LAST_EXIT}" "[WARN] branding" "${LAST_STDOUT}"

# 23. Same WARN-tier fixture, but --strict flips the exit code to failing.
CASE_NUM=$((CASE_NUM + 1))
SCRUB_PUBLISH_PROFILE="${PUBLISH_FIXTURE_CFG}" run_scrub /dev/null --profile publish --strict "${warn_tier_file}"
report_case "${CASE_NUM}" "publish: WARN-tier config class fails under --strict" 1 "${LAST_EXIT}" "[WARN] branding" "${LAST_STDOUT}"

# 24. Decode-check: a placeholder pk_test key (payload decodes to a shared
# accounts.dev dev/test instance) passes clean -- no hit at all.
CASE_NUM=$((CASE_NUM + 1))
placeholder_payload="$(printf '%s' 'some-test-app.accounts.dev$' | base64)"
placeholder_key="pk_test_${placeholder_payload}"
placeholder_file="$(write_fixture placeholder-key.txt "the key is ${placeholder_key} here
")"
SCRUB_PUBLISH_PROFILE="${PUBLISH_FIXTURE_CFG}" run_scrub /dev/null --profile publish "${placeholder_file}"
report_case "${CASE_NUM}" "publish: placeholder pk_test key (accounts.dev) decode-check passes clean" 0 "${LAST_EXIT}"

# 25. Decode-check: a non-placeholder sk_live key (payload decodes to a real-
# looking production domain) fails.
CASE_NUM=$((CASE_NUM + 1))
real_payload="$(printf '%s' 'clerk.some-real-production-domain.com$' | base64)"
real_key="sk_live_${real_payload}"
real_key_file="$(write_fixture real-key.txt "the key is ${real_key} here
")"
SCRUB_PUBLISH_PROFILE="${PUBLISH_FIXTURE_CFG}" run_scrub /dev/null --profile publish "${real_key_file}"
report_case "${CASE_NUM}" "publish: non-placeholder sk_live key decode-check fails" 1 "${LAST_EXIT}" "[FAIL] credentials-shape" "${LAST_STDOUT}"

# 26. Entropy backstop: a >=32-char base64 run on a "token:" line fires, even
# with no pk_/sk_ prefix and no config-driven pattern involved.
CASE_NUM=$((CASE_NUM + 1))
entropy_payload="$(printf '%s' 'this-is-a-long-enough-random-looking-value-1234567890' | base64)"
entropy_file="$(write_fixture entropy.txt "token: ${entropy_payload}
")"
SCRUB_PUBLISH_PROFILE="${PUBLISH_FIXTURE_CFG}" run_scrub /dev/null --profile publish "${entropy_file}"
report_case "${CASE_NUM}" "publish: entropy backstop fires on a long token: value" 1 "${LAST_EXIT}" "[FAIL] credentials-shape" "${LAST_STDOUT}"

# 27. Missing config: prints the fallback notice on stderr, still runs the
# universal credentials-shape checks, but does NOT run personal classes.
# The token-shaped fixture is assembled at runtime so a plain file scan of
# this test file stays clean while the gate still fires on the fixture.
CASE_NUM=$((CASE_NUM + 1))
slack_shaped_token="xoxb-1234"
slack_shaped_token="${slack_shaped_token}567890-abcdefghij"
missing_cfg_file="$(write_fixture missing-cfg.txt "this line has testidentity in it and a token ${slack_shaped_token}
")"
SCRUB_PUBLISH_PROFILE="${TMP_DIR}/does-not-exist-publish.conf" run_scrub /dev/null --profile publish "${missing_cfg_file}"
report_case "${CASE_NUM}" "publish: missing config prints a fallback notice on stderr" 1 "${LAST_EXIT}" "no personal publish profile loaded" "${LAST_STDERR}"

CASE_NUM=$((CASE_NUM + 1))
# Check for the bracketed class label specifically -- not bare "identity",
# which is also a substring of "testidentity" in the echoed source text and
# would false-match even when the identity class never fired.
case "${LAST_STDOUT}" in
  *"] identity:"*)
    echo "FAIL: ${CASE_NUM}. publish: missing config does not run personal classes (identity absent)"
    FAILED=$((FAILED + 1))
    ;;
  *)
    echo "PASS: ${CASE_NUM}. publish: missing config does not run personal classes (identity absent)"
    PASSED=$((PASSED + 1))
    ;;
esac

CASE_NUM=$((CASE_NUM + 1))
report_case "${CASE_NUM}" "publish: missing config still runs universal credentials-shape checks" 1 "${LAST_EXIT}" "[FAIL] credentials-shape" "${LAST_STDOUT}"

# 28. Default profile (no --profile) is unaffected by the publish fixture: a
# publish-only token does not fire under the internal-jargon profile.
CASE_NUM=$((CASE_NUM + 1))
default_unaffected_file="$(write_fixture default-unaffected.txt 'this line has testidentity in it, nothing else
')"
SCRUB_PUBLISH_PROFILE="${PUBLISH_FIXTURE_CFG}" run_scrub /dev/null "${default_unaffected_file}"
report_case "${CASE_NUM}" "publish: default profile ignores publish-only fixture classes (no --profile)" 0 "${LAST_EXIT}"

# 29. And conversely: a default-profile-only token (Malvin) does not fire
# under --profile publish.
CASE_NUM=$((CASE_NUM + 1))
publish_ignores_malvin_file="$(write_fixture publish-ignores-malvin.txt 'Malvin drafted this, nothing else
')"
SCRUB_PUBLISH_PROFILE="${PUBLISH_FIXTURE_CFG}" run_scrub /dev/null --profile publish "${publish_ignores_malvin_file}"
report_case "${CASE_NUM}" "publish: --profile publish ignores default-profile-only classes (assistant-name)" 0 "${LAST_EXIT}"

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
