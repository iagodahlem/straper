const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  ROOT_DIR,
  daysBetween,
  formatDate,
  getAllTasks,
  hasFlag,
  runChecked,
} = require('../../scripts/lib/cli-utils.js');

const {
  getReadySubItems,
  readDesign,
  readDesignIndex,
} = require('../fd/designs.js');

const {
  getDesignTaskIds,
  getWorkersForDesign,
} = require('../fd/fd-commands.js');

// ---------------------------------------------------------------------------
// Session review helpers
// ---------------------------------------------------------------------------

function renderTemplate(templateName, values) {
  const workspaceTemplate = path.join(ROOT_DIR, 'prompts', `${templateName}.md`);
  const moduleTemplate = path.join(__dirname, 'prompts', `${templateName}.md`);
  const templatePath = fs.existsSync(workspaceTemplate) ? workspaceTemplate : moduleTemplate;
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Prompt template not found: ${templateName}.md`);
  }

  let content = fs.readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const renderedValue = String(value ?? '');
    content = content.replaceAll(`{{${key}}}`, renderedValue);
  }

  return content.trim();
}

function buildSessionReviewPrompt(args) {
  const runSessionEnd = hasFlag(args, '--run-session-end');
  const dryRun = hasFlag(args, '--dry-run');

  return renderTemplate('session-review', {
    RUN_SESSION_END: runSessionEnd ? 'yes' : 'no',
    DRY_RUN: dryRun ? 'yes' : 'no',
  });
}

function commandSessionReviewPrompt(args) {
  console.log(buildSessionReviewPrompt(args));
}

function commandSessionReview(args) {
  const dryRun = hasFlag(args, '--dry-run');
  const runSessionEnd = hasFlag(args, '--run-session-end');
  const today = formatDate(new Date());
  const todayMemoryPath = path.join(ROOT_DIR, 'memory', `${today}.md`);
  const tasks = getAllTasks()
    .map(({ task }) => task)
    .filter((task) => task.status !== 'done');
  const designs = readDesignIndex()
    .filter((design) => design.status !== 'archived' && design.status !== 'complete');
  const workspaceStatus = runChecked('git', ['status', '--short']).stdout.trim();
  // Workspace script preferred (this workspace's evolved version); the copy
  // bundled with the worktree module is the fallback for fresh workspaces.
  const workspaceCleanup = path.join(ROOT_DIR, 'scripts', 'cleanup-workspaces.sh');
  const cleanupScript = fs.existsSync(workspaceCleanup)
    ? workspaceCleanup
    : path.join(ROOT_DIR, 'skills', 'worktree', 'cleanup-workspaces.sh');
  const cleanupOutput = runChecked(cleanupScript, ['--dry-run']).stdout.trim();

  console.log(`# Session Review (${today})`);
  console.log('');
  console.log(fs.existsSync(todayMemoryPath) ? `Memory file: memory/${today}.md` : `Memory file missing: memory/${today}.md`);
  console.log('');
  console.log('## Active tasks');

  if (tasks.length === 0) {
    console.log('- No active tasks');
  } else {
    for (const task of tasks) {
      const lastLog = Array.isArray(task.log) && task.log.length > 0 ? task.log[task.log.length - 1] : null;
      const hasTodayLog = Boolean(lastLog && String(lastLog.date).startsWith(today));
      const staleDays = lastLog ? daysBetween(lastLog.date) : null;
      const blockersCount = Array.isArray(task.blockers) ? task.blockers.length : 0;
      const runningWorkers = Array.isArray(task.workers)
        ? task.workers.filter((worker) => worker.status === 'running').length
        : 0;

      let suffix = `status=${task.status}, blockers=${blockersCount}, log_today=${hasTodayLog}`;
      if (task.design) {
        suffix += `, design=${task.design}`;
      }
      if (Array.isArray(task.sub_items) && task.sub_items.length > 0) {
        suffix += `, sub_items=${task.sub_items.join('/')}`;
      }
      if (Array.isArray(task.workers) && task.workers.length > 0) {
        suffix += `, workers=${task.workers.length}, running_workers=${runningWorkers}`;
      }
      if (staleDays !== null) {
        suffix += `, last_log_days_ago=${staleDays}`;
      }
      console.log(`- ${task.id}: ${suffix}`);
    }
  }

  console.log('');
  console.log('## Active feature designs');

  if (designs.length === 0) {
    console.log('- No active feature designs');
  } else {
    for (const designRow of designs) {
      const design = readDesign(designRow.id);
      const doneCount = design.subItems.filter((item) => item.status === 'done').length;
      const totalCount = design.subItems.length;
      const readyCount = getReadySubItems(design).length;
      const linkedWorkers = getWorkersForDesign(tasks, designRow.id, getDesignTaskIds(design));
      console.log(`- ${designRow.id}: status=${designRow.status}, progress=${doneCount}/${totalCount}, ready=${readyCount}, workers=${linkedWorkers.length}, repo=${design.metadata.repo || 'none'}`);
    }
  }

  const activeWorkers = tasks.flatMap((task) => {
    if (!Array.isArray(task.workers)) {
      return [];
    }

    return task.workers
      .filter((worker) => worker.status === 'running' || worker.status === 'blocked')
      .map((worker) => ({
        taskId: task.id,
        design: task.design || 'none',
        ...worker,
      }));
  });

  console.log('');
  console.log('## Active workers');
  if (activeWorkers.length === 0) {
    console.log('- No active workers');
  } else {
    for (const worker of activeWorkers) {
      console.log(`- ${worker.id}: task=${worker.taskId}, design=${worker.design}, sub_item=${worker.sub_item}, provider=${worker.provider}, profile=${worker.profile}, status=${worker.status}`);
    }
  }

  const staleTasks = tasks.filter((task) => {
    const lastLog = Array.isArray(task.log) && task.log.length > 0 ? task.log[task.log.length - 1] : null;
    const staleDays = lastLog ? daysBetween(lastLog.date) : null;
    return staleDays !== null && staleDays >= 3;
  });

  console.log('');
  console.log('## Loose ends');
  console.log(staleTasks.length > 0 ? `- Stale tasks: ${staleTasks.map((task) => task.id).join(', ')}` : '- Stale tasks: none');
  console.log(`- Workspace changes: ${workspaceStatus === '' ? 'clean' : 'present'}`);
  console.log('- Worktree cleanup scan:');
  console.log(cleanupOutput);

  if (workspaceStatus !== '') {
    console.log('');
    console.log('## Workspace git status');
    console.log(workspaceStatus);
  }

  if (runSessionEnd) {
    console.log('');
    if (dryRun) {
      console.log('Would run: ./scripts/session-end.sh');
    } else {
      const result = spawnSync(path.join(ROOT_DIR, 'scripts', 'session-end.sh'), [], {
        cwd: ROOT_DIR,
        encoding: 'utf8',
        stdio: 'inherit',
      });
      if (result.status !== 0) {
        process.exit(result.status || 1);
      }
    }
  } else {
    console.log('');
    console.log('Next: run `./scripts/<agent> session-review --run-session-end` to execute the session-end checklist.');
  }
}

module.exports = {
  commandSessionReview,
  commandSessionReviewPrompt,
};
