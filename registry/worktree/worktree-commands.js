const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  ROOT_DIR,
  getArgValue,
  hasFlag,
} = require('../../scripts/lib/cli-utils.js');

// ---------------------------------------------------------------------------
// Worktree helpers
// ---------------------------------------------------------------------------

function readBranchPrefix() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config', 'workspace.json'), 'utf8'));
    const prefix = config && config.branch_prefix;
    if (typeof prefix === 'string' && prefix.length > 0) {
      return prefix;
    }
  } catch (_err) {
    // Fall through to the generic convention below.
  }
  return null;
}

function sanitizeBranchName(branchName) {
  return branchName.replace(/\//g, '--');
}

function resolveBaseRef(repoPath, baseBranch) {
  if (!baseBranch) {
    const remoteHead = spawnSync('git', ['-C', repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    });

    if (remoteHead.status === 0) {
      const branch = remoteHead.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
      if (branch) {
        return { ref: `origin/${branch}`, label: branch };
      }
    }

    return { ref: 'origin/main', label: 'main' };
  }

  const localCheck = spawnSync('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${baseBranch}`], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  if (localCheck.status === 0) {
    return { ref: baseBranch, label: baseBranch };
  }

  const remoteCheck = spawnSync('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${baseBranch}`], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  if (remoteCheck.status === 0) {
    return { ref: `origin/${baseBranch}`, label: baseBranch };
  }

  throw new Error(`Base branch not found locally or on origin: ${baseBranch}`);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function commandWorktree(args) {
  const repo = args[0];
  const branchName = args[1];
  const baseBranch = getArgValue(args, '--base');
  const dryRun = hasFlag(args, '--dry-run');

  if (!repo || !branchName) {
    throw new Error('Usage: scripts/<agent> worktree <repo> <branch-name> [--base <branch>] [--dry-run]');
  }

  const branchPrefix = readBranchPrefix();
  if (branchPrefix) {
    const escapedPrefix = branchPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^${escapedPrefix}/[A-Za-z0-9._/-]+$`).test(branchName)) {
      throw new Error(`Branch name must follow the \`${branchPrefix}/<feature-name>\` convention.`);
    }
  } else if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._/-]+$/.test(branchName)) {
    throw new Error('Branch name must follow the `<prefix>/<feature-name>` convention.');
  }

  const repoPath = path.join(ROOT_DIR, 'repos', repo);
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repo not found: repos/${repo}`);
  }

  const worktreeName = `${repo}--${sanitizeBranchName(branchName)}`;
  const worktreePath = path.join(ROOT_DIR, 'workspaces', worktreeName);
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Worktree already exists: workspaces/${worktreeName}`);
  }

  const baseRef = resolveBaseRef(repoPath, baseBranch);

  if (dryRun) {
    console.log(`Worktree path: workspaces/${worktreeName}`);
    console.log(`Branch: ${branchName}`);
    console.log(`Base ref: ${baseRef.ref}`);
    console.log(`Command: git -C repos/${repo} worktree add ${worktreePath} -b ${branchName} ${baseRef.ref}`);
    return;
  }

  const fetchResult = spawnSync('git', ['-C', repoPath, 'fetch', 'origin'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (fetchResult.status !== 0) {
    process.exit(fetchResult.status || 1);
  }

  fs.mkdirSync(path.join(ROOT_DIR, 'workspaces'), { recursive: true });

  const addResult = spawnSync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', branchName, baseRef.ref], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (addResult.status !== 0) {
    process.exit(addResult.status || 1);
  }

  console.log(`Worktree path: workspaces/${worktreeName}`);
  console.log(`Branch: ${branchName}`);
  console.log(`Base: ${baseRef.label}`);
  console.log('Reminder: read the repo instruction file (`AGENTS.md` or `CLAUDE.md`) before starting work.');
}

module.exports = {
  commandWorktree,
};
