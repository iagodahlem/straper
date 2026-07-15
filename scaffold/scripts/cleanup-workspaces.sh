#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$ROOT_DIR/workspaces"
REPOS_DIR="$ROOT_DIR/repos"

extract_repo_name() {
  local worktree_name="$1"

  if [[ "$worktree_name" == *"--"* ]]; then
    echo "${worktree_name%%--*}"
    return
  fi

  # Backward-compatible fallback for legacy names.
  echo "${worktree_name%%-*}"
}

if [ ! -d "$WORKSPACE_DIR" ]; then
  echo "No workspaces directory found."
  exit 0
fi

if [ -z "$(ls -A "$WORKSPACE_DIR" 2>/dev/null)" ]; then
  echo "No worktrees found in workspaces/."
  exit 0
fi

echo "Scanning worktrees in $WORKSPACE_DIR..."
echo ""

stale=()
active=()

for wt in "$WORKSPACE_DIR"/*/; do
  [ -d "$wt" ] || continue
  name=$(basename "$wt")
  repo_name="$(extract_repo_name "$name")"
  branch=$(git -C "$wt" branch --show-current 2>/dev/null || echo "unknown")
  last_commit=$(git -C "$wt" log --oneline -1 2>/dev/null || echo "no commits")
  last_date=$(git -C "$wt" log -1 --format="%cr" 2>/dev/null || echo "unknown")

  # Check if branch has been merged to main/master in the source repo
  repo_path="$REPOS_DIR/$repo_name"
  merged="no"
  main_branch="main"
  if [ -d "$repo_path" ]; then
    git -C "$repo_path" fetch origin --quiet 2>/dev/null || true
    resolved_main_branch="$(git -C "$repo_path" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || true)"
    if [ -n "$resolved_main_branch" ]; then
      main_branch="$resolved_main_branch"
    fi

    if [ "$branch" != "unknown" ]; then
      if git -C "$repo_path" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
        if git -C "$repo_path" merge-base --is-ancestor "origin/$branch" "origin/$main_branch" 2>/dev/null; then
          merged="yes"
        fi
      else
        wt_head="$(git -C "$wt" rev-parse HEAD 2>/dev/null || true)"
        if [ -n "$wt_head" ] && git -C "$repo_path" merge-base --is-ancestor "$wt_head" "origin/$main_branch" 2>/dev/null; then
          merged="yes"
        fi
      fi
    fi
  fi

  if [ "$merged" = "yes" ]; then
    stale+=("$name")
    echo "  STALE  $name"
    echo "         branch: $branch (merged to $main_branch)"
    echo "         last commit: $last_commit ($last_date)"
  else
    active+=("$name")
    echo "  ACTIVE $name"
    echo "         branch: $branch"
    echo "         last commit: $last_commit ($last_date)"
  fi
  echo ""
done

echo "---"
echo "Active: ${#active[@]}  |  Stale: ${#stale[@]}"
echo ""

if [ ${#stale[@]} -eq 0 ]; then
  echo "Nothing to clean up."
  exit 0
fi

if [ "${1:-}" = "--dry-run" ]; then
  echo "Dry run -- would remove: ${stale[*]}"
  exit 0
fi

if [ "${1:-}" != "--force" ]; then
  echo "Remove ${#stale[@]} stale worktree(s)? (y/n)"
  read -r confirm
  if [ "$confirm" != "y" ]; then
    echo "Aborted."
    exit 0
  fi
fi

for name in "${stale[@]}"; do
  repo_name="$(extract_repo_name "$name")"
  repo_path="$REPOS_DIR/$repo_name"
  wt_path="$WORKSPACE_DIR/$name"
  echo "Removing $name..."
  if ! git -C "$repo_path" worktree remove "$wt_path" 2>/dev/null; then
    echo "Failed to remove $name with git worktree remove. Skipping."
    continue
  fi
  git -C "$repo_path" worktree prune 2>/dev/null || true
done

echo "Done. Cleaned ${#stale[@]} worktree(s)."
