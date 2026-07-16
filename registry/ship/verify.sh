#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKSPACE_DIR="$ROOT_DIR/workspaces"

usage() {
  cat <<'USAGE'
Usage: verify.sh <worktree-name> [--tier 1|2] [--quick]

Runs verification checks on a worktree. Detects repo type and delegates
to the appropriate verifier (verify-<repo>.sh alongside this script).

Options:
  --tier 1|2   Verification tier (default: 2)
                 1 = typecheck + lint
                 2 = + unit tests scoped to changes
  --quick      Run lint only on changed files (skips full lint)

Examples:
  ./verify.sh myrepo--user--my-feature
  ./verify.sh myrepo--user--fix-something --tier 1
  ./verify.sh myrepo--user--my-feature --quick
USAGE
  exit 1
}

# Parse args
WORKTREE_NAME=""
TIER=2
QUICK=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier)
      TIER="${2:?--tier requires a value (1 or 2)}"
      shift 2
      ;;
    --quick)
      QUICK=true
      shift
      ;;
    --help|-h)
      usage
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      ;;
    *)
      if [ -z "$WORKTREE_NAME" ]; then
        WORKTREE_NAME="$1"
      else
        echo "Unexpected argument: $1" >&2
        usage
      fi
      shift
      ;;
  esac
done

if [ -z "$WORKTREE_NAME" ]; then
  echo "ERROR: worktree name is required" >&2
  usage
fi

WORKTREE_PATH="${WORKSPACE_DIR}/${WORKTREE_NAME}"
if [ ! -d "$WORKTREE_PATH" ]; then
  echo "ERROR: worktree not found: ${WORKTREE_PATH}" >&2
  exit 1
fi

# Extract repo name (everything before first --)
extract_repo_name() {
  local name="$1"
  if [[ "$name" == *"--"* ]]; then
    echo "${name%%--*}"
  else
    echo "${name%%-*}"
  fi
}

REPO_NAME="$(extract_repo_name "$WORKTREE_NAME")"

# Node PATH setup for node-based verifiers — module-local copy preferred,
# workspace lib as fallback. Sourcing only mutates PATH, so it survives the
# exec below and is harmless for non-node repos.
if [ -f "${SCRIPT_DIR}/lib/node-env.sh" ]; then
  source "${SCRIPT_DIR}/lib/node-env.sh"
elif [ -f "${ROOT_DIR}/scripts/lib/node-env.sh" ]; then
  source "${ROOT_DIR}/scripts/lib/node-env.sh"
fi

echo "=== VERIFY: ${WORKTREE_NAME} ==="
echo ""

# Dynamically discover the verifier script for the repo (verify-<repo>.sh).
VERIFIER="${SCRIPT_DIR}/verify-${REPO_NAME}.sh"

if [ -f "$VERIFIER" ] && [ -x "$VERIFIER" ]; then
  exec "$VERIFIER" "$WORKTREE_PATH" --tier "$TIER" $(${QUICK} && echo "--quick")
else
  echo "ERROR: No verifier found for repo '${REPO_NAME}'." >&2
  echo "Create verify-${REPO_NAME}.sh alongside this script to add support." >&2
  exit 1
fi
