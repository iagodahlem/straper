#!/usr/bin/env bash
set -euo pipefail

# Auto-commit workspace files (tasks, memory, plans, settings)
# Groups changes into logical commits. Safe to run anytime — no-ops if clean.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

committed=0

# Helper: stage files matching a pattern, commit if any were staged
commit_group() {
  local message="$1"
  shift
  local files=()

  for pattern in "$@"; do
    while IFS= read -r f; do
      [ -n "$f" ] && files+=("$f")
    done < <(git diff --name-only -- "$pattern" 2>/dev/null)
    while IFS= read -r f; do
      [ -n "$f" ] && files+=("$f")
    done < <(git ls-files --others --exclude-standard -- "$pattern" 2>/dev/null)
  done

  if [ ${#files[@]} -eq 0 ]; then
    return
  fi

  git add "${files[@]}"
  git commit -m "$message" --no-verify >/dev/null 2>&1
  echo "  committed: $message (${#files[@]} file(s))"
  committed=$((committed + 1))
}

echo "Auto-committing workspace changes..."

# Group 1: Task files
commit_group "chore: update task tracking" "tasks/"

# Group 2: Memory files
commit_group "chore: update memory" "memory/" "MEMORY.md"

# Group 3: Designs
commit_group "chore: update designs" "designs/"

# Group 4: Plans
commit_group "chore: update plans" "plans/"

# Group 5: Settings / config
commit_group "chore: update workspace config" ".claude/"

# Group 6: Scripts and agent definitions
commit_group "chore: update workspace scripts" "scripts/" "agents/"

# Group 7: Skills
commit_group "chore: update skills" "skills/"

# Group 8: Project hubs
commit_group "chore: update project hubs" "projects/"

# Group 9: Scheduler jobs
commit_group "chore: update scheduler jobs" "jobs/"

# Group 10: Docs
commit_group "chore: update docs" "docs/"

# Group 11: Workspace config (config, completions)
commit_group "chore: update workspace config" "config/" "completions/"

# Group 12: Root workspace files
commit_group "chore: update workspace" "SOUL.md" "USER.md" "TOOLS.md" "BOOT.md" "AGENTS.md" "preferences.json" ".gitignore" ".env.example"

if [ "$committed" -eq 0 ]; then
  echo "  nothing to commit"
fi
