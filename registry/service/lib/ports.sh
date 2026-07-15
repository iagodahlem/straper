#!/usr/bin/env bash
# skills/service/lib/ports.sh — Port allocator for the service harness.
#
# Given a recipe's declared ports (each with a role, an env var, and a reserved
# agent band), pick the lowest free port per role. A port is allocatable only
# when it is free by BOTH tests:
#   1. Registry check  — no active .state/ record already holds it.
#   2. Liveness check  — nothing is actually LISTENING on it (lsof, then nc,
#                        then a bash /dev/tcp probe as a last resort).
# The liveness belt-and-suspenders is what makes "never touch your manual
# 4000/4011" hold even when there is no registry entry for that server. On top of
# that, every recipe port's own `default` (your manual value) is added to the
# reserved set, so those ports can never be picked regardless of band bounds.
#
# Bands live in config/services.json. The walk
# starts at each band's `min` (47xxx) — well clear of every local dev stack port and
# below the macOS ephemeral range — so 4000/4011 are never even in range.
#
# Usage:
#   source skills/service/lib/ports.sh          # library mode
#   bash skills/service/lib/ports.sh <recipe>   # print allocation for a recipe
#                                               # (recipe = path or config name)
# Output (per allocated port, TAB-separated): role<TAB>var<TAB>port<TAB>url
#
# Deliberately does NOT set -e (predicates return non-zero as normal flow).

if [ -n "${_SERVICE_PORTS_SH:-}" ]; then
  return 0 2>/dev/null || true
fi
_SERVICE_PORTS_SH=1

set -uo pipefail

# The registry provides active-port reservations and path helpers.
# shellcheck source=skills/service/lib/registry.sh
source "$(dirname "${BASH_SOURCE[0]}")/registry.sh"

# ---------------------------------------------------------------------------
# _service_band_range <band> — Print "min max" for a band; falls back to the
# `generic` band when the name is unknown, so allocation never hard-fails on a
# typo'd band.
# ---------------------------------------------------------------------------
_service_band_range() {
  local band="$1" cfg range
  cfg="$(_services_config_file)"
  range="$(jq -r --arg b "$band" '.bands[$b] // empty | "\(.min) \(.max)"' "$cfg" 2>/dev/null)"
  if [ -z "$range" ] || [ "$range" = " " ]; then
    range="$(jq -r '.bands.generic // empty | "\(.min) \(.max)"' "$cfg" 2>/dev/null)"
  fi
  echo "$range"
}

# ---------------------------------------------------------------------------
# port_listening <port> — True (0) if something is LISTENING on the TCP port,
# false (1) if the port is free. Prefers lsof, then nc, then bash /dev/tcp.
# ---------------------------------------------------------------------------
port_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    [ -n "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)" ]
    return
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z localhost "$port" >/dev/null 2>&1
    return
  fi
  # Last resort: a successful TCP connect means someone is listening.
  ( : <"/dev/tcp/127.0.0.1/$port" ) >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# _service_port_free <port> <reserved-space-list> — True (0) when the port is
# free: not in the reserved list, not held by an active registry record, and not
# actually listening.
# ---------------------------------------------------------------------------
_service_port_free() {
  local port="$1" reserved="${2:-}" r held
  # Reserved set (recipe defaults + ports already picked in this run).
  for r in $reserved; do
    [ "$r" = "$port" ] && return 1
  done
  # Active registry reservations.
  while IFS= read -r held; do
    [ -n "$held" ] || continue
    [ "$held" = "$port" ] && return 1
  done < <(service_registry_active_ports)
  # Foreign listeners (your manual server, strays, lost records).
  if port_listening "$port"; then
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# _service_alloc_in_band <band> <reserved-space-list> — Print the lowest free
# port in the band, or return non-zero if the band is exhausted.
# ---------------------------------------------------------------------------
_service_alloc_in_band() {
  local band="$1" reserved="${2:-}" range min max p
  range="$(_service_band_range "$band")"
  min="${range%% *}"
  max="${range##* }"
  if [ -z "$min" ] || [ "$min" = "null" ]; then
    echo "_service_alloc_in_band: no range for band '$band'" >&2
    return 1
  fi
  p="$min"
  while [ "$p" -le "$max" ]; do
    if _service_port_free "$p" "$reserved"; then
      echo "$p"
      return 0
    fi
    p=$((p + 1))
  done
  echo "_service_alloc_in_band: band '$band' ($min-$max) exhausted" >&2
  return 1
}

# ---------------------------------------------------------------------------
# allocate_ports <recipe-path|-> — For each recipe port, allocate the lowest
# free port in its band and print "role<TAB>var<TAB>port<TAB>url". Reads the
# recipe JSON from a file, or from stdin when the argument is "-". Ports with no
# declared ports produce no output (e.g. the hidden __test recipe).
# ---------------------------------------------------------------------------
allocate_ports() {
  local src="${1:-}" recipe_json reserved n i role var band url_tpl port url
  if [ "$src" = "-" ] || [ -z "$src" ]; then
    recipe_json="$(cat)"
  else
    recipe_json="$(cat "$src")"
  fi

  # Seed the reserved set with every port default (your manual ports) so they
  # can never be selected, even if a band were mis-configured to overlap.
  reserved="$(jq -r '[.ports[]?.default // empty] | map(tostring) | join(" ")' <<<"$recipe_json" 2>/dev/null)"

  n="$(jq -r '.ports | length' <<<"$recipe_json" 2>/dev/null || echo 0)"
  [ -n "$n" ] || n=0
  i=0
  while [ "$i" -lt "$n" ]; do
    role="$(jq -r ".ports[$i].role" <<<"$recipe_json")"
    var="$(jq -r ".ports[$i].var" <<<"$recipe_json")"
    band="$(jq -r ".ports[$i].band" <<<"$recipe_json")"
    url_tpl="$(jq -r ".ports[$i].readiness.http // \"\"" <<<"$recipe_json")"
    if ! port="$(_service_alloc_in_band "$band" "$reserved")"; then
      echo "allocate_ports: could not allocate port for role '$role'" >&2
      return 1
    fi
    reserved="$reserved $port"
    url="${url_tpl//\{port\}/$port}"
    printf '%s\t%s\t%s\t%s\n' "$role" "$var" "$port" "$url"
    i=$((i + 1))
  done
}

# ---------------------------------------------------------------------------
# Direct CLI — `bash skills/service/lib/ports.sh <recipe>`
# ---------------------------------------------------------------------------
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  _recipe="${1:-}"
  if [ -z "$_recipe" ]; then
    echo "usage: ports.sh <recipe.json | recipe-name>" >&2
    exit 1
  fi
  if [ ! -f "$_recipe" ]; then
    _cand="$(_service_root)/config/recipes/$_recipe.json"
    if [ -f "$_cand" ]; then
      _recipe="$_cand"
    else
      echo "ports.sh: no recipe file '$_recipe'" >&2
      exit 1
    fi
  fi
  allocate_ports "$_recipe"
fi
