#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

AGENT_NAME=$(jq -r '.agent_name // "agent"' "$ROOT_DIR/preferences.json" 2>/dev/null || echo "agent")
AGENT_DISPLAY_NAME="$(echo "${AGENT_NAME:0:1}" | tr '[:lower:]' '[:upper:]')${AGENT_NAME:1}"

if date -v-1d +%F >/dev/null 2>&1; then
  YESTERDAY="$(date -v-1d +%F)"
else
  YESTERDAY="$(date -d "yesterday" +%F)"
fi
TODAY="$(date +%F)"

echo "== $AGENT_DISPLAY_NAME Boot ($TODAY) =="
echo

# Phase 0: Dependency check
echo "[0/6] Checking dependencies"
missing=()
for cmd in jq node git gh; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing+=("$cmd")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing required tools: ${missing[*]}"
  echo "Install them before running $AGENT_DISPLAY_NAME."
  exit 1
fi
echo "All dependencies found: jq, node, git, gh"

echo
echo "[1/6] Validating skills"
SKILLS_LIB="$ROOT_DIR/scripts/lib/skills.sh"
if [[ -f "$SKILLS_LIB" ]]; then
  skill_count=0
  skill_count="$(bash -c "source '$SKILLS_LIB' && skills_list" 2>/dev/null | wc -l | tr -d ' ')" || skill_count=0
  if bash -c "source '$SKILLS_LIB' && skills_validate" 2>/dev/null; then
    echo "Validated ${skill_count} skill(s): OK"
  else
    echo "Warning: some skills have validation issues (non-blocking)"
    bash -c "source '$SKILLS_LIB' && skills_validate" 2>/dev/null || true
  fi
else
  echo "Skills library not found — skipping skill validation"
fi

echo
echo "[2/6] Validating task files"
./scripts/validate-tasks.sh

echo
echo "[3/6] Loading memory context"
if [ -f "MEMORY.md" ]; then
  echo "- Loaded MEMORY.md"
else
  echo "- Missing MEMORY.md"
fi

for day in "$TODAY" "$YESTERDAY"; do
  file="memory/${day}.md"
  if [ -f "$file" ]; then
    echo "- Loaded $file"
  fi
done

# Create daily log from template if missing
today_memory="memory/${TODAY}.md"
if [ ! -f "$today_memory" ]; then
  cat > "$today_memory" <<TEMPLATE
# ${TODAY}

## Session Notes
-

## Decisions
-

## Blockers
-
TEMPLATE
  echo "- Created $today_memory (template)"
fi

echo
echo "[4/6] Active tasks"
active_count=0
blocked_count=0

for file in tasks/TASK-*.json; do
  [ -f "$file" ] || continue

  status="$(jq -r '.status' "$file")"
  if [ "$status" = "done" ]; then
    continue
  fi

  active_count=$((active_count + 1))
  id="$(jq -r '.id' "$file")"
  title="$(jq -r '.title' "$file")"
  blockers="$(jq -r '.blockers | length' "$file")"
  prs_open="$(jq -r '[.prs[]? | select(.status == "open" or .status == "approved" or .status == "changes_requested")] | length' "$file")"

  if [ "$blockers" -gt 0 ]; then
    blocked_count=$((blocked_count + 1))
  fi

  echo "- ${id} [${status}] -- ${title} (open PRs: ${prs_open}, blockers: ${blockers})"
done

if [ "$active_count" -eq 0 ]; then
  echo "- No active tasks"
fi

echo
echo "[5/6] Syncing PR statuses"
./scripts/sync-pr-status.sh || echo "PR sync skipped."

echo
echo "[6/6] Workspace health"
cleanup_output="$(./scripts/cleanup-workspaces.sh --dry-run || true)"
echo "$cleanup_output"

# Parse stale count from cleanup output
stale_count=0
if echo "$cleanup_output" | grep -q "Stale:"; then
  stale_count="$(echo "$cleanup_output" | grep -oE 'Stale: [0-9]+' | grep -oE '[0-9]+' | tail -n 1)"
fi
stale_count="${stale_count:-0}"

echo
echo "Summary"
echo "- Active tasks: $active_count"
echo "- Tasks with blockers: $blocked_count"
echo "- Stale worktrees: $stale_count"

echo "- Suggested next steps:"
if [ "$blocked_count" -gt 0 ]; then
  echo "  1) Review blockers and update task status/logs"
fi
if [ "$stale_count" -gt 0 ]; then
  echo "  2) Run ./scripts/cleanup-workspaces.sh to remove stale worktrees"
fi
if [ "$active_count" -eq 0 ]; then
  echo "  1) Create a new task JSON in tasks/ before coding"
fi

echo "  3) Use ./scripts/task for task updates during the session"
