const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  ROOT_DIR,
  detectCurrentWorktreeName,
  getArgValue,
  hasFlag,
} = require('../../scripts/lib/cli-utils.js');

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function commandSyncBranch(args) {
  const baseBranch = getArgValue(args, '--base');
  const dryRun = hasFlag(args, '--dry-run');
  const positionalArgs = args.filter((arg, index) => {
    if (arg === '--base' || arg === '--dry-run') {
      return false;
    }
    return args[index - 1] !== '--base';
  });
  const worktreeName = positionalArgs[0] || detectCurrentWorktreeName();

  if (!worktreeName) {
    throw new Error('Usage: scripts/<agent> sync-branch [<worktree-name>] [--base <branch>]');
  }

  const worktreePath = path.join(ROOT_DIR, 'workspaces', worktreeName);
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`Worktree not found: workspaces/${worktreeName}`);
  }

  const remoteHead = spawnSync('git', ['-C', worktreePath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  const defaultBase = remoteHead.status === 0
    ? remoteHead.stdout.trim().replace(/^refs\/remotes\/origin\//, '')
    : 'main';
  const targetBase = baseBranch || defaultBase;

  const branchResult = spawnSync('git', ['-C', worktreePath, 'branch', '--show-current'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  const branchName = branchResult.status === 0 ? branchResult.stdout.trim() : 'unknown';

  if (dryRun) {
    console.log(`Would fetch origin in workspaces/${worktreeName}`);
    console.log(`Would rebase ${branchName} onto origin/${targetBase}`);
    return;
  }

  const fetchResult = spawnSync('git', ['-C', worktreePath, 'fetch', 'origin'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (fetchResult.status !== 0) {
    process.exit(fetchResult.status || 1);
  }

  const beforeCountResult = spawnSync('git', ['-C', worktreePath, 'rev-list', '--count', `origin/${targetBase}..HEAD`], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  const beforeCount = beforeCountResult.status === 0 ? beforeCountResult.stdout.trim() : 'unknown';

  const rebaseResult = spawnSync('git', ['-C', worktreePath, 'rebase', `origin/${targetBase}`], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (rebaseResult.status !== 0) {
    console.error(`Rebase stopped due to conflicts in workspaces/${worktreeName}. Resolve them there and continue with git rebase --continue.`);
    process.exit(rebaseResult.status || 1);
  }

  const aheadBehindResult = spawnSync('git', ['-C', worktreePath, 'rev-list', '--left-right', '--count', `origin/${targetBase}...HEAD`], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  let statusSummary = 'unknown';
  if (aheadBehindResult.status === 0) {
    const [behindRaw, aheadRaw] = aheadBehindResult.stdout.trim().split('\t');
    statusSummary = `ahead ${aheadRaw || 0}, behind ${behindRaw || 0} vs origin/${targetBase}`;
  }

  console.log(`Rebased ${branchName} onto origin/${targetBase}`);
  console.log(`Commits replayed: ${beforeCount}`);
  console.log(`Status: ${statusSummary}`);
}

module.exports = {
  commandSyncBranch,
};
