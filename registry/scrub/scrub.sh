#!/usr/bin/env bash
# skills/scrub/scrub.sh — deterministic banned-token gate for EXTERNAL surfaces.
#
# Usage (files):   scrub.sh [--strict] [--quiet] [--profile <name>] <file> [file ...]
# Usage (stdin):   <producer> | scrub.sh [--strict] [--quiet] [--profile <name>]
#
# Two profiles:
#
#   (default, no --profile) — "internal-jargon" profile. Checks text for the
#     internal-workspace references that TOOLS.md ("Public vs internal
#     surfaces") bans from anything public — PR titles/bodies, commit
#     messages, Slack drafts, docs. This replaces the manual "grep for FD-/
#     TASK-/Malvin/..." step with a deterministic, scriptable check any skill
#     or gate can shell out to.
#
#   --profile publish — the privacy gate for exporting workspace modules
#     (skills, scripts, docs) to the public straper registry. A stricter bar
#     than "post a PR to the team": catches your personal identity,
#     your org's internal systems/people, personal-workflow assumptions, and
#     credential-shaped strings. Personal pattern classes load from a config
#     file (default: config/publish-gate.conf at the workspace root — the
#     private overlay, never exported with this skill); a small set of
#     universal, non-personal credential-shape checks is hardcoded below and
#     always active. See scrub.md ("Publish profile") for the full class
#     list, config format, and rationale.
#
# Token classes (internal-jargon profile, case-sensitive unless noted):
#   fd-ref          FD-<digits>                         e.g. FD-020
#   task-ref        TASK-<digits>                        e.g. TASK-114
#   subitem-ref?    bare A/F/T/R + a single digit         e.g. A1, F2, R1, T1
#                   ALWAYS advisory (the "?" suffix is permanent, not just a
#                   warning label) — plain single-letter+digit tokens collide
#                   with real prose ("F1", "A1 sauce", "T1 line") too often to
#                   hard-fail by default. See --strict below.
#   assistant-name  the word "Malvin" (case-insensitive substring match — no
#                   word-boundary requirement, matching the workspace policy
#                   literally)
#   workspace-path  workspaces/, plans/, designs/, agents/, tasks/,
#                   ~/Developer/malvin, Developer/malvin (not preceded by a
#                   letter, so "myworkspaces/" is not flagged)
#
# Token classes (--profile publish, tiered FAIL/WARN — see scrub.md):
#   identity            your personal identity (name, email, machine paths)
#   org-internal        your org's internal systems, people, domains, tickets
#   personal-workflow    your timezone/tooling assumptions (timezone literals, single-channel, ...)
#   branding             your agent/workspace branding (env vars, bundle ids, bin name)
#   credentials-shape    credential-shaped strings (tokens, keys, entropy backstop)
# The first four load from the config file; credentials-shape is always
# active (hardcoded below) since it's not personal — safe to ship baked in.
#
# Output: one line per hit, in file/line order —
#   internal-jargon:  <source>:<line>: <token-class>: <matched text (trimmed)>
#   publish:          <source>:<line>: [<FAIL|WARN>] <class>: <matched text (trimmed)>
# "matched text" is the full source line with leading/trailing whitespace
# trimmed (not just the matched token) — useful context for a human or agent
# deciding whether a hit is a real leak. A line that trips more than one class
# (e.g. "tasks/TASK-001.json" is both workspace-path and task-ref) prints one
# row per class, not one row per raw regex occurrence — so "FD-020, FD-021" on
# one line is a single fd-ref row for that line, not two. Under --profile
# publish this is extended to "one row per class+tier" (tier is now a first-
# class dimension the internal-jargon profile doesn't have).
#
# Exit codes:
#   0 — clean (no hard hits; with --strict, no subitem-ref?/WARN hits either)
#   1 — hits found
#   2 — usage error (bad flag, missing/unreadable file, unknown --profile)
#
# Flags:
#   --strict   subitem-ref? (internal-jargon) or WARN-tier (publish) hits also
#              fail the exit code (default: advisory — still printed, but
#              exit stays 0 if that's the only thing hit)
#   --quiet    suppress per-hit stdout lines; exit code only (usage errors,
#              and the publish profile's "no config found" notice, are always
#              on stderr and never suppressed)
#   --profile <name>  "publish" is the only supported value today. Omit for
#              the default internal-jargon profile.
#
# Dependency-free: bash + grep/awk/sed builtins, plus the standard `base64`
# utility (needed only for the publish profile's key decode-check) — no
# third-party tools.
# Self-contained: no hardcoded machine/user paths — the workspace-path check
# matches the *string* "~/Developer/malvin", it does not read $HOME or any
# path on disk. The publish profile resolves its config path relative to this
# script's own location (never a hardcoded path) and honors the
# SCRUB_PUBLISH_PROFILE env var as an override.
#
# Bash-3.2 note (macOS ships 3.2 by default): this script deliberately avoids
# `"${arr[@]}"` on a possibly-empty array under `set -u`, which throws
# "unbound variable" on bash < 4.4. Every array expansion here is guarded by
# an `${#arr[@]} -gt 0` check first.
set -u

SCRIPT_NAME="scrub.sh"

# Workspace root, resolved relative to this script's own location — never a
# hardcoded absolute home path. Only consumed by the --profile publish branch
# (to find config/publish-gate.conf), but harmless to compute unconditionally:
# no side effects, and the default profile never reads it.
SCRUB_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat <<USAGE_EOF
Usage: ${SCRIPT_NAME} [--strict] [--quiet] [--profile <name>] [file ...]

Scans file arguments (or stdin, when no files are given) for tokens that
must never appear in external surfaces. See skills/scrub/scrub.md.

Profiles:
  (default)          internal-jargon — FD-XXX/TASK-XXX/sub-item refs,
                     the agent name, workspace paths. Same as omitting --profile.
  --profile publish  privacy gate for exporting workspace modules to the
                     public straper registry — identity, org-internal,
                     personal-workflow, branding, and credential-shape
                     checks. Personal classes load from
                     config/publish-gate.conf (or the SCRUB_PUBLISH_PROFILE env var);
                     credential-shape checks are always active, even with
                     no config file loaded.

Token classes (default profile):
  fd-ref          FD-<digits>
  task-ref        TASK-<digits>
  subitem-ref?    bare A/F/T/R + single digit (advisory -- see --strict)
  assistant-name  the word "Malvin" (case-insensitive)
  workspace-path  workspaces/, plans/, designs/, agents/, tasks/,
                  ~/Developer/malvin, Developer/malvin

Token classes (--profile publish): identity, clerk-internal,
  personal-workflow, branding, credentials-shape -- tiered FAIL/WARN, see
  scrub.md ("Publish profile").

Options:
  --strict   subitem-ref? / WARN-tier hits also fail the exit code (default: advisory-only)
  --quiet    suppress per-hit output; exit code only
  --profile <name>  select a profile (currently: publish); omit for default
  -h, --help show this help

Exit codes: 0 clean, 1 hits found, 2 usage error
USAGE_EOF
}

STRICT=0
QUIET=0
PROFILE=""
FILES=()

while [ $# -gt 0 ]; do
  case "$1" in
    --strict)
      STRICT=1
      shift
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    --profile)
      if [ $# -lt 2 ]; then
        echo "${SCRIPT_NAME}: --profile requires a value" >&2
        usage >&2
        exit 2
      fi
      PROFILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "${SCRIPT_NAME}: unknown option: ${1}" >&2
      usage >&2
      exit 2
      ;;
    *)
      FILES+=("$1")
      shift
      ;;
  esac
done

if [ -n "$PROFILE" ] && [ "$PROFILE" != "publish" ]; then
  echo "${SCRIPT_NAME}: unknown profile: ${PROFILE} (supported: publish)" >&2
  usage >&2
  exit 2
fi

# Validate file arguments up front (fail closed on a bad invocation) before
# scanning anything.
if [ "${#FILES[@]}" -gt 0 ]; then
  for f in "${FILES[@]}"; do
    if [ ! -e "$f" ]; then
      echo "${SCRIPT_NAME}: no such file: ${f}" >&2
      exit 2
    fi
    if [ ! -f "$f" ] || [ ! -r "$f" ]; then
      echo "${SCRIPT_NAME}: not a readable file: ${f}" >&2
      exit 2
    fi
  done
fi

TMP_DIR="$(mktemp -d -t scrub.XXXXXX)"
trap 'rm -rf "${TMP_DIR}"' EXIT

HITS_RAW="${TMP_DIR}/hits.raw"
: > "$HITS_RAW"

# Unit-separator byte used as the internal field delimiter between source,
# line number, token-class, and trimmed text. Chosen because it cannot
# plausibly appear in real source text, so downstream splitting on it (via
# `-F`/`cut -d`) is unambiguous even though the trimmed-text field can itself
# contain colons, spaces, or anything else the source line contained.
US="$(printf '\1')"

# Single awk pass over one or more real files, OR a single buffered-stdin
# tempfile with FORCE_SRC overriding the printed source label to "stdin".
# Emits one US-delimited row per hit: source, line number, token-class,
# trimmed text. Boundary checks use plain [^A-Za-z0-9_] character classes
# rather than \b — \b is a GNU/PCRE regex extension, not POSIX ERE, so this
# stays portable across awk implementations.
run_scan() {
  force_src="$1"
  shift
  awk -v FORCE_SRC="$force_src" -v US="$US" '
    {
      src = (FORCE_SRC != "") ? FORCE_SRC : FILENAME
      line = $0
      trimmed = line
      gsub(/^[ \t]+/, "", trimmed)
      gsub(/[ \t]+$/, "", trimmed)

      if (line ~ /(^|[^A-Za-z0-9_])FD-[0-9]+([^A-Za-z0-9_]|$)/)
        print src US FNR US "fd-ref" US trimmed
      if (line ~ /(^|[^A-Za-z0-9_])TASK-[0-9]+([^A-Za-z0-9_]|$)/)
        print src US FNR US "task-ref" US trimmed
      if (line ~ /(^|[^A-Za-z0-9_])[AFTR][0-9]([^A-Za-z0-9_]|$)/)
        print src US FNR US "subitem-ref?" US trimmed
      if (tolower(line) ~ /malvin/)
        print src US FNR US "assistant-name" US trimmed
      if (line ~ /(^|[^A-Za-z])(workspaces\/|plans\/|designs\/|agents\/|tasks\/|~\/Developer\/malvin|Developer\/malvin)/)
        print src US FNR US "workspace-path" US trimmed
    }
  ' "$@"
}

# ---------------------------------------------------------------------------
# --profile publish helpers
# ---------------------------------------------------------------------------

# _scrub_b64_decode <payload> — decode a base64 string, trying the GNU-style
# `-d` flag first and falling back to the BSD-style `-D` flag some base64
# builds only accept. Prints the decoded bytes on stdout; returns non-zero
# and prints nothing if decoding fails on both.
_scrub_b64_decode() {
  local payload="$1"
  local decoded
  decoded="$(printf '%s' "$payload" | base64 -d 2>/dev/null)"
  if [ -z "$decoded" ]; then
    decoded="$(printf '%s' "$payload" | base64 -D 2>/dev/null)"
  fi
  [ -n "$decoded" ] || return 1
  printf '%s' "$decoded"
  return 0
}

# _scrub_is_placeholder_key <payload> — true if the base64 payload of a
# pk_/sk_(live|test)_ key decodes to a known-safe placeholder domain (a
# generic *.example host, or a shared accounts.dev dev/test instance), so
# example keys already published in docs don't fire. Decode failure is NOT a
# placeholder — fail closed, so an unreadable payload is still a hit.
_scrub_is_placeholder_key() {
  local payload="$1"
  local decoded
  decoded="$(_scrub_b64_decode "$payload")" || return 1
  printf '%s' "$decoded" | grep -Eq '\.example([^A-Za-z0-9]|$)|accounts\.dev'
}

# scan_credential_keys <force_src> <file> [file ...] — bash-level pass for
# the (pk|sk)_(live|test)_ decode-check: extracting candidate keys and
# base64-decoding them can't be expressed as a single regex, so this runs as
# a separate pass from run_scan_publish's awk scan. Appends US-delimited rows
# (source, line, class, tier, trimmed text) to $HITS_RAW for every match that
# is NOT a recognized placeholder.
scan_credential_keys() {
  local force_src="$1"
  shift
  local f src match lineno payload text
  for f in "$@"; do
    src="$force_src"
    [ -z "$src" ] && src="$f"
    while IFS=: read -r lineno match; do
      [ -z "${lineno:-}" ] && continue
      case "$match" in
        pk_test_*|pk_live_*|sk_test_*|sk_live_*) ;;
        *) continue ;;
      esac
      payload="${match#*_*_}"
      if _scrub_is_placeholder_key "$payload"; then
        continue
      fi
      # Single awk call for both the line-lookup and the trim: sed bracket
      # expressions treat \ as a literal character (not an escape), so
      # `sed 's/^[ \t]*//'` strips space/backslash/"t" instead of tabs --
      # awk's ERE dialect does treat \t as an actual tab, matching the
      # trimming convention run_scan()/run_scan_publish() already use.
      text="$(awk -v n="$lineno" 'NR==n { line=$0; gsub(/^[ \t]+/, "", line); gsub(/[ \t]+$/, "", line); print line; exit }' "$f")"
      printf '%s%s%s%s%s%s%s%s%s\n' \
        "$src" "$US" "$lineno" "$US" "credentials-shape" "$US" "FAIL" "$US" "$text" \
        >> "$HITS_RAW"
    done < <(grep -noE '(pk|sk)_(live|test)_[A-Za-z0-9+/=_-]+' "$f" 2>/dev/null)
  done
}

# run_scan_publish <force_src> <config_patterns_file> <file ...> — one awk
# pass emitting US-delimited rows (source, line, class, tier, trimmed text)
# for: the hardcoded universal credentials-shape checks (always active,
# non-personal — safe to ship baked into the exported skill), plus whatever
# tier|class|regex rows are in config_patterns_file (empty file if no
# personal config is loaded — see the --profile publish branch below). Same
# boundary-check style as run_scan() above ([^A-Za-z0-9_] instead of \b — \b
# is not POSIX ERE, so this stays portable across awk implementations).
run_scan_publish() {
  local force_src="$1"
  shift
  local patterns_file="$1"
  shift
  awk -v FORCE_SRC="$force_src" -v US="$US" -v PATTERNS_FILE="$patterns_file" '
    BEGIN {
      ncfg = 0
      while ((getline pline < PATTERNS_FILE) > 0) {
        if (pline == "") continue
        p1 = index(pline, "|")
        if (p1 == 0) continue
        rest = substr(pline, p1 + 1)
        p2 = index(rest, "|")
        if (p2 == 0) continue
        ncfg++
        cfg_tier[ncfg]  = substr(pline, 1, p1 - 1)
        cfg_class[ncfg] = substr(rest, 1, p2 - 1)
        cfg_rx[ncfg]    = substr(rest, p2 + 1)
      }
      close(PATTERNS_FILE)
    }
    {
      src = (FORCE_SRC != "") ? FORCE_SRC : FILENAME
      line = $0
      trimmed = line
      gsub(/^[ \t]+/, "", trimmed)
      gsub(/[ \t]+$/, "", trimmed)
      ll = tolower(line)

      # Universal credentials-shape checks — hardcoded (not personal),
      # always active regardless of whether a personal config is loaded.
      if (line ~ /(^|[^A-Za-z0-9_])xox[pboa]-[A-Za-z0-9-]{8,}/)
        print src US FNR US "credentials-shape" US "FAIL" US trimmed
      if (line ~ /(^|[^A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{8,}/)
        print src US FNR US "credentials-shape" US "FAIL" US trimmed
      if (line ~ /(^|[^A-Za-z0-9_])sk-proj-[A-Za-z0-9_-]{8,}/)
        print src US FNR US "credentials-shape" US "FAIL" US trimmed
      if (line ~ /(^|[^A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{10,}/)
        print src US FNR US "credentials-shape" US "FAIL" US trimmed
      if (line ~ /(^|[^A-Za-z0-9_])AKIA[0-9A-Z]{16}([^A-Za-z0-9_]|$)/)
        print src US FNR US "credentials-shape" US "FAIL" US trimmed
      if (line ~ /(^|[^0-9])[0-9]{8,10}:[A-Za-z0-9_-]{35}([^A-Za-z0-9_]|$)/)
        print src US FNR US "credentials-shape" US "FAIL" US trimmed
      if (ll ~ /(token|secret|key|password|credential)[[:space:]]*[:=]/ && line ~ /[A-Za-z0-9+\/=_-]{32,}/)
        print src US FNR US "credentials-shape" US "FAIL" US trimmed

      # Personal classes — config-driven (identity, clerk-internal,
      # personal-workflow, branding, plus the credentials-shape WARNs like
      # op:// refs). Empty PATTERNS_FILE (no personal config loaded) means
      # this loop just does nothing.
      for (i = 1; i <= ncfg; i++) {
        if (line ~ cfg_rx[i])
          print src US FNR US cfg_class[i] US cfg_tier[i] US trimmed
      }
    }
  ' "$@"
}

if [ "$PROFILE" = "publish" ]; then
  # -------------------------------------------------------------------------
  # --profile publish: privacy gate for exporting workspace modules to the
  # public straper registry.
  # -------------------------------------------------------------------------
  PUBLISH_CONFIG="${SCRUB_PUBLISH_PROFILE:-${SCRUB_ROOT_DIR}/config/publish-gate.conf}"
  CFG_PATTERNS="${TMP_DIR}/publish-patterns.txt"
  : > "$CFG_PATTERNS"

  if [ -f "$PUBLISH_CONFIG" ] && [ -r "$PUBLISH_CONFIG" ]; then
    grep -E '^(FAIL|WARN)\|' "$PUBLISH_CONFIG" > "$CFG_PATTERNS" 2>/dev/null || true
  else
    echo "${SCRIPT_NAME}: no personal publish profile loaded (config not found: ${PUBLISH_CONFIG}) — running universal credentials-shape checks only" >&2
  fi

  if [ "${#FILES[@]}" -gt 0 ]; then
    run_scan_publish "" "$CFG_PATTERNS" "${FILES[@]}" >> "$HITS_RAW"
    scan_credential_keys "" "${FILES[@]}"
  else
    STDIN_BUF="${TMP_DIR}/stdin.buf"
    cat > "$STDIN_BUF"
    run_scan_publish "stdin" "$CFG_PATTERNS" "$STDIN_BUF" >> "$HITS_RAW"
    scan_credential_keys "stdin" "$STDIN_BUF"
  fi

  # run_scan_publish and scan_credential_keys are two independent passes, so
  # rows don't arrive in overall file/line order the way a single awk pass
  # would naturally produce it — sort by (source, line) to restore that.
  if [ -s "$HITS_RAW" ]; then
    SORTED_TMP="${TMP_DIR}/hits.sorted"
    LC_ALL=C sort -t "$US" -k1,1 -k2,2n "$HITS_RAW" > "$SORTED_TMP" 2>/dev/null && mv "$SORTED_TMP" "$HITS_RAW"
  fi

  # Collapse exact duplicate rows (same source+line+class+tier+text) so a
  # line tripping the same class+tier via more than one underlying pattern
  # (e.g. two different clerk-internal regexes, or an awk-pass hit and a
  # decode-check hit landing on the same line) prints once — the same
  # "one row per class" convention run_scan()'s doc comment describes,
  # extended here to "one row per class+tier" since tier is now a
  # first-class dimension the internal-jargon profile doesn't have.
  if [ -s "$HITS_RAW" ]; then
    DEDUP_TMP="${TMP_DIR}/hits.dedup"
    awk '!seen[$0]++' "$HITS_RAW" > "$DEDUP_TMP"
    mv "$DEDUP_TMP" "$HITS_RAW"
  fi

  HARD_HITS=0
  ADVISORY_HITS=0
  if [ -s "$HITS_RAW" ]; then
    HARD_HITS="$(awk -F"$US" '$4 == "FAIL" { c++ } END { print c+0 }' "$HITS_RAW")"
    ADVISORY_HITS="$(awk -F"$US" '$4 == "WARN" { c++ } END { print c+0 }' "$HITS_RAW")"
  fi

  if [ "$QUIET" -eq 0 ] && [ -s "$HITS_RAW" ]; then
    awk -F"$US" '{ printf "%s:%s: [%s] %s: %s\n", $1, $2, $4, $3, $5 }' "$HITS_RAW"
  fi

  SHOULD_FAIL=0
  if [ "$HARD_HITS" -gt 0 ]; then
    SHOULD_FAIL=1
  fi
  if [ "$STRICT" -eq 1 ] && [ "$ADVISORY_HITS" -gt 0 ]; then
    SHOULD_FAIL=1
  fi

  if [ "$SHOULD_FAIL" -eq 1 ]; then
    exit 1
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# default profile (internal-jargon)
# ---------------------------------------------------------------------------

if [ "${#FILES[@]}" -gt 0 ]; then
  run_scan "" "${FILES[@]}" >> "$HITS_RAW"
else
  STDIN_BUF="${TMP_DIR}/stdin.buf"
  cat > "$STDIN_BUF"
  run_scan "stdin" "$STDIN_BUF" >> "$HITS_RAW"
fi

HARD_HITS=0
ADVISORY_HITS=0
if [ -s "$HITS_RAW" ]; then
  HARD_HITS="$(awk -F"$US" '$3 != "subitem-ref?" { c++ } END { print c+0 }' "$HITS_RAW")"
  ADVISORY_HITS="$(awk -F"$US" '$3 == "subitem-ref?" { c++ } END { print c+0 }' "$HITS_RAW")"
fi

if [ "$QUIET" -eq 0 ] && [ -s "$HITS_RAW" ]; then
  awk -F"$US" '{ printf "%s:%s: %s: %s\n", $1, $2, $3, $4 }' "$HITS_RAW"
fi

SHOULD_FAIL=0
if [ "$HARD_HITS" -gt 0 ]; then
  SHOULD_FAIL=1
fi
if [ "$STRICT" -eq 1 ] && [ "$ADVISORY_HITS" -gt 0 ]; then
  SHOULD_FAIL=1
fi

if [ "$SHOULD_FAIL" -eq 1 ]; then
  exit 1
fi
exit 0
