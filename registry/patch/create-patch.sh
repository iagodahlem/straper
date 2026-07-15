#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKSPACE_DIR="$ROOT_DIR/workspaces"
PATCHES_DIR="$ROOT_DIR/patches"

usage() {
  cat <<EOF
Usage: $(basename "$0") <worktree-name> [description] [-- <pathspec>...]

Create a patch from unstaged changes in a worktree.

Arguments:
  worktree-name   Name of the worktree in workspaces/ (e.g. myrepo--user--add-feature)
  description     Optional short label for the patch (default: "changes")
  -- <pathspec>   Optional path filter passed to git diff (everything after --)

Output:
  patches/<worktree>--<description>--<timestamp>.patch

Examples:
  $(basename "$0") myrepo--user--add-feature
  $(basename "$0") myrepo--user--add-feature rollback-cursor-stack
  $(basename "$0") myrepo--user--add-feature rollback-cursor-stack -- src/

To apply a patch:
  cd /path/to/your/repo
  git apply /path/to/patches/<patch-file>.patch
EOF
  exit 1
}

if [ $# -lt 1 ]; then
  usage
fi

worktree_name="$1"
shift

# Parse optional description and pathspec
description="changes"
pathspecs=()

while [ $# -gt 0 ]; do
  case "$1" in
    --)
      shift
      pathspecs=("$@")
      break
      ;;
    -h|--help)
      usage
      ;;
    *)
      description="$1"
      shift
      ;;
  esac
done

worktree_path="${WORKSPACE_DIR}/${worktree_name}"

if [ ! -d "$worktree_path" ]; then
  echo "Error: worktree not found: ${worktree_path}"
  echo ""
  echo "Available worktrees:"
  ls -1 "$WORKSPACE_DIR" 2>/dev/null || echo "  (none)"
  exit 1
fi

mkdir -p "$PATCHES_DIR"

timestamp=$(date +%Y%m%d-%H%M%S)
patch_file="${worktree_name}--${description}--${timestamp}.patch"
patch_path="${PATCHES_DIR}/${patch_file}"

# Build git diff command
diff_args=(diff)
if [ ${#pathspecs[@]} -gt 0 ]; then
  diff_args+=(-- "${pathspecs[@]}")
fi

diff_output=$(cd "$worktree_path" && git "${diff_args[@]}")

if [ -z "$diff_output" ]; then
  echo "No unstaged changes found in ${worktree_name}"
  [ ${#pathspecs[@]} -gt 0 ] && echo "  (filtered by: ${pathspecs[*]})"
  exit 0
fi

echo "$diff_output" > "$patch_path"

lines_added=$(echo "$diff_output" | grep -c '^+[^+]' || true)
lines_removed=$(echo "$diff_output" | grep -c '^-[^-]' || true)
files_changed=$(echo "$diff_output" | grep -c '^diff --git' || true)

# Extract the repo name from the worktree name
repo_name="${worktree_name%%--*}"

echo "Patch created: patches/${patch_file}"
echo "  ${files_changed} file(s), +${lines_added} -${lines_removed}"
echo ""
echo "To apply:"
echo "  cd /path/to/${repo_name}"
echo "  git apply ${PATCHES_DIR}/${patch_file}"
