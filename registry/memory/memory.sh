#!/usr/bin/env bash
# skills/memory/memory.sh — Core memory management functions
#
# Memory files live at the workspace root:
#   MEMORY.md       — curated index of all memory
#   memory/         — daily logs (YYYY-MM-DD.md) and typed files (<type>_<name>.md)
#
# Typed files have YAML frontmatter: name, description, type
# Daily logs have no frontmatter — plain markdown.
#
# Usage: source skills/memory/memory.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_memory_root_dir() {
  # Resolve workspace root: walk up from this script to find the git root.
  # Fallback to SKILL_DIR/../.. if git is unavailable.
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local root
  root="$(cd "$script_dir" && git rev-parse --show-toplevel 2>/dev/null)" || \
    root="$(cd "$script_dir/../.." && pwd)"
  echo "$root"
}

_memory_dir() {
  echo "$(_memory_root_dir)/memory"
}

_memory_index_file() {
  echo "$(_memory_root_dir)/MEMORY.md"
}

_memory_today() {
  date +%F
}

_memory_yesterday() {
  # macOS-compatible: try -v first, fall back to GNU date
  if date -v-1d +%F >/dev/null 2>&1; then
    date -v-1d +%F
  else
    date -d "yesterday" +%F
  fi
}

# ---------------------------------------------------------------------------
# _memory_read_frontmatter — Extract a frontmatter field from a markdown file
#
# Usage: _memory_read_frontmatter <file> <field>
# Returns the field value or empty string if not found.
# ---------------------------------------------------------------------------
_memory_read_frontmatter() {
  local file="$1"
  local field="$2"

  if [[ ! -f "$file" ]]; then
    return 0
  fi

  # Check that the file starts with ---
  local first_line
  first_line="$(head -1 "$file")"
  if [[ "$first_line" != "---" ]]; then
    return 0
  fi

  # Extract frontmatter block (between first and second ---)
  # Use awk to get lines between first and second ---
  local value
  value="$(awk '
    /^---$/ { count++; next }
    count == 1 && /^'"$field"':/ {
      sub(/^'"$field"':[ \t]*/, "")
      print
      exit
    }
    count >= 2 { exit }
  ' "$file")"

  echo "$value"
}

# ---------------------------------------------------------------------------
# _memory_has_frontmatter — Check if a file has YAML frontmatter
#
# Usage: _memory_has_frontmatter <file>
# Exit: 0 if has frontmatter, 1 if not
# ---------------------------------------------------------------------------
_memory_has_frontmatter() {
  local file="$1"

  if [[ ! -f "$file" ]]; then
    return 1
  fi

  local first_line
  first_line="$(head -1 "$file")"
  if [[ "$first_line" != "---" ]]; then
    return 1
  fi

  # Check for closing ---
  local closing
  closing="$(awk 'NR > 1 && /^---$/ { print NR; exit }' "$file")"
  if [[ -z "$closing" ]]; then
    return 1
  fi

  return 0
}

# ---------------------------------------------------------------------------
# _memory_is_daily_log — Check if a filename matches the daily log pattern
#
# Usage: _memory_is_daily_log <filename>
# Exit: 0 if daily log, 1 if not
# ---------------------------------------------------------------------------
_memory_is_daily_log() {
  local filename
  filename="$(basename "$1")"
  if [[ "$filename" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$ ]]; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# _memory_kebab_to_title — Convert kebab-case to Title Case
#
# Usage: _memory_kebab_to_title "rebase-not-merge"
# Output: "Rebase not merge"
# ---------------------------------------------------------------------------
_memory_kebab_to_title() {
  local input="$1"
  # Replace hyphens and underscores with spaces, capitalize first letter
  local spaced
  spaced="$(echo "$input" | tr '-' ' ' | tr '_' ' ')"
  # Capitalize first letter only
  echo "$(echo "${spaced:0:1}" | tr '[:lower:]' '[:upper:]')${spaced:1}"
}

# ---------------------------------------------------------------------------
# _memory_file_age_relative — Get relative age of a file
#
# Usage: _memory_file_age_relative <file>
# Output: "2h ago", "3 days ago", etc.
# ---------------------------------------------------------------------------
_memory_file_age_relative() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "not found"
    return
  fi

  local file_epoch now_epoch diff_secs
  # macOS stat vs GNU stat
  if stat -f %m "$file" >/dev/null 2>&1; then
    file_epoch="$(stat -f %m "$file")"
  else
    file_epoch="$(stat -c %Y "$file")"
  fi
  now_epoch="$(date +%s)"
  diff_secs=$(( now_epoch - file_epoch ))

  local days=$(( diff_secs / 86400 ))
  local hours=$(( diff_secs / 3600 ))
  local mins=$(( diff_secs / 60 ))

  if [[ $days -gt 0 ]]; then
    if [[ $days -eq 1 ]]; then
      echo "1 day ago"
    else
      echo "${days} days ago"
    fi
  elif [[ $hours -gt 0 ]]; then
    if [[ $hours -eq 1 ]]; then
      echo "1h ago"
    else
      echo "${hours}h ago"
    fi
  elif [[ $mins -gt 0 ]]; then
    if [[ $mins -eq 1 ]]; then
      echo "1m ago"
    else
      echo "${mins}m ago"
    fi
  else
    echo "just now"
  fi
}

# ---------------------------------------------------------------------------
# _memory_valid_types — List valid memory types
# ---------------------------------------------------------------------------
_memory_valid_types() {
  echo "user feedback project reference"
}

# ---------------------------------------------------------------------------
# _memory_custom_sections — Read workspace-specific memory sections from config
#
# Reads .memory.custom_sections[] from config/workspace.json. These are the
# personal/workspace-specific MEMORY.md sections that are regenerated from typed
# files rather than preserved verbatim. Prints one section title per line.
# Returns nothing (empty list) when config, key, or jq is absent.
# ---------------------------------------------------------------------------
_memory_custom_sections() {
  local config_file
  config_file="$(_memory_root_dir)/config/workspace.json"

  if [[ ! -f "$config_file" ]] || ! command -v jq >/dev/null 2>&1; then
    return 0
  fi

  jq -r '.memory.custom_sections[]? // empty' "$config_file" 2>/dev/null || true
}

# _memory_custom_section_files — Source files for the custom sections above
#
# Reads .memory.custom_section_files[] from config/workspace.json, positionally
# paired with .memory.custom_sections[]. Each is the typed project file whose
# link is emitted under the matching custom section heading. Empty by default.
_memory_custom_section_files() {
  local config_file
  config_file="$(_memory_root_dir)/config/workspace.json"

  if [[ ! -f "$config_file" ]] || ! command -v jq >/dev/null 2>&1; then
    return 0
  fi

  jq -r '.memory.custom_section_files[]? // empty' "$config_file" 2>/dev/null || true
}

# ===========================================================================
# Public API
# ===========================================================================

# ---------------------------------------------------------------------------
# memory_load_context — Load MEMORY.md + today/yesterday daily logs
#
# Used by the SessionStart hook.
# Output: prints loaded file paths to stderr (for logging)
# Exit: 0 always (missing files are not errors)
# ---------------------------------------------------------------------------
memory_load_context() {
  local root
  root="$(_memory_root_dir)"
  local memory_dir
  memory_dir="$(_memory_dir)"
  local index_file
  index_file="$(_memory_index_file)"

  local today
  today="$(_memory_today)"
  local yesterday
  yesterday="$(_memory_yesterday)"

  if [[ -f "$index_file" ]]; then
    echo "- Loaded MEMORY.md" >&2
  else
    echo "- Missing MEMORY.md" >&2
  fi

  for day in "$today" "$yesterday"; do
    local file="$memory_dir/${day}.md"
    if [[ -f "$file" ]]; then
      echo "- Loaded $file" >&2
    fi
  done

  return 0
}

# ---------------------------------------------------------------------------
# memory_create_daily_log — Create today's daily log template if it doesn't exist
#
# Template:
#   # YYYY-MM-DD
#   ## Session Notes
#   -
#   ## Decisions
#   -
#   ## Blockers
#   -
#
# Exit: 0 (no-op if already exists)
# ---------------------------------------------------------------------------
memory_create_daily_log() {
  local memory_dir
  memory_dir="$(_memory_dir)"
  local today
  today="$(_memory_today)"
  local today_file="$memory_dir/${today}.md"

  if [[ -f "$today_file" ]]; then
    return 0
  fi

  mkdir -p "$memory_dir"

  cat > "$today_file" <<TEMPLATE
# ${today}

## Session Notes
-

## Decisions
-

## Blockers
-
TEMPLATE

  echo "- Created $today_file (template)" >&2
  return 0
}

# ---------------------------------------------------------------------------
# memory_validate — Check that today's daily log exists and is not the empty template
#
# Used by the SessionEnd hook.
# Output: validation result to stdout
# Exit: 0 if valid, 1 if missing or empty
# ---------------------------------------------------------------------------
memory_validate() {
  local memory_dir
  memory_dir="$(_memory_dir)"
  local today
  today="$(_memory_today)"
  local today_file="$memory_dir/${today}.md"

  if [[ ! -f "$today_file" ]]; then
    echo "MISSING: $today_file does not exist"
    return 1
  fi

  if [[ ! -s "$today_file" ]]; then
    echo "MISSING: $today_file is empty"
    return 1
  fi

  # Check if the file is just the empty template (all section bodies are just "-")
  # A non-template file will have content beyond the bare "- " placeholders
  local content_lines
  content_lines="$(grep -cvE '^(#|---|-[[:space:]]*$|$)' "$today_file" 2>/dev/null || echo "0")"

  if [[ "$content_lines" -eq 0 ]]; then
    echo "MISSING: $today_file exists but has no content beyond the template"
    return 1
  fi

  echo "OK: $today_file"
  return 0
}

# ---------------------------------------------------------------------------
# memory_regenerate_index — Rebuild MEMORY.md from memory/ files
#
# Scans all .md files in memory/:
# - Reads frontmatter from typed files (name, description, type)
# - Groups by type (user, feedback, project, reference)
# - Lists daily logs separately
# - PRESERVES manually-written sections that aren't auto-generated
#
# Auto-generated sections are marked with <!-- auto:start:<section> --> and
# <!-- auto:end:<section> --> comments. Everything between those markers is
# regenerated. Everything outside is preserved.
#
# Exit: 0 on success
# ---------------------------------------------------------------------------
memory_regenerate_index() {
  local root
  root="$(_memory_root_dir)"
  local memory_dir
  memory_dir="$(_memory_dir)"
  local index_file
  index_file="$(_memory_index_file)"

  if [[ ! -d "$memory_dir" ]]; then
    echo "No memory/ directory found — nothing to index." >&2
    return 0
  fi

  # Workspace-specific sections to regenerate (config-driven, empty by default)
  local custom_sections=()
  local _cs
  while IFS= read -r _cs; do
    [[ -n "$_cs" ]] && custom_sections+=("$_cs")
  done < <(_memory_custom_sections)

  local custom_section_files=()
  local _csf
  while IFS= read -r _csf; do
    [[ -n "$_csf" ]] && custom_section_files+=("$_csf")
  done < <(_memory_custom_section_files)

  # Collect typed files by type
  local user_files=()
  local feedback_files=()
  local project_files=()
  local reference_files=()
  local daily_files=()
  local untyped_files=()
  local typed_count=0
  local daily_count=0

  for file in "$memory_dir"/*.md; do
    [[ -f "$file" ]] || continue
    local basename
    basename="$(basename "$file")"

    if _memory_is_daily_log "$file"; then
      daily_files+=("$basename")
      daily_count=$((daily_count + 1))
      continue
    fi

    if ! _memory_has_frontmatter "$file"; then
      untyped_files+=("$basename")
      continue
    fi

    local type
    type="$(_memory_read_frontmatter "$file" "type")"
    local name
    name="$(_memory_read_frontmatter "$file" "name")"
    local description
    description="$(_memory_read_frontmatter "$file" "description")"

    # Use filename if name is missing
    if [[ -z "$name" ]]; then
      name="$basename"
    fi

    typed_count=$((typed_count + 1))

    case "$type" in
      user)       user_files+=("$basename|||$name|||$description") ;;
      feedback)   feedback_files+=("$basename|||$name|||$description") ;;
      project)    project_files+=("$basename|||$name|||$description") ;;
      reference)  reference_files+=("$basename|||$name|||$description") ;;
      *)          untyped_files+=("$basename") ;;
    esac
  done

  # If MEMORY.md exists, preserve non-auto-generated content
  # Strategy: read the existing file, identify manually curated sections,
  # and rebuild with auto-generated sections updated.

  local output=""

  output+="# Memory"$'\n'
  output+=""$'\n'

  # --- Manual sections (preserved from existing MEMORY.md) ---
  # These are the sections we know are manually curated.
  # We extract them from the current MEMORY.md if it exists.

  local manual_sections=""
  if [[ -f "$index_file" ]]; then
    # Extract everything from ## Active Tasks through just before the first
    # auto-generated section. We preserve these known manual sections:
    #   ## Active Tasks, ## Key Repos, ## Learned Preferences, ## Mission Control,
    #   ## Skills, ## Feature Design System, ## Worktree Verification,
    #   ## Known Gotchas, ## Agent Catalog, and any other manually-written section
    #   that doesn't correspond to a memory type.

    # Read the whole file and preserve sections that are not type-based.
    # Type-based sections we regenerate: Feedback, Project Context, Company Context,
    # Observability & Incident Response, plus any workspace-specific sections
    # listed under memory.custom_sections in config/workspace.json.
    # We'll preserve everything that's not clearly a typed-memory-link section.

    local in_auto_section=false
    local current_section=""
    local preserved=""
    local skip_sections=()

    # We regenerate these sections from typed files. Base set plus the
    # config-driven custom sections (empty when none are configured).
    skip_sections=("## Feedback" "## Observability & Incident Response" "## Company Context" "## SCIM Phase 2" "## Multi-Provider Support")
    if [[ ${#custom_sections[@]} -gt 0 ]]; then
      for _cs in "${custom_sections[@]}"; do
        skip_sections+=("## $_cs")
      done
    fi

    while IFS= read -r line; do
      # Skip the title line
      if [[ "$line" == "# Memory" ]]; then
        continue
      fi

      # Track section headers
      if [[ "$line" =~ ^##\  ]]; then
        current_section="$line"
        in_auto_section=false
        for skip in "${skip_sections[@]}"; do
          if [[ "$current_section" == "$skip" ]]; then
            in_auto_section=true
            break
          fi
        done
      fi

      if [[ "$in_auto_section" == false ]]; then
        preserved+="$line"$'\n'
      fi
    done < "$index_file"

    manual_sections="$preserved"
  fi

  # Append manual sections
  if [[ -n "$manual_sections" ]]; then
    output+="$manual_sections"
    # Ensure a blank line before auto-generated sections
    if [[ ! "$manual_sections" =~ $'\n'$ ]]; then
      output+=""$'\n'
    fi
  fi

  # --- Auto-generated sections from typed memory files ---

  # Multi-Provider Support (project type, specific file)
  local multi_provider_entry=""
  for entry in "${project_files[@]}"; do
    local fname="${entry%%|||*}"
    if [[ "$fname" == "project_multi_provider_review.md" ]]; then
      local rest="${entry#*|||}"
      local ename="${rest%%|||*}"
      local edesc="${rest#*|||}"
      multi_provider_entry="- [${ename}](memory/${fname}): ${edesc}"
    fi
  done
  if [[ -n "$multi_provider_entry" ]]; then
    output+="## Multi-Provider Support"$'\n'
    output+=""$'\n'
    output+="$multi_provider_entry"$'\n'
    output+=""$'\n'
  fi

  # SCIM Phase 2 (project type, specific file)
  local scim_entry=""
  for entry in "${project_files[@]}"; do
    local fname="${entry%%|||*}"
    if [[ "$fname" == "project_custom_attributes_global.md" ]]; then
      local rest="${entry#*|||}"
      local ename="${rest%%|||*}"
      local edesc="${rest#*|||}"
      scim_entry="- [${ename}](memory/${fname}): ${edesc}"
    fi
  done
  if [[ -n "$scim_entry" ]]; then
    output+="## SCIM Phase 2"$'\n'
    output+=""$'\n'
    output+="$scim_entry"$'\n'
    output+=""$'\n'
  fi

  # Workspace-specific side-projects section (project type, config-driven file).
  # Both the heading (memory.custom_sections) and the source file
  # (memory.custom_section_files) come from config/workspace.json; emitted only
  # when a custom section and its file are configured (empty by default).
  local ecosystem_entry=""
  local custom_file="${custom_section_files[0]:-}"
  if [[ -n "$custom_file" ]]; then
    for entry in "${project_files[@]}"; do
      local fname="${entry%%|||*}"
      if [[ "$fname" == "$custom_file" ]]; then
        local rest="${entry#*|||}"
        local ename="${rest%%|||*}"
        local edesc="${rest#*|||}"
        ecosystem_entry="- [${ename}](memory/${fname}): ${edesc}"
      fi
    done
  fi
  if [[ -n "$ecosystem_entry" && ${#custom_sections[@]} -gt 0 ]]; then
    output+="## ${custom_sections[0]}"$'\n'
    output+=""$'\n'
    output+="$ecosystem_entry"$'\n'
    output+=""$'\n'
  fi

  # Company Context (project type, specific file)
  local company_entry=""
  for entry in "${project_files[@]}"; do
    local fname="${entry%%|||*}"
    if [[ "$fname" == "project_merge_freeze_reliability.md" ]]; then
      local rest="${entry#*|||}"
      local ename="${rest%%|||*}"
      local edesc="${rest#*|||}"
      company_entry="- [${ename}](memory/${fname}): ${edesc}"
    fi
  done
  if [[ -n "$company_entry" ]]; then
    output+="## Company Context"$'\n'
    output+=""$'\n'
    output+="$company_entry"$'\n'
    output+=""$'\n'
  fi

  # Observability & Incident Response (reference + user types)
  local obs_entries=()
  for entry in "${reference_files[@]}"; do
    local fname="${entry%%|||*}"
    if [[ "$fname" == "reference_observability_tools.md" || "$fname" == "reference_incident_response.md" ]]; then
      local rest="${entry#*|||}"
      local ename="${rest%%|||*}"
      local edesc="${rest#*|||}"
      obs_entries+=("- [${ename}](memory/${fname}): ${edesc}")
    fi
  done
  for entry in "${user_files[@]}"; do
    local fname="${entry%%|||*}"
    if [[ "$fname" == "user_incidents_goal.md" ]]; then
      local rest="${entry#*|||}"
      local ename="${rest%%|||*}"
      local edesc="${rest#*|||}"
      obs_entries+=("- [${ename}](memory/${fname}): ${edesc}")
    fi
  done
  if [[ ${#obs_entries[@]} -gt 0 ]]; then
    output+="## Observability & Incident Response"$'\n'
    output+=""$'\n'
    for e in "${obs_entries[@]}"; do
      output+="$e"$'\n'
    done
    output+=""$'\n'
  fi

  # Feedback (all feedback files)
  if [[ ${#feedback_files[@]} -gt 0 ]]; then
    output+="## Feedback"$'\n'
    output+=""$'\n'
    for entry in "${feedback_files[@]}"; do
      local fname="${entry%%|||*}"
      local rest="${entry#*|||}"
      local ename="${rest%%|||*}"
      local edesc="${rest#*|||}"
      output+="- [${ename}](memory/${fname}): ${edesc}"$'\n'
    done
    output+=""$'\n'
  fi

  echo "$output" > "$index_file"

  echo "Regenerated MEMORY.md -- $typed_count typed files, $daily_count daily logs." >&2
  return 0
}

# ---------------------------------------------------------------------------
# memory_save — Create a new typed memory file and update the index
#
# Usage: memory_save <type> <name> <body>
#
# Creates: memory/<type>_<name>.md with frontmatter
# Updates: MEMORY.md with a link in the appropriate section
#
# Exit: 0 on success, 1 on invalid type or missing args
# ---------------------------------------------------------------------------
memory_save() {
  local type="${1:-}"
  local name="${2:-}"
  local body="${3:-}"

  # Validate arguments
  if [[ -z "$type" || -z "$name" || -z "$body" ]]; then
    echo "Usage: memory_save <type> <name> <body>" >&2
    return 1
  fi

  # Validate type
  local valid_types
  valid_types="$(_memory_valid_types)"
  local type_valid=false
  for t in $valid_types; do
    if [[ "$t" == "$type" ]]; then
      type_valid=true
      break
    fi
  done

  if [[ "$type_valid" == false ]]; then
    echo "Invalid type '$type'. Must be one of: $valid_types" >&2
    return 1
  fi

  local memory_dir
  memory_dir="$(_memory_dir)"
  local index_file
  index_file="$(_memory_index_file)"

  mkdir -p "$memory_dir"

  local filename="${type}_${name}.md"
  local filepath="$memory_dir/$filename"

  # Derive human-readable title from name
  local title
  title="$(_memory_kebab_to_title "$name")"

  # Extract first line of body as description
  local description
  description="$(echo "$body" | head -1)"

  # Create the memory file with frontmatter
  cat > "$filepath" <<EOF
---
name: $title
description: $description
type: $type
---

$body
EOF

  echo "Created $filepath" >&2

  # Append link to MEMORY.md if it exists
  if [[ -f "$index_file" ]]; then
    # Determine which section to append to based on type
    local section_header=""
    case "$type" in
      user)      section_header="## Learned Preferences" ;;
      feedback)  section_header="## Feedback" ;;
      project)   section_header="## Multi-Provider Support" ;;  # Default project section
      reference) section_header="## Observability & Incident Response" ;;  # Default reference section
    esac

    # Check if section exists
    if grep -q "^${section_header}$" "$index_file" 2>/dev/null; then
      # Find the section and append after its last entry
      local tmp
      tmp="$(mktemp)"
      local in_section=false
      local appended=false

      while IFS= read -r line; do
        echo "$line" >> "$tmp"

        if [[ "$line" == "$section_header" ]]; then
          in_section=true
          continue
        fi

        if [[ "$in_section" == true && "$appended" == false ]]; then
          # If we hit the next section or end of file content area, append before it
          if [[ "$line" =~ ^##\  || -z "$line" ]]; then
            # Append before the blank line separating sections
            if [[ -z "$line" ]]; then
              # Insert the new entry before this blank line
              local tmp2
              tmp2="$(mktemp)"
              # Remove the last blank line we just wrote, add entry, then blank line
              # Use sed instead of head -n -1 for macOS compatibility
              sed '$ d' "$tmp" > "$tmp2"
              echo "- [${title}](memory/${filename}): ${description}" >> "$tmp2"
              echo "" >> "$tmp2"
              mv "$tmp2" "$tmp"
              appended=true
              in_section=false
            fi
          fi
        fi
      done < "$index_file"

      # If section was found but we never hit a blank line after it (end of file)
      if [[ "$in_section" == true && "$appended" == false ]]; then
        echo "- [${title}](memory/${filename}): ${description}" >> "$tmp"
        echo "" >> "$tmp"
      fi

      mv "$tmp" "$index_file"
    else
      # Section doesn't exist — append at end
      {
        echo ""
        echo "$section_header"
        echo ""
        echo "- [${title}](memory/${filename}): ${description}"
      } >> "$index_file"
    fi

    echo "Updated MEMORY.md index." >&2
  fi

  return 0
}

# ---------------------------------------------------------------------------
# memory_list_orphans — Find typed files not linked in MEMORY.md
#
# Output: one file path per line (relative to memory/)
# Exit: 0 always
# ---------------------------------------------------------------------------
memory_list_orphans() {
  local memory_dir
  memory_dir="$(_memory_dir)"
  local index_file
  index_file="$(_memory_index_file)"

  if [[ ! -d "$memory_dir" || ! -f "$index_file" ]]; then
    return 0
  fi

  local index_content
  index_content="$(cat "$index_file")"

  for file in "$memory_dir"/*.md; do
    [[ -f "$file" ]] || continue

    local basename
    basename="$(basename "$file")"

    # Skip daily logs
    if _memory_is_daily_log "$file"; then
      continue
    fi

    # Skip files without frontmatter
    if ! _memory_has_frontmatter "$file"; then
      continue
    fi

    # Check if linked in MEMORY.md
    if ! echo "$index_content" | grep -q "memory/${basename}" 2>/dev/null; then
      echo "$basename"
    fi
  done

  return 0
}

# ---------------------------------------------------------------------------
# memory_status_today — Show today's memory status
#
# Output: status report to stdout
# Exit: 0 always
# ---------------------------------------------------------------------------
memory_status_today() {
  local memory_dir
  memory_dir="$(_memory_dir)"
  local index_file
  index_file="$(_memory_index_file)"
  local today
  today="$(_memory_today)"
  local today_file="$memory_dir/${today}.md"

  # Daily log status
  if [[ ! -f "$today_file" ]]; then
    echo "Today's daily log: memory/${today}.md (missing)"
  elif [[ ! -s "$today_file" ]]; then
    echo "Today's daily log: memory/${today}.md (empty)"
  else
    local content_lines
    content_lines="$(grep -cvE '^(#|---|-[[:space:]]*$|$)' "$today_file" 2>/dev/null || echo "0")"
    if [[ "$content_lines" -eq 0 ]]; then
      echo "Today's daily log: memory/${today}.md (exists, template only)"
    else
      echo "Today's daily log: memory/${today}.md (exists, has content)"
    fi
  fi

  # MEMORY.md status
  if [[ -f "$index_file" ]]; then
    local age
    age="$(_memory_file_age_relative "$index_file")"
    echo "MEMORY.md last updated: $age"
  else
    echo "MEMORY.md: not found"
  fi

  # Count typed files by type
  local user_count=0 feedback_count=0 project_count=0 reference_count=0

  if [[ -d "$memory_dir" ]]; then
    for file in "$memory_dir"/*.md; do
      [[ -f "$file" ]] || continue
      if _memory_is_daily_log "$file"; then
        continue
      fi
      if ! _memory_has_frontmatter "$file"; then
        continue
      fi
      local type
      type="$(_memory_read_frontmatter "$file" "type")"
      case "$type" in
        user)      user_count=$((user_count + 1)) ;;
        feedback)  feedback_count=$((feedback_count + 1)) ;;
        project)   project_count=$((project_count + 1)) ;;
        reference) reference_count=$((reference_count + 1)) ;;
      esac
    done
  fi

  echo "Typed files: ${user_count} user, ${feedback_count} feedback, ${project_count} project, ${reference_count} reference"

  return 0
}

# ---------------------------------------------------------------------------
# memory_list_status — Full summary of all memory files
#
# Output: summary report to stdout
# Exit: 0 always
# ---------------------------------------------------------------------------
memory_list_status() {
  local memory_dir
  memory_dir="$(_memory_dir)"
  local index_file
  index_file="$(_memory_index_file)"

  local user_count=0 feedback_count=0 project_count=0 reference_count=0 daily_count=0

  if [[ -d "$memory_dir" ]]; then
    for file in "$memory_dir"/*.md; do
      [[ -f "$file" ]] || continue
      if _memory_is_daily_log "$file"; then
        daily_count=$((daily_count + 1))
        continue
      fi
      if ! _memory_has_frontmatter "$file"; then
        continue
      fi
      local type
      type="$(_memory_read_frontmatter "$file" "type")"
      case "$type" in
        user)      user_count=$((user_count + 1)) ;;
        feedback)  feedback_count=$((feedback_count + 1)) ;;
        project)   project_count=$((project_count + 1)) ;;
        reference) reference_count=$((reference_count + 1)) ;;
      esac
    done
  fi

  local total=$(( user_count + feedback_count + project_count + reference_count + daily_count ))

  echo "Memory summary:"
  printf "  user:      %d file%s\n" "$user_count" "$([ "$user_count" -ne 1 ] && echo "s" || echo "")"
  printf "  feedback:  %d file%s\n" "$feedback_count" "$([ "$feedback_count" -ne 1 ] && echo "s" || echo "")"
  printf "  project:   %d file%s\n" "$project_count" "$([ "$project_count" -ne 1 ] && echo "s" || echo "")"
  printf "  reference: %d file%s\n" "$reference_count" "$([ "$reference_count" -ne 1 ] && echo "s" || echo "")"
  printf "  daily:     %d file%s\n" "$daily_count" "$([ "$daily_count" -ne 1 ] && echo "s" || echo "")"
  printf "  Total:     %d file%s\n" "$total" "$([ "$total" -ne 1 ] && echo "s" || echo "")"

  # MEMORY.md last modified
  if [[ -f "$index_file" ]]; then
    local last_modified
    if stat -f "%Sm" -t "%Y-%m-%d" "$index_file" >/dev/null 2>&1; then
      last_modified="$(stat -f "%Sm" -t "%Y-%m-%d" "$index_file")"
    else
      last_modified="$(stat -c "%y" "$index_file" | cut -d' ' -f1)"
    fi
    echo "  MEMORY.md: last modified $last_modified"
  else
    echo "  MEMORY.md: not found"
  fi

  # Orphans
  local orphans
  orphans="$(memory_list_orphans)"
  if [[ -n "$orphans" ]]; then
    local orphan_count
    orphan_count="$(echo "$orphans" | wc -l | tr -d ' ')"
    echo "  Orphans:   $orphan_count"
    echo "$orphans" | while read -r f; do
      echo "    - $f"
    done
  else
    echo "  Orphans:   0"
  fi

  return 0
}
