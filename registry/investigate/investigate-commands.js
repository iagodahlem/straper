const fs = require('fs');
const path = require('path');

const {
  ROOT_DIR,
  getArgValue,
  hasFlag,
  runCommand,
  runChecked,
} = require('../../scripts/lib/cli-utils.js');

const INVESTIGATIONS_DIRNAME = 'investigations';
const DEFAULT_CLEAN_AGE_DAYS = 14;
const USAGE_MESSAGE = [
  'Usage: scripts/<agent> investigate <repo> [--branch <name>] [--ref <ref>] [--dry-run]',
  '         scripts/<agent> investigate list',
  '         scripts/<agent> investigate clean [--older-than <days>] [--dry-run]',
].join('\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugifyBranch(branchName) {
  return branchName.replace(/\//g, '--');
}

function repoPathFor(repo) {
  return path.join(ROOT_DIR, 'repos', repo);
}

function investigationsDir() {
  return path.join(ROOT_DIR, INVESTIGATIONS_DIRNAME);
}

function ensureRepoExists(repo) {
  const repoPath = repoPathFor(repo);
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repo not found: repos/${repo}`);
  }
  return repoPath;
}

function shortSha(worktreePath, ref = 'HEAD') {
  return runChecked('git', ['-C', worktreePath, 'rev-parse', '--short', ref]).stdout.trim();
}

function commitDate(worktreePath, ref = 'HEAD') {
  return runChecked('git', ['-C', worktreePath, 'log', '-1', '--format=%cd', '--date=short', ref]).stdout.trim();
}

function currentBranch(worktreePath) {
  const result = runCommand('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']);
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function formatMtimeDate(mtime) {
  return mtime.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Default mode — operate on repos/<repo> directly
// ---------------------------------------------------------------------------

function runDefaultMode(repo, { dryRun }) {
  const repoPath = ensureRepoExists(repo);

  const branchResult = runCommand('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchResult.status !== 0) {
    throw new Error(`Failed to read HEAD in repos/${repo}: ${(branchResult.stderr || '').trim()}`);
  }
  const branch = branchResult.stdout.trim();
  if (branch !== 'main') {
    throw new Error(`repos/${repo} is on ${branch}, expected main. Investigation repos must stay on main — check /workspaces for branch work or use --branch.`);
  }

  const statusResult = runCommand('git', ['-C', repoPath, 'status', '--porcelain']);
  if (statusResult.status !== 0) {
    throw new Error(`Failed to read status in repos/${repo}: ${(statusResult.stderr || '').trim()}`);
  }
  if (statusResult.stdout.trim() !== '') {
    throw new Error(`repos/${repo} has uncommitted changes — refusing to sync. Resolve manually.`);
  }

  if (dryRun) {
    console.log(`Path: ${repoPath}`);
    console.log(`Would run: git -C repos/${repo} fetch origin main`);
    console.log(`Would run: git -C repos/${repo} reset --hard origin/main`);
    return;
  }

  const fetchResult = runCommand('git', ['-C', repoPath, 'fetch', 'origin', 'main'], { stdio: 'inherit' });
  if (fetchResult.status !== 0) {
    process.exit(fetchResult.status || 1);
  }

  const resetResult = runCommand('git', ['-C', repoPath, 'reset', '--hard', 'origin/main'], { stdio: 'inherit' });
  if (resetResult.status !== 0) {
    process.exit(resetResult.status || 1);
  }

  const sha = shortSha(repoPath);
  const date = commitDate(repoPath);

  console.log(`Path: ${repoPath}`);
  console.log(`Ref:  main @ ${sha} (${date})`);
}

// ---------------------------------------------------------------------------
// Branch / ref mode — operate on investigations/<repo>--<slug>
// ---------------------------------------------------------------------------

function fetchRef(repoPath, ref) {
  const direct = runCommand('git', ['-C', repoPath, 'fetch', 'origin', ref], { stdio: 'inherit' });
  if (direct.status === 0) {
    return;
  }

  const fallback = runCommand('git', ['-C', repoPath, 'fetch', 'origin'], { stdio: 'inherit' });
  if (fallback.status !== 0) {
    throw new Error(`Failed to fetch ref "${ref}" from origin in repos/${path.basename(repoPath)}.`);
  }
}

function runBranchOrRefMode(repo, { mode, value, dryRun }) {
  const repoPath = ensureRepoExists(repo);

  if (dryRun) {
    if (mode === 'branch') {
      const slug = slugifyBranch(value);
      const worktreeName = `${repo}--${slug}`;
      const worktreePath = path.join(investigationsDir(), worktreeName);
      console.log(`Path: ${worktreePath}`);
      console.log(`Would run: git -C repos/${repo} fetch origin ${value}`);
      console.log(`Would run: git -C repos/${repo} worktree add --detach ${worktreePath} origin/${value}`);
      return;
    }

    const worktreePath = path.join(investigationsDir(), `${repo}--ref-<shortsha>`);
    console.log(`Path: ${worktreePath}`);
    console.log(`Would run: git -C repos/${repo} fetch origin ${value}`);
    console.log(`Would run: git -C repos/${repo} worktree add --detach ${worktreePath} ${value}`);
    return;
  }

  fetchRef(repoPath, value);

  const target = mode === 'branch' ? `origin/${value}` : value;
  const sha = shortSha(repoPath, target);

  const slug = mode === 'branch'
    ? slugifyBranch(value)
    : `ref-${sha}`;

  const worktreeName = `${repo}--${slug}`;
  const worktreePath = path.join(investigationsDir(), worktreeName);

  fs.mkdirSync(investigationsDir(), { recursive: true });

  if (!fs.existsSync(worktreePath)) {
    const addResult = runCommand(
      'git',
      ['-C', repoPath, 'worktree', 'add', '--detach', worktreePath, target],
      { stdio: 'inherit' },
    );
    if (addResult.status !== 0) {
      process.exit(addResult.status || 1);
    }
  } else {
    const sanityCheck = runCommand('git', ['-C', worktreePath, 'rev-parse', '--is-inside-work-tree']);
    if (sanityCheck.status !== 0) {
      throw new Error(`${worktreePath} exists but is not a git worktree. Remove it manually.`);
    }

    fetchRef(worktreePath, value);

    const checkoutResult = runCommand(
      'git',
      ['-C', worktreePath, 'checkout', '--detach', target],
      { stdio: 'inherit' },
    );
    if (checkoutResult.status !== 0) {
      process.exit(checkoutResult.status || 1);
    }
  }

  const finalSha = shortSha(worktreePath);
  const date = commitDate(worktreePath);
  const label = mode === 'branch' ? value : value;

  console.log(`Path: ${worktreePath}`);
  console.log(`Ref:  ${label} @ ${finalSha} (${date}) (detached)`);
}

// ---------------------------------------------------------------------------
// list subcommand
// ---------------------------------------------------------------------------

function listInvestigations() {
  const dir = investigationsDir();
  if (!fs.existsSync(dir)) {
    console.log('No investigations.');
    return;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (entries.length === 0) {
    console.log('No investigations.');
    return;
  }

  const rows = entries.map((slug) => {
    const entryPath = path.join(dir, slug);
    const repo = slug.split('--')[0];

    let sha = '-';
    let date = '-';
    let ref = '(detached)';

    const shaResult = runCommand('git', ['-C', entryPath, 'rev-parse', '--short', 'HEAD']);
    if (shaResult.status === 0) {
      sha = shaResult.stdout.trim() || '-';
    }

    const dateResult = runCommand('git', ['-C', entryPath, 'log', '-1', '--format=%cd', '--date=short']);
    if (dateResult.status === 0) {
      date = dateResult.stdout.trim() || '-';
    }

    const branch = currentBranch(entryPath);
    if (branch && branch !== 'HEAD' && branch !== 'unknown') {
      ref = branch;
    }

    return { slug, repo, ref, sha, date };
  });

  const headers = { slug: 'SLUG', repo: 'REPO', ref: 'REF', sha: 'SHA', date: 'DATE' };
  const widths = {
    slug: Math.max(headers.slug.length, ...rows.map((row) => row.slug.length)),
    repo: Math.max(headers.repo.length, ...rows.map((row) => row.repo.length)),
    ref: Math.max(headers.ref.length, ...rows.map((row) => row.ref.length)),
    sha: Math.max(headers.sha.length, ...rows.map((row) => row.sha.length)),
    date: Math.max(headers.date.length, ...rows.map((row) => row.date.length)),
  };

  const pad = (value, width) => String(value).padEnd(width, ' ');
  const headerLine = [
    pad(headers.slug, widths.slug),
    pad(headers.repo, widths.repo),
    pad(headers.ref, widths.ref),
    pad(headers.sha, widths.sha),
    pad(headers.date, widths.date),
  ].join('  ');

  console.log(headerLine);
  for (const row of rows) {
    const line = [
      pad(row.slug, widths.slug),
      pad(row.repo, widths.repo),
      pad(row.ref, widths.ref),
      pad(row.sha, widths.sha),
      pad(row.date, widths.date),
    ].join('  ');
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// clean subcommand
// ---------------------------------------------------------------------------

function cleanInvestigations({ olderThanDays, dryRun }) {
  const dir = investigationsDir();
  if (!fs.existsSync(dir)) {
    console.log('Removed 0 investigation(s).');
    return;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (entries.length === 0) {
    console.log('Removed 0 investigation(s).');
    return;
  }

  const now = Date.now();
  const thresholdMs = olderThanDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const slug of entries) {
    const entryPath = path.join(dir, slug);
    let stat;
    try {
      stat = fs.statSync(entryPath);
    } catch (error) {
      continue;
    }

    const age = now - stat.mtimeMs;
    if (age < thresholdMs) {
      continue;
    }

    const repo = slug.split('--')[0];
    const repoPath = repoPathFor(repo);
    const mtimeDate = formatMtimeDate(stat.mtime);

    if (dryRun) {
      console.log(`Would remove: ${slug} (last modified ${mtimeDate})`);
      removed += 1;
      continue;
    }

    if (fs.existsSync(repoPath)) {
      runCommand('git', ['-C', repoPath, 'worktree', 'remove', entryPath, '--force'], { stdio: 'inherit' });
    }

    if (fs.existsSync(entryPath)) {
      fs.rmSync(entryPath, { recursive: true, force: true });
    }

    if (fs.existsSync(repoPath)) {
      runCommand('git', ['-C', repoPath, 'worktree', 'prune'], { stdio: 'inherit' });
    }

    console.log(`Removed: ${slug} (last modified ${mtimeDate})`);
    removed += 1;
  }

  console.log(`Removed ${removed} investigation(s).`);
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

function commandInvestigate(args) {
  const subject = args[0];

  if (!subject) {
    throw new Error(USAGE_MESSAGE);
  }

  const dryRun = hasFlag(args, '--dry-run');

  if (subject === 'list') {
    listInvestigations();
    return;
  }

  if (subject === 'clean') {
    const rawOlderThan = getArgValue(args, '--older-than');
    const olderThanDays = rawOlderThan === null
      ? DEFAULT_CLEAN_AGE_DAYS
      : Number.parseInt(rawOlderThan, 10);
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      throw new Error('--older-than must be a non-negative integer (number of days).');
    }
    cleanInvestigations({ olderThanDays, dryRun });
    return;
  }

  const repo = subject;
  const branchValue = getArgValue(args, '--branch');
  const refValue = getArgValue(args, '--ref');

  if (branchValue !== null && refValue !== null) {
    throw new Error('Cannot combine --branch and --ref. Choose one.');
  }

  if (branchValue !== null) {
    runBranchOrRefMode(repo, { mode: 'branch', value: branchValue, dryRun });
    return;
  }

  if (refValue !== null) {
    runBranchOrRefMode(repo, { mode: 'ref', value: refValue, dryRun });
    return;
  }

  runDefaultMode(repo, { dryRun });
}

module.exports = {
  commandInvestigate,
};
