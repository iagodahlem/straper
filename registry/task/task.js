#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveRepoSlug } = require('../../scripts/lib/cli-utils.js');

const ROOT_DIR = path.resolve(__dirname, '../..');
const TASKS_DIR = path.join(ROOT_DIR, 'tasks');

// Local checkouts to probe for a PR repo's GitHub owner (clean clone first,
// then any matching worktree) so the org isn't hardcoded.
function repoCheckoutCandidates(repo) {
  const candidates = [path.join(ROOT_DIR, 'repos', repo)];
  const workspacesDir = path.join(ROOT_DIR, 'workspaces');
  try {
    for (const entry of fs.readdirSync(workspacesDir)) {
      if (entry.startsWith(`${repo}--`)) {
        candidates.push(path.join(workspacesDir, entry));
      }
    }
  } catch (_) {
    // no workspaces/ dir — clean-clone candidate is enough
  }
  return candidates;
}

const allowedStatus = new Set(['backlog', 'in_progress', 'blocked', 'in_review', 'done']);
const allowedWorkerProvider = new Set(['claude', 'codex']);
const allowedWorkerProfile = new Set(['fast', 'strong']);
const allowedWorkerStatus = new Set(['planned', 'running', 'blocked', 'stopped', 'done', 'failed']);

const allowedTransitions = {
  backlog: new Set(['in_progress', 'blocked', 'done']),
  in_progress: new Set(['blocked', 'in_review', 'done']),
  blocked: new Set(['in_progress', 'in_review', 'done']),
  in_review: new Set(['in_progress', 'blocked', 'done']),
  done: new Set(['in_progress']),
};

function usage() {
  console.error('Usage:');
  console.error('  scripts/task create <title>');
  console.error('  scripts/task list [--status <status>] [--has-blockers]');
  console.error('  scripts/task log <TASK-ID> <message>');
  console.error('  scripts/task status <TASK-ID> <new-status> [--note <message>]');
  console.error('  scripts/task design <TASK-ID> <FD-ID|none> [--note <message>]');
  console.error('  scripts/task sub-item add <TASK-ID> <SUB-ITEM>');
  console.error('  scripts/task sub-item remove <TASK-ID> <SUB-ITEM>');
  console.error('  scripts/task worker set <TASK-ID> <WORKER-ID> [--sub-item <SUB-ITEM>] [--provider <claude|codex>] [--profile <fast|strong>] [--status <planned|running|blocked|stopped|done|failed>] [--repo <repo>] [--branch <branch>] [--worktree <path>] [--model <model>] [--started-at <iso>] [--updated-at <iso>] [--note <message>]');
  console.error('  scripts/task worker remove <TASK-ID> <WORKER-ID> [--note <message>]');
  console.error('  scripts/task blocker add <TASK-ID> <message>');
  console.error('  scripts/task blocker remove <TASK-ID> <message>');
  console.error('  scripts/task sync-prs');
}

function nowIso() {
  return new Date().toISOString();
}

function taskPath(taskId) {
  if (!/^TASK-\d{3}$/.test(taskId)) {
    throw new Error('Task ID must match TASK-###');
  }

  return path.join(TASKS_DIR, `${taskId}.json`);
}

function readTask(taskId) {
  const filePath = taskPath(taskId);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Task file does not exist: tasks/${taskId}.json`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  return { filePath, raw, task: JSON.parse(raw) };
}

function appendLog(task, message) {
  if (!Array.isArray(task.log)) {
    task.log = [];
  }

  task.log.push({
    date: nowIso(),
    entry: message,
  });
}

function validateTaskFile(filePath) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'validate.js'), filePath], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || 'Validation failed');
  }
}

function writeTaskWithValidation(filePath, originalRaw, task) {
  const formatted = `${JSON.stringify(task, null, 2)}\n`;
  fs.writeFileSync(filePath, formatted, 'utf8');

  try {
    validateTaskFile(filePath);
  } catch (error) {
    fs.writeFileSync(filePath, originalRaw, 'utf8');
    throw new Error(`Validation failed after update; reverted file.\n${error.message}`);
  }
}

function sleepMs(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function withFileLock(filePath, callback) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 5000;
  let lockFd = null;

  while (lockFd === null) {
    try {
      lockFd = fs.openSync(lockPath, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST' && Date.now() < deadline) {
        sleepMs(25);
        continue;
      }
      throw new Error(`Unable to acquire task lock for ${path.basename(filePath)}: ${error.message}`);
    }
  }

  try {
    return callback();
  } finally {
    if (lockFd !== null) {
      fs.closeSync(lockFd);
    }
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  }
}

function splitNoteFlag(args) {
  const noteIndex = args.indexOf('--note');
  if (noteIndex === -1) {
    return { positional: args, note: '' };
  }

  const positional = args.slice(0, noteIndex);
  const note = args.slice(noteIndex + 1).join(' ').trim();

  return { positional, note };
}

function getArgValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function updateTask(taskId, mutator) {
  const filePath = taskPath(taskId);
  withFileLock(filePath, () => {
    const raw = fs.readFileSync(filePath, 'utf8');
    const task = JSON.parse(raw);
    mutator(task);
    task.updated_at = nowIso();
    writeTaskWithValidation(filePath, raw, task);
  });
}

function ensureTaskArray(task, key) {
  if (!Array.isArray(task[key])) {
    task[key] = [];
  }
}

function addUniqueString(values, nextValue) {
  if (!nextValue) {
    return;
  }

  if (!values.includes(nextValue)) {
    values.push(nextValue);
  }
}

function ensureBranchRecord(task, repo, branchName) {
  if (!repo || !branchName) {
    return;
  }

  ensureTaskArray(task, 'branches');
  if (!task.branches.some((branch) => branch.repo === repo && branch.name === branchName)) {
    task.branches.push({
      repo,
      name: branchName,
    });
  }
}

function isValidDesignId(value) {
  return /^FD-\d{3}$/.test(value);
}

function isValidSubItem(value) {
  return /^[A-Z]+[0-9]+$/.test(value);
}

function normalizeSubItem(value) {
  return String(value || '').trim().toUpperCase();
}

function parseWorkerValue(args, flag, fallback = undefined) {
  const value = getArgValue(args, flag);
  if (value === null) {
    return fallback;
  }
  return value;
}

function discoverTaskFiles() {
  if (!fs.existsSync(TASKS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(TASKS_DIR)
    .filter((f) => /^TASK-\d{3}\.json$/.test(f))
    .sort();
}

function createTask(title) {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) {
    throw new Error('Title cannot be empty');
  }

  const existingFiles = discoverTaskFiles();

  let nextNum = 1;
  if (existingFiles.length > 0) {
    const lastFile = existingFiles[existingFiles.length - 1];
    const match = lastFile.match(/TASK-(\d{3})/);
    if (match) {
      nextNum = parseInt(match[1], 10) + 1;
    }
  }

  const taskId = `TASK-${String(nextNum).padStart(3, '0')}`;
  const now = nowIso();

  const task = {
    id: taskId,
    title: trimmedTitle,
    status: 'backlog',
    priority: 'medium',
    design: null,
    prs: [],
    branches: [],
    worktrees: [],
    sub_items: [],
    workers: [],
    blockers: [],
    depends_on: [],
    log: [],
    created_at: now,
    updated_at: now,
  };

  const filePath = path.join(TASKS_DIR, `${taskId}.json`);
  const formatted = `${JSON.stringify(task, null, 2)}\n`;
  fs.writeFileSync(filePath, formatted, 'utf8');

  validateTaskFile(filePath);
  console.log(`Created ${taskId}: ${trimmedTitle}`);
}

function listTasks(args) {
  const statusFilter = getArgValue(args, '--status');
  const hasBlockers = args.includes('--has-blockers');

  const files = discoverTaskFiles();

  if (files.length === 0) {
    console.log('No tasks found.');
    return;
  }

  let tasks = files.map((f) => {
    const raw = fs.readFileSync(path.join(TASKS_DIR, f), 'utf8');
    return JSON.parse(raw);
  });

  if (statusFilter) {
    tasks = tasks.filter((t) => t.status === statusFilter);
  }

  if (hasBlockers) {
    tasks = tasks.filter((t) => Array.isArray(t.blockers) && t.blockers.length > 0);
  }

  if (tasks.length === 0) {
    console.log('No tasks match filters.');
    return;
  }

  for (const t of tasks) {
    const prsOpen = (t.prs || []).filter((p) => ['open', 'approved', 'changes_requested'].includes(p.status)).length;
    const blockersCount = (t.blockers || []).length;
    const workerCount = (t.workers || []).length;
    const priority = (t.priority || 'medium').padEnd(8);
    const status = t.status.padEnd(11);

    let suffix = `(${prsOpen} PR${prsOpen !== 1 ? 's' : ''} open`;
    if (blockersCount > 0) {
      suffix += `, ${blockersCount} blocker${blockersCount !== 1 ? 's' : ''}`;
    }
    if (t.design) {
      suffix += `, ${t.design}`;
    }
    if (workerCount > 0) {
      suffix += `, ${workerCount} worker${workerCount !== 1 ? 's' : ''}`;
    }
    suffix += ')';

    console.log(`${t.id}  ${status}  ${priority}  ${t.title} ${suffix}`);
  }
}

function setStatus(taskId, args) {
  const { positional, note } = splitNoteFlag(args);
  if (positional.length < 1) {
    throw new Error('Missing status value');
  }

  const nextStatus = positional[0];
  if (!allowedStatus.has(nextStatus)) {
    throw new Error('Invalid status. Use: backlog, in_progress, blocked, in_review, done');
  }

  const { filePath, raw, task } = readTask(taskId);
  const currentStatus = task.status;

  if (!allowedStatus.has(currentStatus)) {
    throw new Error(`Current status is invalid: ${currentStatus}`);
  }

  if (currentStatus === nextStatus) {
    throw new Error(`Task already in status ${nextStatus}`);
  }

  const validNext = allowedTransitions[currentStatus] || new Set();
  if (!validNext.has(nextStatus)) {
    throw new Error(`Invalid transition: ${currentStatus} -> ${nextStatus}`);
  }

  task.status = nextStatus;
  task.updated_at = nowIso();

  const logMessage = note
    ? `Status changed from ${currentStatus} to ${nextStatus}. ${note}`
    : `Status changed from ${currentStatus} to ${nextStatus}.`;

  appendLog(task, logMessage);
  writeTaskWithValidation(filePath, raw, task);

  console.log(`${taskId}: status ${currentStatus} -> ${nextStatus}`);
}

function setDesign(taskId, args) {
  const { positional, note } = splitNoteFlag(args);
  if (positional.length < 1) {
    throw new Error('Missing design value');
  }

  const rawValue = positional[0];
  const nextDesign = rawValue === 'none' || rawValue === 'null' ? null : rawValue;

  if (nextDesign !== null && !isValidDesignId(nextDesign)) {
    throw new Error('Design ID must match FD-### or use `none` to clear it');
  }

  updateTask(taskId, (task) => {
    const previous = task.design || 'none';
    task.design = nextDesign;
    appendLog(
      task,
      note
        ? `Design link updated from ${previous} to ${nextDesign || 'none'}. ${note}`
        : `Design link updated from ${previous} to ${nextDesign || 'none'}.`,
    );
  });

  console.log(`${taskId}: design ${nextDesign || 'none'}`);
}

function updateSubItem(taskId, action, subItem) {
  const normalizedSubItem = normalizeSubItem(subItem);
  if (!isValidSubItem(normalizedSubItem)) {
    throw new Error('Sub-item must match a feature design sub-item format such as A1');
  }

  updateTask(taskId, (task) => {
    ensureTaskArray(task, 'sub_items');

    if (action === 'add') {
      addUniqueString(task.sub_items, normalizedSubItem);
      appendLog(task, `Sub-item tracked: ${normalizedSubItem}`);
      return;
    }

    if (action === 'remove') {
      const before = task.sub_items.length;
      task.sub_items = task.sub_items.filter((item) => item !== normalizedSubItem);
      appendLog(
        task,
        before === task.sub_items.length
          ? `Sub-item reviewed (not found): ${normalizedSubItem}`
          : `Sub-item removed: ${normalizedSubItem}`,
      );
      return;
    }

    throw new Error('Unknown sub-item action. Use: add | remove');
  });

  console.log(`${taskId}: sub-item ${action} ${normalizedSubItem}`);
}

function setWorker(taskId, workerId, args) {
  const trimmedWorkerId = String(workerId || '').trim();
  if (trimmedWorkerId === '') {
    throw new Error('Worker ID cannot be empty');
  }

  const { positional, note } = splitNoteFlag(args);

  updateTask(taskId, (task) => {
    ensureTaskArray(task, 'workers');
    ensureTaskArray(task, 'sub_items');
    ensureTaskArray(task, 'worktrees');

    const existing = task.workers.find((worker) => worker.id === trimmedWorkerId) || null;
    const timestamp = nowIso();
    const subItem = normalizeSubItem(parseWorkerValue(positional, '--sub-item', existing?.sub_item || ''));
    const provider = parseWorkerValue(positional, '--provider', existing?.provider);
    const profile = parseWorkerValue(positional, '--profile', existing?.profile);
    const status = parseWorkerValue(positional, '--status', existing?.status || 'running');
    const repo = parseWorkerValue(positional, '--repo', existing?.repo);
    const branch = parseWorkerValue(positional, '--branch', existing?.branch);
    const worktree = parseWorkerValue(positional, '--worktree', existing?.worktree);
    const model = parseWorkerValue(positional, '--model', existing?.model ?? null);
    const startedAt = parseWorkerValue(positional, '--started-at', existing?.started_at || timestamp);
    const updatedAt = parseWorkerValue(positional, '--updated-at', timestamp);

    if (!isValidSubItem(subItem)) {
      throw new Error('Worker sub-item must match a feature design sub-item format such as A1');
    }
    if (!allowedWorkerProvider.has(provider)) {
      throw new Error('Worker provider must be one of: claude, codex');
    }
    if (!allowedWorkerProfile.has(profile)) {
      throw new Error('Worker profile must be one of: fast, strong');
    }
    if (!allowedWorkerStatus.has(status)) {
      throw new Error('Worker status must be one of: planned, running, blocked, stopped, done, failed');
    }

    addUniqueString(task.sub_items, subItem);
    if (worktree) {
      addUniqueString(task.worktrees, worktree);
    }
    ensureBranchRecord(task, repo, branch);

    const nextWorker = {
      id: trimmedWorkerId,
      sub_item: subItem,
      provider,
      profile,
      status,
      started_at: startedAt,
      updated_at: updatedAt,
    };

    if (repo) {
      nextWorker.repo = repo;
    }
    if (branch) {
      nextWorker.branch = branch;
    }
    if (worktree) {
      nextWorker.worktree = worktree;
    }
    if (model !== undefined) {
      nextWorker.model = model;
    }

    const index = task.workers.findIndex((worker) => worker.id === trimmedWorkerId);
    if (index === -1) {
      task.workers.push(nextWorker);
    } else {
      task.workers[index] = nextWorker;
    }

    appendLog(
      task,
      note
        ? `Worker ${trimmedWorkerId} set for ${subItem} (${provider}/${profile}, status=${status}). ${note}`
        : `Worker ${trimmedWorkerId} set for ${subItem} (${provider}/${profile}, status=${status}).`,
    );
  });

  console.log(`${taskId}: worker set ${trimmedWorkerId}`);
}

function removeWorker(taskId, workerId, args) {
  const trimmedWorkerId = String(workerId || '').trim();
  if (trimmedWorkerId === '') {
    throw new Error('Worker ID cannot be empty');
  }

  const { note } = splitNoteFlag(args);

  updateTask(taskId, (task) => {
    ensureTaskArray(task, 'workers');
    const before = task.workers.length;
    task.workers = task.workers.filter((worker) => worker.id !== trimmedWorkerId);
    appendLog(
      task,
      before === task.workers.length
        ? `Worker reviewed (not found): ${trimmedWorkerId}${note ? `. ${note}` : ''}`
        : `Worker removed: ${trimmedWorkerId}${note ? `. ${note}` : ''}`,
    );
  });

  console.log(`${taskId}: worker remove ${trimmedWorkerId}`);
}

function addLog(taskId, message) {
  const entry = message.trim();
  if (entry.length === 0) {
    throw new Error('Log message cannot be empty');
  }

  updateTask(taskId, (task) => {
    appendLog(task, entry);
  });
  console.log(`${taskId}: appended log entry`);
}

function addBlocker(taskId, blocker) {
  const value = blocker.trim();
  if (value.length === 0) {
    throw new Error('Blocker message cannot be empty');
  }

  updateTask(taskId, (task) => {
    if (!Array.isArray(task.blockers)) {
      task.blockers = [];
    }

    if (!task.blockers.includes(value)) {
      task.blockers.push(value);
      appendLog(task, `Blocker added: ${value}`);
    } else {
      appendLog(task, `Blocker reviewed (already present): ${value}`);
    }
  });

  console.log(`${taskId}: blocker updated`);
}

function removeBlocker(taskId, blocker) {
  const value = blocker.trim();
  if (value.length === 0) {
    throw new Error('Blocker message cannot be empty');
  }

  updateTask(taskId, (task) => {
    if (!Array.isArray(task.blockers)) {
      task.blockers = [];
    }

    const before = task.blockers.length;
    task.blockers = task.blockers.filter((item) => item !== value);
    const after = task.blockers.length;

    if (after === before) {
      appendLog(task, `Blocker reviewed (not found): ${value}`);
    } else {
      appendLog(task, `Blocker removed: ${value}`);
    }
  });

  console.log(`${taskId}: blocker updated`);
}

function ghReady() {
  const version = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) {
    return false;
  }
  const auth = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
  return auth.status === 0;
}

// Refresh PR statuses on non-done tasks from GitHub. Folds in the former
// scripts/sync-pr-status.sh: for each open/approved/changes_requested PR, query
// gh and map state + reviewDecision to our status vocabulary, writing through
// the validated, file-locked update path.
function syncPrStatuses() {
  if (!ghReady()) {
    console.log('gh CLI not found or not authenticated. Skipping PR sync.');
    return;
  }

  let updated = 0;
  const warnedRepos = new Set();

  for (const file of discoverTaskFiles()) {
    const taskId = file.replace(/\.json$/, '');
    let task;
    try {
      task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
    } catch (error) {
      continue;
    }

    if (task.status === 'done') continue;
    const prs = Array.isArray(task.prs) ? task.prs : [];
    if (prs.length === 0) continue;

    const changes = [];
    prs.forEach((pr, index) => {
      const number = pr.number;
      const repo = pr.repo;
      const current = pr.status;
      if (number === null || number === undefined || number === '') return;
      if (current === 'merged' || current === 'closed') return;

      const repoSlug = resolveRepoSlug(repo, repoCheckoutCandidates(repo));
      if (!repoSlug) {
        if (!warnedRepos.has(repo)) {
          warnedRepos.add(repo);
          console.log(`Skipping PR sync for ${repo}: no local checkout to derive its GitHub org.`);
        }
        return;
      }

      const res = spawnSync(
        'gh',
        ['pr', 'view', String(number), '--repo', repoSlug, '--json', 'state,reviewDecision',
          '--jq', '.state + "|" + (.reviewDecision // "")'],
        { encoding: 'utf8' },
      );
      if (res.status !== 0) return;

      const [state, review] = (res.stdout || '').trim().split('|');
      let next = current;
      if (state === 'MERGED') next = 'merged';
      else if (state === 'CLOSED') next = 'closed';
      else if (state === 'OPEN') {
        if (review === 'APPROVED') next = 'approved';
        else if (review === 'CHANGES_REQUESTED') next = 'changes_requested';
        else next = 'open';
      }

      if (next !== current) {
        changes.push({ index, next, number, repo, current });
      }
    });

    if (changes.length > 0) {
      updateTask(taskId, (t) => {
        for (const change of changes) {
          if (Array.isArray(t.prs) && t.prs[change.index]) {
            t.prs[change.index].status = change.next;
          }
        }
      });
      for (const change of changes) {
        console.log(`  ${taskId}: PR #${change.number} (${change.repo}) ${change.current} -> ${change.next}`);
        updated += 1;
      }
    }
  }

  console.log(updated === 0 ? 'All PR statuses up to date.' : `Updated ${updated} PR status(es).`);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'create': {
        const title = args.slice(1).join(' ');
        if (!title) {
          usage();
          process.exit(1);
        }
        createTask(title);
        break;
      }

      case 'list': {
        listTasks(args.slice(1));
        break;
      }

      case 'log': {
        const taskId = args[1];
        const message = args.slice(2).join(' ');
        if (!taskId || !message) {
          usage();
          process.exit(1);
        }
        addLog(taskId, message);
        break;
      }

      case 'status': {
        const taskId = args[1];
        const rest = args.slice(2);
        if (!taskId || rest.length === 0) {
          usage();
          process.exit(1);
        }
        setStatus(taskId, rest);
        break;
      }

      case 'design': {
        const taskId = args[1];
        const rest = args.slice(2);
        if (!taskId || rest.length === 0) {
          usage();
          process.exit(1);
        }
        setDesign(taskId, rest);
        break;
      }

      case 'sub-item': {
        const action = args[1];
        const taskId = args[2];
        const subItem = args[3];
        if (!action || !taskId || !subItem) {
          usage();
          process.exit(1);
        }
        updateSubItem(taskId, action, subItem);
        break;
      }

      case 'worker': {
        const action = args[1];
        const taskId = args[2];
        const workerId = args[3];
        const rest = args.slice(4);
        if (!action || !taskId || !workerId) {
          usage();
          process.exit(1);
        }

        if (action === 'set') {
          setWorker(taskId, workerId, rest);
        } else if (action === 'remove') {
          removeWorker(taskId, workerId, rest);
        } else {
          throw new Error('Unknown worker action. Use: set | remove');
        }
        break;
      }

      case 'blocker': {
        const action = args[1];
        const taskId = args[2];
        const message = args.slice(3).join(' ');
        if (!action || !taskId || !message) {
          usage();
          process.exit(1);
        }

        if (action === 'add') {
          addBlocker(taskId, message);
        } else if (action === 'remove') {
          removeBlocker(taskId, message);
        } else {
          throw new Error('Unknown blocker action. Use: add | remove');
        }

        break;
      }

      case 'sync-prs': {
        syncPrStatuses();
        break;
      }

      default:
        usage();
        process.exit(1);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

main();
