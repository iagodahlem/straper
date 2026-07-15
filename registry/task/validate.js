#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');
const TASKS_DIR = path.join(ROOT_DIR, 'tasks');

const allowedStatus = new Set(['backlog', 'in_progress', 'blocked', 'in_review', 'done']);
const allowedPriority = new Set(['low', 'medium', 'high', 'critical']);
const allowedPrStatus = new Set(['draft', 'open', 'approved', 'changes_requested', 'merged', 'closed']);
const allowedWorkerProvider = new Set(['claude', 'codex']);
const allowedWorkerProfile = new Set(['fast', 'strong']);
const allowedWorkerStatus = new Set(['planned', 'running', 'blocked', 'stopped', 'done', 'failed']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidDateTime(value) {
  if (typeof value !== 'string') {
    return false;
  }

  if (!value.includes('T')) {
    return false;
  }

  const parsed = Date.parse(value);
  return !Number.isNaN(parsed);
}

function validateTask(task, filePath) {
  const errors = [];

  if (!isPlainObject(task)) {
    return ['root must be an object'];
  }

  const fileName = path.basename(filePath, '.json');

  const requiredFields = ['id', 'title', 'status', 'created_at', 'updated_at'];
  for (const field of requiredFields) {
    if (!(field in task)) {
      errors.push(`missing required field \`${field}\``);
    }
  }

  if (typeof task.id !== 'string' || !/^TASK-\d{3}$/.test(task.id)) {
    errors.push('`id` must match TASK-###');
  }

  if (typeof task.id === 'string' && task.id !== fileName) {
    errors.push(`filename mismatch: expected ${task.id}.json`);
  }

  if (typeof task.title !== 'string' || task.title.trim() === '') {
    errors.push('`title` must be a non-empty string');
  }

  if (!allowedStatus.has(task.status)) {
    errors.push('`status` must be one of: backlog, in_progress, blocked, in_review, done');
  }

  if (task.priority !== undefined && !allowedPriority.has(task.priority)) {
    errors.push('`priority` must be one of: low, medium, high, critical');
  }

  if (task.linear_ticket !== undefined && typeof task.linear_ticket !== 'string') {
    errors.push('`linear_ticket` must be a string when present');
  }

  if (task.design !== undefined && task.design !== null) {
    if (typeof task.design !== 'string' || !/^FD-\d{3}$/.test(task.design)) {
      errors.push('`design` must match FD-### format or be null');
    }
  }

  if (task.depends_on !== undefined) {
    if (!Array.isArray(task.depends_on)) {
      errors.push('`depends_on` must be an array');
    } else {
      task.depends_on.forEach((dep, index) => {
        if (typeof dep !== 'string' || !/^TASK-\d{3}$/.test(dep)) {
          errors.push(`depends_on[${index}] must match TASK-### format`);
        }
      });
    }
  }

  if (task.sub_items !== undefined) {
    if (!Array.isArray(task.sub_items)) {
      errors.push('`sub_items` must be an array');
    } else {
      task.sub_items.forEach((subItem, index) => {
        if (typeof subItem !== 'string' || !/^[A-Z]+[0-9]+$/.test(subItem)) {
          errors.push(`sub_items[${index}] must match a feature design sub-item format such as A1`);
        }
      });
    }
  }

  if (!isValidDateTime(task.created_at)) {
    errors.push('`created_at` must be a valid date-time string');
  }

  if (!isValidDateTime(task.updated_at)) {
    errors.push('`updated_at` must be a valid date-time string');
  }

  if (isValidDateTime(task.created_at) && isValidDateTime(task.updated_at)) {
    if (Date.parse(task.updated_at) < Date.parse(task.created_at)) {
      errors.push('`updated_at` cannot be earlier than `created_at`');
    }
  }

  if (task.prs !== undefined) {
    if (!Array.isArray(task.prs)) {
      errors.push('`prs` must be an array');
    } else {
      task.prs.forEach((pr, index) => {
        if (!isPlainObject(pr)) {
          errors.push(`prs[${index}] must be an object`);
          return;
        }

        if (typeof pr.repo !== 'string' || pr.repo.trim() === '') {
          errors.push(`prs[${index}].repo must be a non-empty string`);
        }

        const numberValid = pr.number === null || (Number.isInteger(pr.number) && pr.number > 0);
        if (!numberValid) {
          errors.push(`prs[${index}].number must be a positive integer or null`);
        }

        if (!allowedPrStatus.has(pr.status)) {
          errors.push(`prs[${index}].status must be one of: draft, open, approved, changes_requested, merged, closed`);
        }
      });
    }
  }

  if (task.branches !== undefined) {
    if (!Array.isArray(task.branches)) {
      errors.push('`branches` must be an array');
    } else {
      task.branches.forEach((branch, index) => {
        if (!isPlainObject(branch)) {
          errors.push(`branches[${index}] must be an object`);
          return;
        }

        if (typeof branch.repo !== 'string' || branch.repo.trim() === '') {
          errors.push(`branches[${index}].repo must be a non-empty string`);
        }

        if (typeof branch.name !== 'string' || branch.name.trim() === '') {
          errors.push(`branches[${index}].name must be a non-empty string`);
        }
      });
    }
  }

  if (task.workers !== undefined) {
    if (!Array.isArray(task.workers)) {
      errors.push('`workers` must be an array');
    } else {
      task.workers.forEach((worker, index) => {
        if (!isPlainObject(worker)) {
          errors.push(`workers[${index}] must be an object`);
          return;
        }

        if (typeof worker.id !== 'string' || worker.id.trim() === '') {
          errors.push(`workers[${index}].id must be a non-empty string`);
        }

        if (typeof worker.sub_item !== 'string' || !/^[A-Z]+[0-9]+$/.test(worker.sub_item)) {
          errors.push(`workers[${index}].sub_item must match a feature design sub-item format such as A1`);
        }

        if (!allowedWorkerProvider.has(worker.provider)) {
          errors.push(`workers[${index}].provider must be one of: claude, codex`);
        }

        if (!allowedWorkerProfile.has(worker.profile)) {
          errors.push(`workers[${index}].profile must be one of: fast, strong`);
        }

        if (!allowedWorkerStatus.has(worker.status)) {
          errors.push(`workers[${index}].status must be one of: planned, running, blocked, stopped, done, failed`);
        }

        ['repo', 'branch', 'worktree'].forEach((field) => {
          if (worker[field] !== undefined && (typeof worker[field] !== 'string' || worker[field].trim() === '')) {
            errors.push(`workers[${index}].${field} must be a non-empty string when present`);
          }
        });

        if (worker.model !== undefined && worker.model !== null && typeof worker.model !== 'string') {
          errors.push(`workers[${index}].model must be a string or null when present`);
        }

        if (!isValidDateTime(worker.started_at)) {
          errors.push(`workers[${index}].started_at must be a valid date-time string`);
        }

        if (!isValidDateTime(worker.updated_at)) {
          errors.push(`workers[${index}].updated_at must be a valid date-time string`);
        }

        if (isValidDateTime(worker.started_at) && isValidDateTime(worker.updated_at)) {
          if (Date.parse(worker.updated_at) < Date.parse(worker.started_at)) {
            errors.push(`workers[${index}].updated_at cannot be earlier than started_at`);
          }
        }
      });
    }
  }

  if (task.worktrees !== undefined) {
    if (!Array.isArray(task.worktrees)) {
      errors.push('`worktrees` must be an array');
    } else {
      task.worktrees.forEach((worktree, index) => {
        if (typeof worktree !== 'string' || worktree.trim() === '') {
          errors.push(`worktrees[${index}] must be a non-empty string`);
        }
      });
    }
  }

  if (task.blockers !== undefined) {
    if (!Array.isArray(task.blockers)) {
      errors.push('`blockers` must be an array');
    } else {
      task.blockers.forEach((blocker, index) => {
        if (typeof blocker !== 'string' || blocker.trim() === '') {
          errors.push(`blockers[${index}] must be a non-empty string`);
        }
      });
    }
  }

  if (task.log !== undefined) {
    if (!Array.isArray(task.log)) {
      errors.push('`log` must be an array');
    } else {
      let previousDate = null;

      task.log.forEach((entry, index) => {
        if (!isPlainObject(entry)) {
          errors.push(`log[${index}] must be an object`);
          return;
        }

        if (!isValidDateTime(entry.date)) {
          errors.push(`log[${index}].date must be a valid date-time string`);
        }

        if (typeof entry.entry !== 'string' || entry.entry.trim() === '') {
          errors.push(`log[${index}].entry must be a non-empty string`);
        }

        if (isValidDateTime(entry.date)) {
          const currentDate = Date.parse(entry.date);
          if (previousDate !== null && currentDate < previousDate) {
            errors.push('`log` entries must be chronological');
          }
          previousDate = currentDate;
        }
      });
    }
  }

  if (task.context !== undefined && typeof task.context !== 'string') {
    errors.push('`context` must be a string when present');
  }

  return errors;
}

function discoverTaskFiles() {
  if (!fs.existsSync(TASKS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(TASKS_DIR)
    .filter((file) => /^TASK-\d{3}\.json$/.test(file))
    .sort()
    .map((file) => path.join(TASKS_DIR, file));
}

function resolveInputFiles(rawArgs) {
  if (rawArgs.length === 0) {
    return discoverTaskFiles();
  }

  return rawArgs.map((arg) => {
    if (path.isAbsolute(arg)) {
      return arg;
    }
    return path.join(ROOT_DIR, arg);
  });
}

function main() {
  const files = resolveInputFiles(process.argv.slice(2));

  if (files.length === 0) {
    console.log('No task files found to validate.');
    return;
  }

  let hasErrors = false;
  let validatedCount = 0;

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) {
      hasErrors = true;
      console.error(`[FAIL] ${path.relative(ROOT_DIR, filePath)}: file does not exist`);
      continue;
    }

    const relative = path.relative(ROOT_DIR, filePath);
    let task;

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      task = JSON.parse(raw);
    } catch (error) {
      hasErrors = true;
      console.error(`[FAIL] ${relative}: invalid JSON (${error.message})`);
      continue;
    }

    const errors = validateTask(task, filePath);

    if (errors.length > 0) {
      hasErrors = true;
      console.error(`[FAIL] ${relative}`);
      for (const error of errors) {
        console.error(`  - ${error}`);
      }
      continue;
    }

    validatedCount += 1;
  }

  if (hasErrors) {
    process.exitCode = 1;
    return;
  }

  console.log(`Validated ${validatedCount} task file(s): OK`);
}

if (require.main === module) {
  main();
}
