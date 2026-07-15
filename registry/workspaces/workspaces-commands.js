const fs = require('fs');
const path = require('path');

const { ROOT_DIR, runCommand } = require('../../scripts/lib/cli-utils.js');

const USAGE_MESSAGE = 'Usage: scripts/<agent> workspaces [--include-orphaned]';

// List all active worktrees with their status.
//
// Delegates to the single worktree-enumeration implementation in
// scripts/cleanup-workspaces.sh, run in non-destructive --dry-run mode, so
// there is ONE source of truth for branch / PR-state / task-linkage /
// staleness rather than a second, weaker listing. This command never removes
// anything: --force is never forwarded, only the read-only --include-orphaned.
function commandWorkspaces(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE_MESSAGE);
    return;
  }

  const passthrough = args.filter((a) => a === '--include-orphaned');
  // Workspace script preferred (this workspace's evolved version); the copy
  // bundled with the worktree module is the fallback for fresh workspaces.
  const workspaceScript = path.join(ROOT_DIR, 'scripts', 'cleanup-workspaces.sh');
  const script = fs.existsSync(workspaceScript)
    ? workspaceScript
    : path.join(ROOT_DIR, 'skills', 'worktree', 'cleanup-workspaces.sh');
  const result = runCommand('bash', [script, '--dry-run', ...passthrough], { stdio: 'inherit' });

  if (result.status && result.status !== 0) {
    process.exit(result.status);
  }
}

module.exports = { commandWorkspaces };
