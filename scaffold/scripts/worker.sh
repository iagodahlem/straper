#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_NAME=$(jq -r '.agent_name // "agent"' "$ROOT_DIR/preferences.json" 2>/dev/null || echo "agent")

exec "$ROOT_DIR/scripts/$AGENT_NAME" worker "$@"
