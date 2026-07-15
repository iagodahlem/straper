#!/usr/bin/env bash
# scripts/lib/skills.sh — Core skill framework utilities
#
# Provides discovery, validation, frontmatter parsing, index generation,
# and metrics logging for the skills architecture (FD-005).
#
# Skills are directories under skills/<name>/ containing <name>.md.
# Each skill .md file has YAML frontmatter defining its contract.
#
# Usage: source scripts/lib/skills.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Root directory resolution
# ---------------------------------------------------------------------------

_SKILLS_ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
_SKILLS_DIR="$_SKILLS_ROOT_DIR/skills"
_METRICS_DIR="$_SKILLS_ROOT_DIR/.metrics"
_METRICS_FILE="$_METRICS_DIR/skills.jsonl"

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_skills_error() {
  echo "skills: $*" >&2
}

_skills_ensure_metrics_dir() {
  mkdir -p "$_METRICS_DIR"
}

# ---------------------------------------------------------------------------
# skills_list — Enumerate skills by scanning skills/*/ directories
#
# A directory skills/<name>/ is a skill if it contains <name>.md.
# Excludes SCHEMA.md and INDEX.md at skills/ root.
# Output: one skill name per line, sorted alphabetically
# Exit: 0 always (empty output if no skills found)
# ---------------------------------------------------------------------------
skills_list() {
  if [[ ! -d "$_SKILLS_DIR" ]]; then
    return 0
  fi

  for dir in "$_SKILLS_DIR"/*/; do
    [[ -d "$dir" ]] || continue
    local name
    name="$(basename "$dir")"
    # Skip hidden directories
    [[ "$name" == .* ]] && continue
    # A directory is a skill if it contains <name>.md
    if [[ -f "$dir/${name}.md" ]]; then
      echo "$name"
    fi
  done | sort

  return 0
}

# ---------------------------------------------------------------------------
# skills_resolve_dir — Return absolute path to skills/<name>/
#
# Usage: skills_resolve_dir <name>
# Output: absolute path (or empty if not found)
# Exit: 0 if found, 1 if not
# ---------------------------------------------------------------------------
skills_resolve_dir() {
  local name="$1"
  local dir="$_SKILLS_DIR/$name"
  if [[ -d "$dir" ]]; then
    echo "$dir"
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# skills_read_frontmatter — Parse YAML frontmatter from a skill .md file
#
# Extracts content between --- markers (lines 1..N).
# Output: raw YAML lines (can be piped to grep/awk or yq)
# Exit: 0 if frontmatter found, 1 if not
# ---------------------------------------------------------------------------
skills_read_frontmatter() {
  local file="$1"

  if [[ ! -f "$file" ]]; then
    _skills_error "file not found: $file"
    return 1
  fi

  # Extract YAML between first pair of --- markers using awk
  # The first line must be "---", then capture until the next "---"
  local yaml
  yaml="$(awk '
    NR == 1 && /^---[[:space:]]*$/ { in_fm = 1; next }
    in_fm && /^---[[:space:]]*$/ { exit }
    in_fm { print }
  ' "$file")"

  if [[ -z "$yaml" ]]; then
    return 1
  fi

  echo "$yaml"
  return 0
}

# ---------------------------------------------------------------------------
# skills_get_field — Get a single frontmatter field value
#
# Handles simple scalar values and single-line arrays.
# For multi-line YAML arrays (one item per line with - prefix), collects
# all items and outputs one per line.
#
# Usage: skills_get_field <file> <field>
# Output: field value (scalar) or one item per line (array), empty if not found
# ---------------------------------------------------------------------------
skills_get_field() {
  local file="$1"
  local field="$2"

  local yaml
  yaml="$(skills_read_frontmatter "$file" 2>/dev/null)" || return 0

  # First, try to find the field as a simple key: value pair
  local value
  value="$(echo "$yaml" | awk -v field="$field" '
    $0 ~ "^" field ":" {
      # Remove the key and colon
      sub("^" field ":[[:space:]]*", "")
      # Trim surrounding quotes if present
      gsub(/^["'\'']|["'\'']$/, "")
      print
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ')" 2>/dev/null

  if [[ $? -eq 0 && -n "$value" ]]; then
    # Check if it's an inline array like [a, b, c]
    if [[ "$value" =~ ^\[.*\]$ ]]; then
      # Strip brackets, split on comma, trim whitespace and quotes
      echo "$value" | sed 's/^\[//;s/\]$//' | tr ',' '\n' | while read -r item; do
        item="$(echo "$item" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/^["'\''"]//;s/["'\''"]$//')"
        [[ -n "$item" ]] && echo "$item"
      done
      return 0
    fi
    echo "$value"
    return 0
  fi

  # Check for multi-line array format:
  # field:
  #   - item1
  #   - item2
  echo "$yaml" | awk -v field="$field" '
    BEGIN { in_field = 0; found = 0 }
    $0 ~ "^" field ":[[:space:]]*$" {
      in_field = 1
      next
    }
    in_field && /^[[:space:]]+- / {
      sub(/^[[:space:]]+- /, "")
      # Trim surrounding quotes
      gsub(/^["'\'']|["'\'']$/, "")
      print
      found = 1
      next
    }
    in_field && /^[[:space:]]+[^-]/ {
      # Continuation of previous item or nested key — skip
      next
    }
    in_field && !/^[[:space:]]/ {
      # New top-level key, stop
      exit
    }
    END { if (!found) exit 1 }
  ' 2>/dev/null

  return 0
}

# ---------------------------------------------------------------------------
# skills_resolve_script — Resolve backing_script for a skill
#
# Reads the backing_script field from frontmatter, resolves it relative
# to the skill directory.
#
# Usage: skills_resolve_script <name>
# Output: absolute path to backing script, or empty if none specified
# Exit: 0 if resolved or no script, 1 if skill not found
# ---------------------------------------------------------------------------
skills_resolve_script() {
  local name="$1"
  local dir
  dir="$(skills_resolve_dir "$name" 2>/dev/null)" || {
    _skills_error "skill not found: $name"
    return 1
  }

  local script_path
  script_path="$(skills_get_field "$dir/${name}.md" "backing_script")"
  if [[ -z "$script_path" ]]; then
    return 0
  fi

  # Resolve relative to skill directory
  if [[ "$script_path" == /* ]]; then
    echo "$script_path"
  else
    echo "$dir/$script_path"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# skills_validate — Validate one or all skills against the contract
#
# Checks:
#   - Frontmatter exists
#   - Required fields present (name, description, version, visibility)
#   - name matches directory name
#   - backing_script exists on disk (if specified, resolved relative to skill dir)
#   - depends_on references valid skill names
#   - composes targets valid skill names
#   - No duplicate names across skills
#
# Usage: skills_validate [name]
# Output: PASS/FAIL per skill with details
# Exit: 0 if all pass, 1 if any fail
# ---------------------------------------------------------------------------
skills_validate() {
  local target="${1:-}"
  local any_fail=0
  local all_names=()
  local skills_found=0

  # Collect all skill names first (for cross-reference checks)
  if [[ -d "$_SKILLS_DIR" ]]; then
    local _validate_dir
    for _validate_dir in "$_SKILLS_DIR"/*/; do
      [[ -d "$_validate_dir" ]] || continue
      local dname
      dname="$(basename "$_validate_dir")"
      [[ "$dname" == .* ]] && continue
      if [[ -f "$_validate_dir/${dname}.md" ]]; then
        all_names+=("$dname")
      fi
    done
  fi

  # If targeting a specific skill, validate just that one
  if [[ -n "$target" ]]; then
    _skills_validate_one "$target" all_names[@]
    return $?
  fi

  # Validate all skills
  if [[ ${#all_names[@]} -eq 0 ]]; then
    echo "No skills found in $_SKILLS_DIR"
    echo "Skills must be directories: skills/<name>/<name>.md"
    return 0
  fi

  # Check for duplicate names (shouldn't happen with directory-based layout, but be safe)
  local sorted_names
  sorted_names="$(printf '%s\n' "${all_names[@]}" | sort)"
  local dupes
  dupes="$(echo "$sorted_names" | uniq -d)"
  if [[ -n "$dupes" ]]; then
    echo "FAIL: Duplicate skill names found: $dupes"
    any_fail=1
  fi

  for name in "${all_names[@]}"; do
    if ! _skills_validate_one "$name" all_names[@]; then
      any_fail=1
    fi
  done

  return $any_fail
}

# Internal: validate a single skill
# Usage: _skills_validate_one <name> <all_names_array_ref>
_skills_validate_one() {
  local name="$1"
  local -a known_names=()

  # Reconstruct array from nameref
  if [[ $# -ge 2 ]]; then
    local arr_name="$2"
    eval 'known_names=("${'$arr_name'}")'
  fi

  local dir="$_SKILLS_DIR/$name"
  local file="$dir/${name}.md"
  local issues=()

  # Check directory exists
  if [[ ! -d "$dir" ]]; then
    echo "FAIL: $name — directory not found: $dir"
    return 1
  fi

  # Check skill file exists
  if [[ ! -f "$file" ]]; then
    echo "FAIL: $name — skill file not found: $file"
    return 1
  fi

  # Check frontmatter exists
  local yaml
  yaml="$(skills_read_frontmatter "$file" 2>/dev/null)" || {
    echo "FAIL: $name — no frontmatter found"
    return 1
  }

  # Check required fields
  local required_fields=("name" "description" "version" "visibility" "triggers")
  for field in "${required_fields[@]}"; do
    local val
    val="$(skills_get_field "$file" "$field")"
    if [[ -z "$val" ]]; then
      issues+=("missing required field: $field")
    fi
  done

  # Check name matches directory name
  local fm_name
  fm_name="$(skills_get_field "$file" "name")"
  if [[ -n "$fm_name" && "$fm_name" != "$name" ]]; then
    issues+=("name field '$fm_name' does not match directory name '$name'")
  fi

  # Check visibility is a valid value
  local fm_visibility
  fm_visibility="$(skills_get_field "$file" "visibility")"
  if [[ -n "$fm_visibility" ]]; then
    case "$fm_visibility" in
      user|system|internal) ;;
      *) issues+=("invalid visibility: '$fm_visibility' (must be user, system, or internal)") ;;
    esac
  fi

  # Check backing_script exists (if specified)
  local fm_script
  fm_script="$(skills_get_field "$file" "backing_script")"
  if [[ -n "$fm_script" ]]; then
    local resolved_script
    if [[ "$fm_script" == /* ]]; then
      resolved_script="$fm_script"
    else
      resolved_script="$dir/$fm_script"
    fi
    if [[ ! -f "$resolved_script" ]]; then
      issues+=("backing_script not found: $fm_script (expected at $resolved_script, relative to skill directory)")
    fi
  fi

  # Check depends_on references valid skill names
  local depends
  depends="$(skills_get_field "$file" "depends_on")"
  if [[ -n "$depends" ]]; then
    while IFS= read -r dep; do
      [[ -z "$dep" ]] && continue
      local dep_found=0
      for known in "${known_names[@]}"; do
        if [[ "$known" == "$dep" ]]; then
          dep_found=1
          break
        fi
      done
      if [[ $dep_found -eq 0 ]]; then
        issues+=("depends_on references unknown skill: '$dep'")
      fi
    done <<< "$depends"
  fi

  # Check composes targets valid skill names
  # composes is a complex structure, but we just check for skill references
  local composes_yaml
  composes_yaml="$(echo "$yaml" | awk '
    /^composes:/ { in_comp = 1; next }
    in_comp && /^[^ ]/ { exit }
    in_comp && /skill:/ {
      sub(/.*skill:[[:space:]]*/, "")
      gsub(/["'\''"]/, "")
      print
    }
  ')"
  if [[ -n "$composes_yaml" ]]; then
    while IFS= read -r comp_skill; do
      [[ -z "$comp_skill" ]] && continue
      local comp_found=0
      for known in "${known_names[@]}"; do
        if [[ "$known" == "$comp_skill" ]]; then
          comp_found=1
          break
        fi
      done
      if [[ $comp_found -eq 0 ]]; then
        issues+=("composes references unknown skill: '$comp_skill'")
      fi
    done <<< "$composes_yaml"
  fi

  # Report results
  if [[ ${#issues[@]} -eq 0 ]]; then
    echo "PASS: $name"
    return 0
  else
    echo "FAIL: $name"
    for issue in "${issues[@]}"; do
      echo "  - $issue"
    done
    return 1
  fi
}

# ---------------------------------------------------------------------------
# skills_generate_index — Generate skills/INDEX.md from skill frontmatter
#
# Reads all skills, extracts metadata, writes a markdown table.
# Columns: Name, Description, Visibility, Triggers, Has Script, Version
#
# Usage: skills_generate_index
# Output: writes to skills/INDEX.md
# ---------------------------------------------------------------------------
skills_generate_index() {
  local index_file="$_SKILLS_DIR/INDEX.md"
  local skills
  skills="$(skills_list)"

  if [[ -z "$skills" ]]; then
    cat > "$index_file" <<'HEADER'
# Skills

No skills registered yet. Create a skill directory `skills/<name>/<name>.md` to get started.
HEADER
    echo "Generated $index_file (empty — no skills found)"
    return 0
  fi

  local tmpfile
  tmpfile="$(mktemp)"

  cat > "$tmpfile" <<'HEADER'
# Skills

<!-- Auto-generated by scripts/lib/skills.sh — do not edit manually -->

| Name | Description | Visibility | Triggers | Has Script | Version |
|------|-------------|------------|----------|------------|---------|
HEADER

  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    local file="$_SKILLS_DIR/$name/${name}.md"

    local description version visibility triggers_raw has_script
    description="$(skills_get_field "$file" "description" 2>/dev/null)"
    version="$(skills_get_field "$file" "version" 2>/dev/null)"
    visibility="$(skills_get_field "$file" "visibility" 2>/dev/null)"
    has_script="$(skills_get_field "$file" "backing_script" 2>/dev/null)"

    # Collect triggers into a comma-separated string
    local triggers_list=""
    triggers_raw="$(skills_get_field "$file" "triggers" 2>/dev/null)"
    if [[ -n "$triggers_raw" ]]; then
      triggers_list="$(echo "$triggers_raw" | paste -sd ',' - | sed 's/,/, /g')"
    fi

    # Format has_script as yes/no
    local script_display="no"
    [[ -n "$has_script" ]] && script_display="yes"

    # Default empty fields
    description="${description:--}"
    version="${version:--}"
    visibility="${visibility:--}"
    triggers_list="${triggers_list:--}"

    echo "| $name | $description | $visibility | $triggers_list | $script_display | $version |" >> "$tmpfile"
  done <<< "$skills"

  mv "$tmpfile" "$index_file"
  echo "Generated $index_file"
}

# ---------------------------------------------------------------------------
# skills_sync_commands — Sync .claude/commands/ pointers for user-visible skills
#
# For each skill with visibility: user, ensures a pointer file exists at
# .claude/commands/<name>.md with normalized content pointing to the skill
# definition file using the directory-per-skill format.
#
# Also warns about orphaned pointer files that don't match any skill.
#
# Usage: skills_sync_commands
# Output: sync log to stdout
# ---------------------------------------------------------------------------
skills_sync_commands() {
  local commands_dir="$_SKILLS_ROOT_DIR/.claude/commands"
  local expected_content
  local created=0
  local updated=0
  local orphaned=0
  local skipped=0

  mkdir -p "$commands_dir"

  # Phase 1: Ensure all user-visible skills have correct pointers
  local skill_names
  skill_names="$(skills_list)"

  if [[ -z "$skill_names" ]]; then
    echo "No skills found — nothing to sync"
    return 0
  fi

  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    local file="$_SKILLS_DIR/$name/${name}.md"
    local vis
    vis="$(skills_get_field "$file" "visibility" 2>/dev/null)"

    # Only user-visible skills get command pointers
    if [[ "$vis" != "user" ]]; then
      continue
    fi

    local pointer="$commands_dir/${name}.md"
    expected_content="Read and follow \`skills/${name}/${name}.md\` exactly."

    if [[ ! -f "$pointer" ]]; then
      echo "$expected_content" > "$pointer"
      echo "  created: .claude/commands/${name}.md"
      created=$((created + 1))
    else
      local current
      current="$(cat "$pointer")"
      if [[ "$current" != "$expected_content" ]]; then
        echo "$expected_content" > "$pointer"
        echo "  updated: .claude/commands/${name}.md (normalized)"
        updated=$((updated + 1))
      else
        skipped=$((skipped + 1))
      fi
    fi
  done <<< "$skill_names"

  # Phase 2: Detect orphaned pointers
  # An orphaned pointer is a .md file in .claude/commands/ that doesn't match
  # any skill name. We only warn — don't delete automatically.
  for pointer_file in "$commands_dir"/*.md; do
    [[ -f "$pointer_file" ]] || continue
    local pointer_name
    pointer_name="$(basename "$pointer_file" .md)"

    # Check if this pointer matches a known skill
    local found=0
    while IFS= read -r name; do
      if [[ "$name" == "$pointer_name" ]]; then
        found=1
        break
      fi
    done <<< "$skill_names"

    if [[ $found -eq 0 ]]; then
      echo "  orphan: .claude/commands/${pointer_name}.md (no matching skill)"
      orphaned=$((orphaned + 1))
    fi
  done

  echo "Sync complete: $created created, $updated updated, $skipped unchanged, $orphaned orphaned"
}

# ---------------------------------------------------------------------------
# skills_log — Append a metrics entry to .metrics/skills.jsonl
#
# Usage: skills_log <skill> <action> <trigger> <duration_ms> <ok> [error] [model]
#
# Fields:
#   skill       — skill name
#   action      — specific action within the skill
#   trigger     — how invoked: /command, hook:<name>, compose:<skill>.<event>, cli
#   duration_ms — execution time in milliseconds
#   ok          — "true" or "false"
#   error       — error message (optional, only on failure)
#   model       — Claude model ID (optional)
# ---------------------------------------------------------------------------
skills_log() {
  local skill="${1:?skills_log: skill required}"
  local action="${2:?skills_log: action required}"
  local trigger="${3:?skills_log: trigger required}"
  local duration_ms="${4:?skills_log: duration_ms required}"
  local ok="${5:?skills_log: ok required}"
  local error="${6:-}"
  local model="${7:-}"

  _skills_ensure_metrics_dir

  local at
  at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  # Build JSON using jq for proper escaping
  local json
  json="$(jq -cn \
    --arg skill "$skill" \
    --arg action "$action" \
    --arg trigger "$trigger" \
    --arg at "$at" \
    --argjson duration_ms "$duration_ms" \
    --argjson ok "$ok" \
    --arg error "$error" \
    --arg model "$model" \
    '{
      skill: $skill,
      action: $action,
      trigger: $trigger,
      at: $at,
      duration_ms: $duration_ms,
      ok: $ok
    }
    + (if $error != "" then {error: $error} else {} end)
    + (if $model != "" then {model: $model} else {} end)'
  )"

  echo "$json" >> "$_METRICS_FILE"
}

# ---------------------------------------------------------------------------
# skills_stats — Aggregate stats from .metrics/skills.jsonl
#
# Usage: skills_stats [--skill NAME] [--since DURATION]
#
# --skill: filter to one skill
# --since: filter by time (e.g., 7d, 24h, 1h)
#
# Output: formatted table with invocations, success rate, avg duration
# ---------------------------------------------------------------------------
skills_stats() {
  local skill_filter=""
  local since_filter=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skill)
        skill_filter="$2"
        shift 2
        ;;
      --since)
        since_filter="$2"
        shift 2
        ;;
      *)
        _skills_error "skills_stats: unknown argument '$1'"
        return 1
        ;;
    esac
  done

  if [[ ! -f "$_METRICS_FILE" ]]; then
    echo "No metrics data found. Skills haven't been invoked yet."
    return 0
  fi

  # Compute cutoff timestamp if --since is specified
  local cutoff=""
  if [[ -n "$since_filter" ]]; then
    cutoff="$(_skills_compute_cutoff "$since_filter")"
    if [[ -z "$cutoff" ]]; then
      _skills_error "could not parse duration: $since_filter (use format like 7d, 24h, 1h)"
      return 1
    fi
  fi

  # Use jq to aggregate stats
  local jq_filter='
    [.[] |
      select(
        ($skill == "" or .skill == $skill) and
        ($cutoff == "" or .at >= $cutoff)
      )
    ] |
    group_by(.skill) |
    map({
      skill: .[0].skill,
      total: length,
      success: [.[] | select(.ok == true)] | length,
      avg_ms: ([.[] | .duration_ms] | add / length | round)
    }) |
    sort_by(.skill)
  '

  local results
  results="$(jq -sc \
    --arg skill "$skill_filter" \
    --arg cutoff "$cutoff" \
    "$jq_filter" "$_METRICS_FILE")"

  local count
  count="$(echo "$results" | jq 'length')"

  if [[ "$count" -eq 0 ]]; then
    echo "No matching metrics found."
    return 0
  fi

  # Print header
  printf "%-20s %8s %10s %10s\n" "Skill" "Total" "Success %" "Avg (ms)"
  printf "%-20s %8s %10s %10s\n" "--------------------" "--------" "----------" "----------"

  # Print rows
  echo "$results" | jq -r '.[] |
    [.skill, (.total | tostring), ((.success / .total * 100) | round | tostring) + "%", (.avg_ms | tostring)] |
    @tsv
  ' | while IFS=$'\t' read -r s_name s_total s_rate s_avg; do
    printf "%-20s %8s %10s %10s\n" "$s_name" "$s_total" "$s_rate" "$s_avg"
  done
}

# ---------------------------------------------------------------------------
# skills_list_table — Print a formatted table of all skills
#
# Columns: Name | Description | Visibility | Triggers | Script | Version
# Usage: skills_list_table
# Output: aligned table to stdout
# ---------------------------------------------------------------------------
skills_list_table() {
  local skill_names
  skill_names="$(skills_list)"

  if [[ -z "$skill_names" ]]; then
    echo "No skills found in $_SKILLS_DIR"
    echo "Skills must be directories: skills/<name>/<name>.md"
    return 0
  fi

  # Print header
  printf "%-20s %-45s %-10s %-35s %-8s %s\n" "Name" "Description" "Visibility" "Triggers" "Script" "Version"
  printf "%-20s %-45s %-10s %-35s %-8s %s\n" "--------------------" "---------------------------------------------" "----------" "-----------------------------------" "--------" "-------"

  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    local file="$_SKILLS_DIR/$name/${name}.md"

    local desc vis triggers_raw script_val ver triggers_joined has_script
    desc="$(skills_get_field "$file" "description" 2>/dev/null)"
    vis="$(skills_get_field "$file" "visibility" 2>/dev/null)"
    script_val="$(skills_get_field "$file" "backing_script" 2>/dev/null)"
    ver="$(skills_get_field "$file" "version" 2>/dev/null)"
    triggers_raw="$(skills_get_field "$file" "triggers" 2>/dev/null)"

    # Join triggers onto one line
    triggers_joined=""
    if [[ -n "$triggers_raw" ]]; then
      triggers_joined="$(echo "$triggers_raw" | paste -sd ',' - | sed 's/,/, /g')"
    fi

    has_script="no"
    [[ -n "$script_val" ]] && has_script="yes"

    # Truncate long values for display
    local desc_trunc="${desc:0:45}"
    local trig_trunc="${triggers_joined:0:35}"

    printf "%-20s %-45s %-10s %-35s %-8s %s\n" \
      "$name" \
      "${desc_trunc:--}" \
      "${vis:--}" \
      "${trig_trunc:--}" \
      "$has_script" \
      "${ver:--}"
  done <<< "$skill_names"
}

# Internal: compute ISO cutoff timestamp from a duration string like "7d", "24h"
_skills_compute_cutoff() {
  local duration="$1"
  local seconds=0

  if [[ "$duration" =~ ^([0-9]+)d$ ]]; then
    seconds=$(( ${BASH_REMATCH[1]} * 86400 ))
  elif [[ "$duration" =~ ^([0-9]+)h$ ]]; then
    seconds=$(( ${BASH_REMATCH[1]} * 3600 ))
  elif [[ "$duration" =~ ^([0-9]+)m$ ]]; then
    seconds=$(( ${BASH_REMATCH[1]} * 60 ))
  else
    return 1
  fi

  # macOS date
  local cutoff
  cutoff="$(date -u -v-"${seconds}"S +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)" || \
  cutoff="$(date -u -d "${seconds} seconds ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)" || \
  return 1

  echo "$cutoff"
}

# ===========================================================================
# Export / Import
# ===========================================================================
#
# Skills can be exported as portable .tar.gz archives and imported into
# other workspaces. Each archive contains the skill directory contents
# plus a manifest.json with metadata and file checksums.
# ===========================================================================

_EXPORTS_DIR="$_SKILLS_ROOT_DIR/.exports"

# ---------------------------------------------------------------------------
# _skills_ensure_exports_dir — Create .exports/ and add to .gitignore
# ---------------------------------------------------------------------------
_skills_ensure_exports_dir() {
  mkdir -p "$_EXPORTS_DIR"

  local gitignore="$_SKILLS_ROOT_DIR/.gitignore"
  if [[ -f "$gitignore" ]]; then
    if ! grep -q '^\.exports/' "$gitignore" 2>/dev/null; then
      echo "" >> "$gitignore"
      echo "# Skill exports" >> "$gitignore"
      echo ".exports/" >> "$gitignore"
    fi
  fi
}

# ---------------------------------------------------------------------------
# skills_export — Export a skill as a portable .tar.gz archive
#
# Creates .exports/<name>-v<version>.tar.gz containing:
#   - All files from skills/<name>/
#   - A manifest.json with metadata and sha256 checksums
#
# Usage: skills_export <name>
# Output: path to created archive
# Exit: 0 on success, 1 on failure
# ---------------------------------------------------------------------------
skills_export() {
  local name="${1:?skills_export: skill name required}"

  local dir
  dir="$(skills_resolve_dir "$name" 2>/dev/null)" || {
    _skills_error "skill not found: $name"
    return 1
  }

  local file="$dir/${name}.md"

  # Validate before exporting
  # Note: skills_validate clobbers $dir in caller scope (known issue in the
  # validate loop), so we re-resolve the directory after validation.
  if ! skills_validate "$name" >/dev/null 2>&1; then
    _skills_error "skill '$name' failed validation — fix issues before exporting"
    skills_validate "$name"
    return 1
  fi
  dir="$(skills_resolve_dir "$name")"
  file="$dir/${name}.md"

  # Read frontmatter fields
  local description version visibility
  description="$(skills_get_field "$file" "description" 2>/dev/null)"
  version="$(skills_get_field "$file" "version" 2>/dev/null)"
  visibility="$(skills_get_field "$file" "visibility" 2>/dev/null)"

  # Collect triggers as JSON array
  local triggers_raw triggers_json
  triggers_raw="$(skills_get_field "$file" "triggers" 2>/dev/null)"
  if [[ -n "$triggers_raw" ]]; then
    triggers_json="$(echo "$triggers_raw" | jq -R -s 'split("\n") | map(select(length > 0))')"
  else
    triggers_json="[]"
  fi

  _skills_ensure_exports_dir

  local archive_name="${name}-v${version}.tar.gz"
  local archive_path="$_EXPORTS_DIR/$archive_name"

  # Build in a temp directory (manual cleanup — trap RETURN is unsafe in functions)
  local tmpdir
  tmpdir="$(mktemp -d)"

  # Copy skill files into temp staging area
  local staging="$tmpdir/$name"
  cp -R "$dir" "$staging"

  # Compute checksums and collect file list using a file list first
  local file_list
  file_list="$(cd "$staging" && find . -type f | sed 's|^\./||' | sort)"

  local files_json="["
  local first=1
  while IFS= read -r rel_path; do
    [[ -z "$rel_path" ]] && continue
    local full_path="$staging/$rel_path"
    local checksum
    checksum="$(shasum -a 256 "$full_path" | awk '{print $1}')"

    if [[ $first -eq 1 ]]; then
      first=0
    else
      files_json="$files_json,"
    fi
    files_json="$files_json$(jq -cn --arg path "$rel_path" --arg sha256 "$checksum" '{path: $path, sha256: $sha256}')"
  done <<< "$file_list"
  files_json="$files_json]"

  # Build manifest.json
  local exported_at
  exported_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  jq -cn \
    --arg name "$name" \
    --arg description "$description" \
    --argjson version "$version" \
    --arg visibility "$visibility" \
    --argjson triggers "$triggers_json" \
    --argjson files "$files_json" \
    --arg exported_at "$exported_at" \
    --arg schema_version "1" \
    '{
      schema_version: $schema_version,
      name: $name,
      description: $description,
      version: $version,
      visibility: $visibility,
      triggers: $triggers,
      files: $files,
      exported_at: $exported_at
    }' > "$staging/manifest.json"

  # Create the archive from the temp directory
  tar czf "$archive_path" -C "$tmpdir" "$name"

  # Clean up
  rm -rf "$tmpdir"

  echo "Exported: $archive_path"
  return 0
}

# ---------------------------------------------------------------------------
# skills_export_all — Export all skills
#
# Usage: skills_export_all
# Output: log of exported archives
# ---------------------------------------------------------------------------
skills_export_all() {
  local skill_names
  skill_names="$(skills_list)"

  if [[ -z "$skill_names" ]]; then
    echo "No skills found to export."
    return 0
  fi

  local count=0
  local failed=0

  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    if skills_export "$name"; then
      count=$((count + 1))
    else
      failed=$((failed + 1))
    fi
  done <<< "$skill_names"

  echo "Export complete: $count exported, $failed failed"
  return 0
}

# ---------------------------------------------------------------------------
# skills_import — Import a skill from a .tar.gz archive
#
# Extracts the archive, validates the manifest, copies files into
# skills/<name>/, runs validation, and syncs index + commands.
# Rolls back on validation failure.
#
# Usage: skills_import <archive_path>
# Output: import log
# Exit: 0 on success, 1 on failure
# ---------------------------------------------------------------------------
skills_import() {
  local archive_path="${1:?skills_import: archive path required}"

  if [[ ! -f "$archive_path" ]]; then
    _skills_error "archive not found: $archive_path"
    return 1
  fi

  # Extract to a temp directory (manual cleanup — trap RETURN is unsafe in functions)
  local tmpdir
  tmpdir="$(mktemp -d)"

  if ! tar xzf "$archive_path" -C "$tmpdir" 2>/dev/null; then
    _skills_error "failed to extract archive: $archive_path"
    rm -rf "$tmpdir"
    return 1
  fi

  # Find the extracted skill directory (should be exactly one top-level dir)
  local extracted_dirs=()
  for d in "$tmpdir"/*/; do
    [[ -d "$d" ]] && extracted_dirs+=("$d")
  done

  if [[ ${#extracted_dirs[@]} -ne 1 ]]; then
    _skills_error "archive must contain exactly one top-level directory, found ${#extracted_dirs[@]}"
    rm -rf "$tmpdir"
    return 1
  fi

  local extracted_dir="${extracted_dirs[0]}"
  local extracted_name
  extracted_name="$(basename "$extracted_dir")"

  # Read and validate manifest
  local manifest="$extracted_dir/manifest.json"
  if [[ ! -f "$manifest" ]]; then
    _skills_error "no manifest.json found in archive"
    rm -rf "$tmpdir"
    return 1
  fi

  # Validate required manifest fields
  local manifest_name manifest_version manifest_description
  manifest_name="$(jq -r '.name // empty' "$manifest")"
  manifest_version="$(jq -r '.version // empty' "$manifest")"
  manifest_description="$(jq -r '.description // empty' "$manifest")"

  if [[ -z "$manifest_name" || -z "$manifest_version" ]]; then
    _skills_error "manifest.json missing required fields (name, version)"
    rm -rf "$tmpdir"
    return 1
  fi

  if [[ "$manifest_name" != "$extracted_name" ]]; then
    _skills_error "manifest name '$manifest_name' does not match directory name '$extracted_name'"
    rm -rf "$tmpdir"
    return 1
  fi

  # Check if skill already exists
  local target_dir="$_SKILLS_DIR/$manifest_name"
  if [[ -d "$target_dir" ]]; then
    echo "WARNING: skill '$manifest_name' already exists — overwriting" >&2
  fi

  # Verify file checksums from manifest
  local checksum_ok=1
  local file_count
  file_count="$(jq '.files | length' "$manifest")"

  local i=0
  while [[ $i -lt $file_count ]]; do
    local expected_path expected_sha256 actual_sha256
    expected_path="$(jq -r ".files[$i].path" "$manifest")"
    expected_sha256="$(jq -r ".files[$i].sha256" "$manifest")"

    local full_path="$extracted_dir/$expected_path"
    if [[ ! -f "$full_path" ]]; then
      _skills_error "file from manifest missing in archive: $expected_path"
      checksum_ok=0
    else
      actual_sha256="$(shasum -a 256 "$full_path" | awk '{print $1}')"
      if [[ "$actual_sha256" != "$expected_sha256" ]]; then
        _skills_error "checksum mismatch for $expected_path: expected $expected_sha256, got $actual_sha256"
        checksum_ok=0
      fi
    fi
    i=$((i + 1))
  done

  if [[ $checksum_ok -eq 0 ]]; then
    _skills_error "archive integrity check failed — aborting import"
    rm -rf "$tmpdir"
    return 1
  fi

  # Remove manifest.json before copying (it is not part of the skill)
  rm -f "$extracted_dir/manifest.json"

  # Copy files into skills/<name>/
  # If the skill exists, back it up first for rollback
  local backup_dir=""
  if [[ -d "$target_dir" ]]; then
    backup_dir="$(mktemp -d)"
    cp -R "$target_dir" "$backup_dir/backup"
  fi

  mkdir -p "$_SKILLS_DIR"
  rm -rf "$target_dir"
  cp -R "$extracted_dir" "$target_dir"

  # Validate the imported skill
  if ! skills_validate "$manifest_name" >/dev/null 2>&1; then
    _skills_error "imported skill '$manifest_name' failed validation — rolling back"
    skills_validate "$manifest_name" >&2

    # Roll back
    rm -rf "$target_dir"
    if [[ -n "$backup_dir" && -d "$backup_dir/backup" ]]; then
      cp -R "$backup_dir/backup" "$target_dir"
      rm -rf "$backup_dir"
    fi
    rm -rf "$tmpdir"
    return 1
  fi

  # Clean up backup and temp directory
  if [[ -n "$backup_dir" ]]; then
    rm -rf "$backup_dir"
  fi
  rm -rf "$tmpdir"

  # Regenerate index and sync commands
  skills_generate_index
  skills_sync_commands

  echo "Imported: $manifest_name v$manifest_version — $manifest_description"
  return 0
}

# ===========================================================================
# Composition Engine
# ===========================================================================
#
# Skills compose through declarative frontmatter. A skill's `composes` block
# declares downstream skills to trigger on specific events:
#
#   composes:
#     - skill: slack-status
#       on: close
#       action: resolve
#
# The composition engine reads these declarations, resolves target backing
# scripts, and invokes the target skill's action function.
#
# Function naming convention:
#   Target function = <skill_name_underscored>_<action_underscored>
#   Examples:
#     slack-status / resolve     → slack_status_resolve
#     memory / save-daily-summary → memory_save_daily_summary
#     auto-commit / commit-workspace-changes → auto_commit_commit_workspace_changes
#
# Replace all hyphens with underscores in both skill name and action.
# ===========================================================================

# ---------------------------------------------------------------------------
# skills_get_composes — Read a skill's composes declarations from frontmatter
#
# Parses the composes YAML block and outputs one JSON object per entry.
#
# Usage: skills_get_composes <name>
# Output: JSONL — one JSON object per compose entry
#   Each line: {"skill":"slack-status","on":"close","action":"resolve"}
# Exit: 0 (empty output if no composes)
# ---------------------------------------------------------------------------
skills_get_composes() {
  local name="$1"
  local dir
  dir="$(skills_resolve_dir "$name" 2>/dev/null)" || {
    _skills_error "skill not found: $name"
    return 0
  }

  local file="$dir/${name}.md"
  local yaml
  yaml="$(skills_read_frontmatter "$file" 2>/dev/null)" || return 0

  # Parse multi-line composes block using awk.
  # Structure:
  #   composes:
  #     - skill: slack-status
  #       on: close
  #       action: resolve
  #     - skill: memory
  #       on: review-complete
  #       action: save-daily-summary
  #
  # Output: one JSONL line per entry with skill, on, action fields.
  echo "$yaml" | awk '
    BEGIN { in_composes = 0; skill = ""; on = ""; action = "" }

    /^composes:/ {
      in_composes = 1
      next
    }

    # Stop at the next top-level key (not indented)
    in_composes && /^[^ ]/ { exit }

    # Handle empty array: composes: []
    /^composes:[[:space:]]*\[\]/ { exit }

    # New entry starts with "  - skill:"
    in_composes && /^[[:space:]]+- skill:/ {
      # Emit previous entry if complete
      if (skill != "" && on != "" && action != "") {
        gsub(/["'\''"]/, "", skill)
        gsub(/["'\''"]/, "", on)
        gsub(/["'\''"]/, "", action)
        printf "{\"skill\":\"%s\",\"on\":\"%s\",\"action\":\"%s\"}\n", skill, on, action
      }
      # Start new entry
      sub(/.*skill:[[:space:]]*/, "")
      gsub(/[[:space:]]*$/, "")
      gsub(/["'\''"]/, "")
      skill = $0
      on = ""
      action = ""
      next
    }

    # "on:" field within an entry
    in_composes && /^[[:space:]]+on:/ {
      sub(/.*on:[[:space:]]*/, "")
      gsub(/[[:space:]]*$/, "")
      gsub(/["'\''"]/, "")
      on = $0
      next
    }

    # "action:" field within an entry
    in_composes && /^[[:space:]]+action:/ {
      sub(/.*action:[[:space:]]*/, "")
      gsub(/[[:space:]]*$/, "")
      gsub(/["'\''"]/, "")
      action = $0
      next
    }

    END {
      # Emit last entry if complete
      if (skill != "" && on != "" && action != "") {
        gsub(/["'\''"]/, "", skill)
        gsub(/["'\''"]/, "", on)
        gsub(/["'\''"]/, "", action)
        printf "{\"skill\":\"%s\",\"on\":\"%s\",\"action\":\"%s\"}\n", skill, on, action
      }
    }
  '

  return 0
}

# ---------------------------------------------------------------------------
# skills_resolve_compose_targets — Resolve compose targets for a skill+event
#
# For a given skill and event, return the list of target skills and actions.
# Reads the skill's composes block and filters by on=<event>.
#
# Usage: skills_resolve_compose_targets <name> <event>
# Output: lines of "target_skill action" (space-separated)
# Example:
#   skills_resolve_compose_targets session close
#   → "slack-status resolve"
# Exit: 0
# ---------------------------------------------------------------------------
skills_resolve_compose_targets() {
  local name="$1"
  local event="$2"

  local composes
  composes="$(skills_get_composes "$name")"
  [[ -z "$composes" ]] && return 0

  local entry_on entry_skill entry_action
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    entry_on="$(echo "$line" | jq -r '.on // empty' 2>/dev/null)"
    if [[ "$entry_on" == "$event" ]]; then
      entry_skill="$(echo "$line" | jq -r '.skill // empty' 2>/dev/null)"
      entry_action="$(echo "$line" | jq -r '.action // empty' 2>/dev/null)"
      if [[ -n "$entry_skill" && -n "$entry_action" ]]; then
        echo "$entry_skill $entry_action"
      fi
    fi
  done <<< "$composes"

  return 0
}

# ---------------------------------------------------------------------------
# _skills_compose_func_name — Convert skill name + action to function name
#
# Convention: replace hyphens with underscores in both parts.
#   slack-status + resolve            → slack_status_resolve
#   auto-commit + commit-workspace-changes → auto_commit_commit_workspace_changes
#
# Usage: _skills_compose_func_name <skill> <action>
# Output: function name string
# ---------------------------------------------------------------------------
_skills_compose_func_name() {
  local skill="$1"
  local action="$2"
  local func_name="${skill//-/_}_${action//-/_}"
  echo "$func_name"
}

# ---------------------------------------------------------------------------
# skills_run_compose_pipeline — Execute the composition pipeline for a skill event
#
# This is the core composition engine. Instead of hardcoding
# "source slack.sh; resolve status", a hook calls:
#   skills_run_compose_pipeline session close
#
# For each compose target declared in the skill's frontmatter for the given event:
#   1. Resolve the target skill's backing script via skills_resolve_script
#   2. Source it (if it exists)
#   3. Call the action function using the naming convention:
#      <skill_name_underscored>_<action_underscored>
#      e.g., slack_status_resolve for slack-status/resolve
#   4. If the function doesn't exist, log a warning and continue
#   5. Log the invocation via skills_log
#
# The pipeline is best-effort: failures in individual steps are logged but
# don't abort the pipeline. This is graceful degradation by design.
#
# Usage: skills_run_compose_pipeline <name> <event>
# Output: pipeline execution log to stderr
# Exit: 0 (even if individual steps fail)
# ---------------------------------------------------------------------------
skills_run_compose_pipeline() {
  local name="$1"
  local event="$2"
  local targets target_skill target_action trigger func_name script_path
  local start_ms end_ms duration_ms step_ok step_error

  targets="$(skills_resolve_compose_targets "$name" "$event")"

  if [[ -z "$targets" ]]; then
    echo "[compose] No compose targets for $name/$event" >&2
    return 0
  fi

  echo "[compose] Running pipeline for $name/$event" >&2

  while IFS= read -r target_line; do
    [[ -z "$target_line" ]] && continue

    target_skill="${target_line%% *}"
    target_action="${target_line#* }"
    trigger="compose:${name}.${event}"
    func_name="$(_skills_compose_func_name "$target_skill" "$target_action")"

    echo "[compose]   -> $target_skill/$target_action (fn: $func_name)" >&2

    # Step 1: Resolve and source the backing script
    script_path="$(skills_resolve_script "$target_skill" 2>/dev/null)" || true

    if [[ -n "$script_path" && -f "$script_path" ]]; then
      # shellcheck disable=SC1090
      source "$script_path" 2>/dev/null || {
        echo "[compose]   WARN: failed to source $script_path" >&2
        skills_log "$target_skill" "$target_action" "$trigger" 0 false "source failed: $script_path" "" 2>/dev/null || true
        continue
      }
    fi

    # Step 2: Call the action function
    start_ms="$(_skills_epoch_ms)"

    if declare -f "$func_name" >/dev/null 2>&1; then
      step_ok=true
      step_error=""
      if ! "$func_name" 2>&1; then
        step_ok=false
        step_error="function $func_name failed"
        echo "[compose]   WARN: $func_name failed" >&2
      else
        echo "[compose]   OK: $func_name" >&2
      fi

      end_ms="$(_skills_epoch_ms)"
      duration_ms=$(( end_ms - start_ms ))
      skills_log "$target_skill" "$target_action" "$trigger" "$duration_ms" "$step_ok" "$step_error" "" 2>/dev/null || true
    else
      echo "[compose]   WARN: function $func_name not found -- skipping" >&2
      skills_log "$target_skill" "$target_action" "$trigger" 0 false "function not found: $func_name" "" 2>/dev/null || true
    fi

  done <<< "$targets"

  echo "[compose] Pipeline complete for $name/$event" >&2
  return 0
}

# ---------------------------------------------------------------------------
# _skills_epoch_ms — Return current time in milliseconds
#
# Uses perl as a portable fallback (macOS date doesn't support %N).
# ---------------------------------------------------------------------------
_skills_epoch_ms() {
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'
  elif date +%s%N >/dev/null 2>&1; then
    echo $(( $(date +%s%N) / 1000000 ))
  else
    echo $(( $(date +%s) * 1000 ))
  fi
}
