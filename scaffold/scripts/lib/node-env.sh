#!/usr/bin/env bash
# Node environment setup for worktree verification.
# Source this file -- do not execute directly. PATH is the only side effect;
# this never exits or trips a set -e trap in the sourcing shell.
#
# Resolution order:
#   1. $NODE_ENV_BIN -- explicit override, a Node bin dir used verbatim.
#   2. Newest v22.* under $NVM_DIR (default $HOME/.nvm).
#   3. Newest version >= v20 as a fallback (with a one-line stderr notice).

_node_root="${NVM_DIR:-$HOME/.nvm}/versions/node"

_list_node_versions() {
  local d name
  for d in "${_node_root}"/v[0-9]*/; do
    [ -d "$d" ] || continue
    name="${d%/}"
    printf '%s\n' "${name##*/}"
  done
}

_pick_node_bin() {
  if [ -n "${NODE_ENV_BIN:-}" ] && [ -d "${NODE_ENV_BIN}" ]; then
    printf '%s\n' "${NODE_ENV_BIN}"
    return 0
  fi
  [ -d "${_node_root}" ] || return 1
  local v
  v="$(_list_node_versions | grep -E '^v22\.' | sort -V | tail -n1)"
  if [ -n "$v" ]; then
    printf '%s\n' "${_node_root}/${v}/bin"
    return 0
  fi
  v="$(_list_node_versions | awk -F. 'substr($1,2)+0>=20' | sort -V | tail -n1)"
  if [ -n "$v" ]; then
    printf '%s\n' "${_node_root}/${v}/bin"
    echo "node-env: no v22.* found; falling back to ${v}" >&2
    return 0
  fi
  return 1
}

_node_bin="$(_pick_node_bin)"
if [ -z "${_node_bin}" ]; then
  echo "node-env: no Node >= v20 found under ${_node_root}" >&2
else
  case ":${PATH}:" in
    *":${_node_bin}:"*) ;;
    *) export PATH="${_node_bin}:${PATH}" ;;
  esac
fi

# pnpm shim can be missing from a version's bin; borrow one from another version.
if ! command -v pnpm >/dev/null 2>&1; then
  _pnpm_shim=""
  for _b in "${_node_root}"/v[0-9]*/bin; do
    if [ -x "${_b}/pnpm" ]; then
      _pnpm_shim="${_b}"
      break
    fi
  done
  if [ -n "${_pnpm_shim}" ]; then
    case ":${PATH}:" in
      *":${_pnpm_shim}:"*) ;;
      *) export PATH="${PATH}:${_pnpm_shim}" ;;
    esac
  else
    echo "node-env: pnpm not found; enable it with 'corepack enable pnpm'" >&2
  fi
fi

ensure_node_modules() {
  local dir="${1:-.}"
  if [ ! -d "${dir}/node_modules" ]; then
    echo "  Installing dependencies (pnpm install --frozen-lockfile)..."
    (cd "$dir" && pnpm install --frozen-lockfile --silent)
  fi
}
