# Writing Verifiers

This page explains how to add verification scripts so the agent can type-check, lint, and test code in your repositories before creating pull requests.

## What verify.sh Does

`scripts/verify.sh` is a router script. It takes a worktree name as input, extracts the repo name from the worktree naming convention (`{repo}--{branch}`), and delegates to a repo-specific verifier at `scripts/verify-{repo}.sh`.

```bash
# Example: worktree named "dashboard--yourname/fix-auth"
# verify.sh extracts "dashboard" and calls scripts/verify-dashboard.sh
./scripts/verify.sh dashboard--yourname/fix-auth
```

If no repo-specific verifier exists, the router prints a warning and exits successfully. Verification is opt-in per repo.

## Usage

```bash
# Full verification (tier 2: typecheck + lint + tests)
./scripts/verify.sh <worktree-name>

# Tier 1 only (typecheck + lint, no tests)
./scripts/verify.sh <worktree-name> --tier 1

# Quick mode (lint only changed files, skip full lint scan)
./scripts/verify.sh <worktree-name> --quick
```

## Verification Tiers

| Tier | What runs | When to use |
|------|-----------|-------------|
| 1 | Type-check + lint | Every PR. Catches errors fast. |
| 2 | Tier 1 + unit tests scoped to changes | Default. Use when test files exist near the changes. |

## Creating a Verifier

Create `scripts/verify-{repo}.sh` where `{repo}` matches the repo portion of your worktree names.

### Template

```bash
#!/usr/bin/env bash
set -euo pipefail

WORKTREE_DIR="$1"
shift
TIER=2
QUICK=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier) TIER="$2"; shift 2 ;;
    --quick) QUICK=true; shift ;;
    *) shift ;;
  esac
done

cd "$WORKTREE_DIR"

echo "=== Verifying $(basename "$WORKTREE_DIR") ==="

# -- Tier 1: typecheck + lint --
echo "--- Typecheck ---"
# YOUR TYPECHECK COMMAND HERE
echo "STATUS: PASS typecheck"

echo "--- Lint ---"
if [[ "$QUICK" == "true" ]]; then
  echo "(quick mode - changed files only)"
  # YOUR QUICK LINT COMMAND HERE
else
  # YOUR FULL LINT COMMAND HERE
fi
echo "STATUS: PASS lint"

# -- Tier 2: tests --
if [[ "$TIER" -ge 2 ]]; then
  echo "--- Tests ---"
  # YOUR TEST COMMAND HERE
  echo "STATUS: PASS tests"
fi

echo "=== All checks passed ==="
```

After creating the file, make it executable:

```bash
chmod +x scripts/verify-myrepo.sh
```

### STATUS Lines

Subagents parse the output for `STATUS: PASS` and `STATUS: FAIL` lines after each check phase. Always print these. If a command fails and the script exits non-zero before printing the status line, that is fine — the non-zero exit code is the primary failure signal.

## Stack-Specific Examples

### Node.js / pnpm

```bash
#!/usr/bin/env bash
set -euo pipefail

WORKTREE_DIR="$1"; shift; TIER=2; QUICK=false
while [[ $# -gt 0 ]]; do
  case "$1" in --tier) TIER="$2"; shift 2 ;; --quick) QUICK=true; shift ;; *) shift ;; esac
done
cd "$WORKTREE_DIR"

# Activate Node 22 (if using nvm)
export PATH="$(ls -d ~/.nvm/versions/node/v22.*/bin 2>/dev/null | head -1):$PATH"

echo "--- Typecheck ---"
pnpm typecheck
echo "STATUS: PASS typecheck"

echo "--- Lint ---"
if [[ "$QUICK" == "true" ]]; then
  CHANGED=$(git diff --name-only HEAD -- '*.ts' '*.tsx' | tr '\n' ' ')
  [[ -n "$CHANGED" ]] && pnpm eslint $CHANGED
else
  pnpm lint
fi
echo "STATUS: PASS lint"

if [[ "$TIER" -ge 2 ]]; then
  echo "--- Tests ---"
  pnpm vitest run --changed
  echo "STATUS: PASS tests"
fi
```

### Go

```bash
#!/usr/bin/env bash
set -euo pipefail

WORKTREE_DIR="$1"; shift; TIER=2
while [[ $# -gt 0 ]]; do
  case "$1" in --tier) TIER="$2"; shift 2 ;; *) shift ;; esac
done
cd "$WORKTREE_DIR"

echo "--- Vet ---"
go vet ./...
echo "STATUS: PASS vet"

echo "--- Lint ---"
golangci-lint run ./...
echo "STATUS: PASS lint"

if [[ "$TIER" -ge 2 ]]; then
  echo "--- Tests ---"
  go test ./...
  echo "STATUS: PASS tests"
fi
```

### Python

```bash
#!/usr/bin/env bash
set -euo pipefail

WORKTREE_DIR="$1"; shift; TIER=2
while [[ $# -gt 0 ]]; do
  case "$1" in --tier) TIER="$2"; shift 2 ;; *) shift ;; esac
done
cd "$WORKTREE_DIR"

echo "--- Typecheck ---"
mypy .
echo "STATUS: PASS typecheck"

echo "--- Lint ---"
ruff check .
echo "STATUS: PASS lint"

if [[ "$TIER" -ge 2 ]]; then
  echo "--- Tests ---"
  pytest
  echo "STATUS: PASS tests"
fi
```

### Rust

```bash
#!/usr/bin/env bash
set -euo pipefail

WORKTREE_DIR="$1"; shift; TIER=2
while [[ $# -gt 0 ]]; do
  case "$1" in --tier) TIER="$2"; shift 2 ;; *) shift ;; esac
done
cd "$WORKTREE_DIR"

echo "--- Check ---"
cargo check
echo "STATUS: PASS check"

echo "--- Lint ---"
cargo clippy -- -D warnings
echo "STATUS: PASS lint"

if [[ "$TIER" -ge 2 ]]; then
  echo "--- Tests ---"
  cargo test
  echo "STATUS: PASS tests"
fi
```

## Testing Your Verifier

1. Create a test worktree:

   ```bash
   ./scripts/myagent worktree myrepo test-verify
   ```

2. Run the verifier directly to check it works:

   ```bash
   ./scripts/verify-myrepo.sh workspaces/myrepo--test-verify
   ```

3. Run through the router:

   ```bash
   ./scripts/verify.sh myrepo--test-verify
   ```

4. Test each tier:

   ```bash
   ./scripts/verify.sh myrepo--test-verify --tier 1   # typecheck + lint
   ./scripts/verify.sh myrepo--test-verify             # full (default: tier 2)
   ```

5. Test quick mode:

   ```bash
   ./scripts/verify.sh myrepo--test-verify --quick
   ```

6. Introduce a deliberate error and confirm the verifier catches it (exits non-zero).
