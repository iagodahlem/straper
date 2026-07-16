const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const TASKS_DIR = path.join(ROOT_DIR, 'tasks');

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function getArgValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return null;
  }
  return args[index + 1];
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function stripFlagArgs(args, flagsWithValues = [], booleanFlags = []) {
  return args.filter((arg, index) => {
    if (booleanFlags.includes(arg) || flagsWithValues.includes(arg)) {
      return false;
    }

    return !flagsWithValues.includes(args[index - 1]);
  });
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function runCommand(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    ...options,
  });
}

function runChecked(command, commandArgs, options = {}) {
  const result = runCommand(command, commandArgs, options);
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || `Command failed: ${command} ${commandArgs.join(' ')}`);
  }
  return result;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Date/time helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysBetween(olderDateIso, newerDate = new Date()) {
  if (!olderDateIso) {
    return null;
  }

  const older = new Date(olderDateIso);
  if (Number.isNaN(older.getTime())) {
    return null;
  }

  const diffMs = newerDate.getTime() - older.getTime();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Task helpers
// ---------------------------------------------------------------------------

function getAllTasks() {
  if (!fs.existsSync(TASKS_DIR)) {
    return [];
  }

  return fs.readdirSync(TASKS_DIR)
    .filter((file) => /^TASK-\d{3}\.json$/.test(file))
    .sort()
    .map((file) => {
      const filePath = path.join(TASKS_DIR, file);
      return {
        filePath,
        task: JSON.parse(fs.readFileSync(filePath, 'utf8')),
      };
    });
}

function extractRepoNameFromWorktree(worktreeName) {
  if (worktreeName.includes('--')) {
    return worktreeName.split('--')[0];
  }

  return worktreeName.split('-')[0];
}

function findLinkedTasks(repoName, branchName, worktreeName) {
  const worktreeRef = `workspaces/${worktreeName}`;

  return getAllTasks().filter(({ task }) => {
    const matchesWorktree = Array.isArray(task.worktrees) && task.worktrees.includes(worktreeRef);
    const matchesBranch = Array.isArray(task.branches) && task.branches.some((branch) => branch.repo === repoName && branch.name === branchName);
    return matchesWorktree || matchesBranch;
  });
}

// ---------------------------------------------------------------------------
// Worktree / git helpers
// ---------------------------------------------------------------------------

function detectCurrentWorktreeName() {
  const workspacesDir = path.join(ROOT_DIR, 'workspaces');
  const relative = path.relative(workspacesDir, process.cwd());
  if (relative === '' || relative.startsWith('..')) {
    return null;
  }

  return relative.split(path.sep)[0];
}

function defaultBaseBranchForWorktree(worktreePath) {
  const remoteHead = runCommand('git', ['-C', worktreePath, 'symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (remoteHead.status === 0) {
    const branch = remoteHead.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
    if (branch) {
      return branch;
    }
  }
  return 'main';
}

function getGitOutput(worktreePath, args) {
  return runChecked('git', ['-C', worktreePath, ...args]).stdout.trim();
}

// Parse a GitHub remote URL (ssh, https, or scp-style) into an "owner/repo"
// slug. Returns null when the URL is not a recognizable GitHub remote.
function parseGitHubSlug(remoteUrl) {
  if (!remoteUrl) {
    return null;
  }
  const match = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

// Resolve the "owner/repo" slug for a gh invocation by reading a local
// checkout's origin remote, so the org is never hardcoded. `repo` may already
// be a slug (returned as-is). `candidateDirs` are checkout paths to probe in
// order. Returns null when no owner can be derived — callers pick the fallback.
function resolveRepoSlug(repo, candidateDirs = []) {
  if (!repo) {
    return null;
  }
  if (repo.includes('/')) {
    return repo;
  }
  for (const dir of candidateDirs) {
    if (!dir) {
      continue;
    }
    const res = runCommand('git', ['-C', dir, 'remote', 'get-url', 'origin']);
    if (res.status === 0) {
      const slug = parseGitHubSlug(res.stdout);
      if (slug) {
        return `${slug.split('/')[0]}/${repo}`;
      }
    }
  }
  return null;
}

module.exports = {
  ROOT_DIR,
  TASKS_DIR,
  daysBetween,
  defaultBaseBranchForWorktree,
  detectCurrentWorktreeName,
  extractRepoNameFromWorktree,
  findLinkedTasks,
  formatDate,
  getAllTasks,
  getArgValue,
  getGitOutput,
  hasFlag,
  nowIso,
  parseGitHubSlug,
  resolveRepoSlug,
  runChecked,
  runCommand,
  shellQuote,
  stripFlagArgs,
};
