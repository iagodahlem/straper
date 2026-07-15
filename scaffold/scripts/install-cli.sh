#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_NAME=$(jq -r '.agent_name // "agent"' "$ROOT_DIR/preferences.json" 2>/dev/null || echo "agent")

SOURCE_PATH="${ROOT_DIR}/scripts/${AGENT_NAME}"

if [ ! -f "$SOURCE_PATH" ]; then
  echo "Error: CLI wrapper not found at ${SOURCE_PATH}"
  echo "Expected a script named '${AGENT_NAME}' in scripts/."
  exit 1
fi

# Determine target directory
TARGET_DIR="${1:-}"

if [ -z "$TARGET_DIR" ]; then
  if [ -d "$HOME/.local/bin" ]; then
    TARGET_DIR="$HOME/.local/bin"
  elif [ -d "$HOME/bin" ]; then
    TARGET_DIR="$HOME/bin"
  else
    TARGET_DIR="$HOME/.local/bin"
    mkdir -p "$TARGET_DIR"
  fi
fi

TARGET_PATH="${TARGET_DIR}/${AGENT_NAME}"

mkdir -p "$TARGET_DIR"
ln -sfn "$SOURCE_PATH" "$TARGET_PATH"

echo "Installed ${AGENT_NAME} -> $TARGET_PATH"

case ":$PATH:" in
  *":$TARGET_DIR:"*)
    echo "PATH already includes $TARGET_DIR"
    ;;
  *)
    echo "Add this to your shell config if needed:"
    echo "export PATH=\"$TARGET_DIR:\$PATH\""
    ;;
esac

echo ""
echo "Shell completion:"
echo "  bash: source <(\"$TARGET_PATH\" completion bash)"
echo "  zsh:  source <(\"$TARGET_PATH\" completion zsh)"
