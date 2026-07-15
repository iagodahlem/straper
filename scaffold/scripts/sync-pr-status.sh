#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

GH_ORG=$(jq -r '.github.org // ""' "$ROOT_DIR/preferences.json" 2>/dev/null || echo "")

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found. Skipping PR sync."
  exit 0
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh not authenticated. Skipping PR sync."
  exit 0
fi

updated=0

for file in tasks/TASK-*.json; do
  [ -f "$file" ] || continue

  id="$(jq -r '.id' "$file")"
  status="$(jq -r '.status' "$file")"

  # Skip done tasks
  if [ "$status" = "done" ]; then
    continue
  fi

  pr_count="$(jq -r '.prs | length' "$file")"
  if [ "$pr_count" -eq 0 ]; then
    continue
  fi

  for i in $(seq 0 $((pr_count - 1))); do
    repo="$(jq -r ".prs[$i].repo" "$file")"
    number="$(jq -r ".prs[$i].number" "$file")"
    current_status="$(jq -r ".prs[$i].status" "$file")"

    if [ "$number" = "null" ] || [ -z "$number" ]; then
      continue
    fi

    # Skip already-terminal states
    if [ "$current_status" = "merged" ] || [ "$current_status" = "closed" ]; then
      continue
    fi

    # Construct repo path: use org prefix if configured
    if [ -n "$GH_ORG" ]; then
      gh_repo="${GH_ORG}/${repo}"
    else
      gh_repo="$repo"
    fi

    # Query GitHub
    gh_state="$(gh pr view "$number" --repo "$gh_repo" --json state,reviewDecision --jq '.state + "|" + (.reviewDecision // "")' 2>/dev/null || echo "ERROR")"

    if [ "$gh_state" = "ERROR" ]; then
      continue
    fi

    state="$(echo "$gh_state" | cut -d'|' -f1)"
    review="$(echo "$gh_state" | cut -d'|' -f2)"

    new_status="$current_status"
    case "$state" in
      MERGED) new_status="merged" ;;
      CLOSED) new_status="closed" ;;
      OPEN)
        case "$review" in
          APPROVED) new_status="approved" ;;
          CHANGES_REQUESTED) new_status="changes_requested" ;;
          *) new_status="open" ;;
        esac
        ;;
    esac

    if [ "$new_status" != "$current_status" ]; then
      jq --arg idx "$i" --arg status "$new_status" \
        '.prs[($idx | tonumber)].status = $status | .updated_at = (now | todate)' \
        "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
      echo "  ${id}: PR #${number} (${repo}) ${current_status} -> ${new_status}"
      updated=$((updated + 1))
    fi
  done
done

if [ "$updated" -eq 0 ]; then
  echo "All PR statuses up to date."
else
  echo "Updated $updated PR status(es)."
fi
