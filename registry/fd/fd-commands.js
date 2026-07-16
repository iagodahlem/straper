const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  DESIGNS_DIR,
  ROOT_DIR,
  TASKS_DIR,
  extractSection,
  extractSubItemSection,
  getReadySubItems,
  readDesign,
  readDesignIndex,
  readTask,
} = require('./designs.js');

const SKILL_DIR = __dirname;
const PROVIDERS_CONFIG_PATH = path.join(ROOT_DIR, 'config', 'providers.json');
const DEFAULT_PROVIDER_CONFIG = {
  providers: {
    claude: {
      command: 'claude',
      profiles: {
        fast: { model: 'sonnet' },
        strong: { model: 'opus' },
      },
    },
    codex: {
      command: 'codex',
      profiles: {
        fast: { model: '' },
        strong: { model: '' },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Shared helpers (used by FD commands only)
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

function runCommand(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    ...options,
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellJoin(parts) {
  return parts.map((part) => shellQuote(part)).join(' ');
}

function formatHintLine(label, value) {
  return value ? `- ${label}: \`${value}\`` : `- ${label}: none`;
}

function loadProviderConfig() {
  let configured = {};
  if (fs.existsSync(PROVIDERS_CONFIG_PATH)) {
    configured = JSON.parse(fs.readFileSync(PROVIDERS_CONFIG_PATH, 'utf8'));
  }

  const nextConfig = {
    providers: {},
  };

  for (const provider of Object.keys(DEFAULT_PROVIDER_CONFIG.providers)) {
    const defaultProvider = DEFAULT_PROVIDER_CONFIG.providers[provider];
    const configuredProvider = configured.providers?.[provider] || {};
    nextConfig.providers[provider] = {
      command: configuredProvider.command || defaultProvider.command,
      profiles: {
        fast: {
          model: configuredProvider.profiles?.fast?.model ?? defaultProvider.profiles.fast.model,
        },
        strong: {
          model: configuredProvider.profiles?.strong?.model ?? defaultProvider.profiles.strong.model,
        },
      },
    };
  }

  return nextConfig;
}

function getProviderEntry(provider) {
  const config = loadProviderConfig();
  const entry = config.providers?.[provider];
  if (!entry) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return entry;
}

function nowIso() {
  return new Date().toISOString();
}

function sleepMs(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function withTaskFileLock(filePath, callback) {
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

function updateTaskFile(filePath, updater) {
  withTaskFileLock(filePath, () => {
    const originalRaw = fs.readFileSync(filePath, 'utf8');
    const nextTask = updater(JSON.parse(originalRaw));
    fs.writeFileSync(filePath, `${JSON.stringify(nextTask, null, 2)}\n`, 'utf8');

    const validation = runCommand(process.execPath, [path.join(ROOT_DIR, 'skills', 'task', 'validate.js'), filePath]);
    if (validation.status !== 0) {
      fs.writeFileSync(filePath, originalRaw, 'utf8');
      const output = [validation.stdout, validation.stderr].filter(Boolean).join('\n').trim();
      throw new Error(output || `Task validation failed for ${path.basename(filePath)}`);
    }
  });
}

function renderTable(rows) {
  const columnWidths = rows[0].map((_, columnIndex) =>
    Math.max(...rows.map((row) => (row[columnIndex] || '').length))
  );

  return rows
    .map((row, rowIndex) => {
      const padded = row.map((cell, columnIndex) => (cell || '').padEnd(columnWidths[columnIndex]));
      const line = `| ${padded.join(' | ')} |`;

      if (rowIndex === 0) {
        const separator = `| ${columnWidths.map((width) => '-'.repeat(width)).join(' | ')} |`;
        return `${line}\n${separator}`;
      }

      return line;
    })
    .join('\n');
}

function renderTemplate(templateName, values) {
  const templatePath = path.join(SKILL_DIR, 'prompts', `${templateName}.md`);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Prompt template not found: skills/fd/prompts/${templateName}.md`);
  }

  let content = fs.readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const renderedValue = String(value ?? '');
    content = content.replaceAll(`{{${key}}}`, renderedValue);
  }

  return content.trim();
}

function quoteYamlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function replaceFrontmatterLine(content, key, nextValue) {
  const pattern = new RegExp(`^${key}:.*$`, 'm');
  if (!pattern.test(content)) {
    throw new Error(`Missing frontmatter key: ${key}`);
  }

  return content.replace(pattern, `${key}: ${nextValue}`);
}

// ---------------------------------------------------------------------------
// FD helpers
// ---------------------------------------------------------------------------

function getDesignTaskIds(design) {
  return Array.isArray(design.metadata?.tasks) ? design.metadata.tasks : [];
}

function getWorkersForDesign(tasks, fdId, designTaskIds = []) {
  return tasks.flatMap((task) => {
    const isLinkedDesign = task.design === fdId || designTaskIds.includes(task.id);
    if (!isLinkedDesign || !Array.isArray(task.workers)) {
      return [];
    }
    return task.workers.map((worker) => ({
      taskId: task.id,
      ...worker,
    }));
  });
}

function getNextFdId() {
  // Scan FD-NNN.md filenames in BOTH designs/ and designs/archive/ so an
  // archived id can never be reissued (INDEX.md only lists active designs,
  // which is how FD-003 once collided with an archived Straper FD-003).
  const dirs = [DESIGNS_DIR, path.join(DESIGNS_DIR, 'archive')];
  const maxId = dirs.reduce((highest, dir) => {
    if (!fs.existsSync(dir)) {
      return highest;
    }
    return fs.readdirSync(dir).reduce((dirHighest, name) => {
      const match = name.match(/^FD-(\d+)\.md$/);
      if (!match) {
        return dirHighest;
      }
      return Math.max(dirHighest, Number.parseInt(match[1], 10));
    }, highest);
  }, 0);

  return `FD-${String(maxId + 1).padStart(3, '0')}`;
}

function parseFdNewArgs(args) {
  const flagsWithValues = [
    '--effort',
    '--priority',
    '--repo',
    '--provider-hint',
    '--profile-hint',
    '--branch-suffix',
    '--verification-command',
  ];
  const booleanFlags = ['--dry-run'];
  return {
    title: stripFlagArgs(args, flagsWithValues, booleanFlags).join(' ').trim(),
    effort: getArgValue(args, '--effort') || 'medium',
    priority: getArgValue(args, '--priority') || 'medium',
    repo: getArgValue(args, '--repo') || '',
    providerHint: getArgValue(args, '--provider-hint') || '',
    profileHint: getArgValue(args, '--profile-hint') || '',
    branchSuffix: getArgValue(args, '--branch-suffix') || '',
    verificationCommand: getArgValue(args, '--verification-command') || '',
    dryRun: hasFlag(args, '--dry-run'),
  };
}

function validateFdNewArgs({ title, effort, priority, providerHint, profileHint }) {
  if (title === '') {
    throw new Error('Usage: scripts/<agent> fd-new <title> [--effort <small|medium|large>] [--priority <low|medium|high|critical>] [--repo <repo>] [--provider-hint <provider>] [--profile-hint <profile>] [--branch-suffix <suffix>] [--verification-command <command>] [--dry-run]');
  }

  if (!['small', 'medium', 'large'].includes(effort)) {
    throw new Error('Effort must be one of: small, medium, large');
  }

  if (!['low', 'medium', 'high', 'critical'].includes(priority)) {
    throw new Error('Priority must be one of: low, medium, high, critical');
  }

  if (providerHint && !['claude', 'codex'].includes(providerHint)) {
    throw new Error('Provider hint must be one of: claude, codex');
  }

  if (profileHint && !['fast', 'strong'].includes(profileHint)) {
    throw new Error('Profile hint must be one of: fast, strong');
  }
}

function buildFdNewPrompt(args) {
  const parsed = parseFdNewArgs(args);
  validateFdNewArgs(parsed);

  return renderTemplate('fd-new', {
    TITLE: parsed.title,
    EFFORT: parsed.effort,
    PRIORITY: parsed.priority,
    REPO_LINE: formatHintLine('Repo hint', parsed.repo),
    PROVIDER_HINT_LINE: formatHintLine('Provider hint', parsed.providerHint),
    PROFILE_HINT_LINE: formatHintLine('Profile hint', parsed.profileHint),
    BRANCH_SUFFIX_LINE: formatHintLine('Branch suffix', parsed.branchSuffix),
    VERIFICATION_COMMAND_LINE: formatHintLine('Verification command', parsed.verificationCommand),
  });
}

function buildFdTaskTrackingSection(taskIds, fdId, subItem, provider, profile) {
  if (taskIds.length === 0) {
    return 'Task tracking: no linked tasks recorded.';
  }

  const workerId = `worker-${fdId.toLowerCase()}-${subItem.toLowerCase()}-<name>`;
  const commands = taskIds.flatMap((taskId) => ([
    `- \`${shellJoin(['./scripts/task', 'design', taskId, fdId])}\``,
    `- \`${shellJoin(['./scripts/task', 'sub-item', 'add', taskId, subItem])}\``,
    `- \`${shellJoin(['./scripts/task', 'worker', 'set', taskId, workerId, '--sub-item', subItem, '--provider', provider || '<provider>', '--profile', profile || '<profile>', '--repo', '<repo>', '--branch', '<branch>', '--worktree', 'workspaces/<worktree-name>', '--status', 'running'])}\``,
  ]));

  return [
    'Task tracking:',
    `- Linked tasks: ${taskIds.join(', ')}`,
    '- When repo/branch/worktree are known, record them with:',
    ...commands,
  ].join('\n');
}

function buildFdWorkPrompt(fdId, subItem, options = {}) {
  const { baseBranch = '', provider = '', profile = '' } = options;
  const design = readDesign(fdId);
  const targetSubItem = design.subItems.find((item) => item.step === subItem);
  if (!targetSubItem) {
    throw new Error(`${subItem} not found in designs/${fdId}.md`);
  }

  const subItemSection = extractSubItemSection(design.body, subItem) || `### ${subItem}\n\nNo dedicated sub-item section found. Use the sub-item table and the rest of the design as the source of truth.`;
  const baseBranchLine = baseBranch
    ? `- Base branch override: \`${baseBranch}\``
    : '- Base branch override: none';

  const prompt = renderTemplate('fd-work', {
    FD_ID: fdId,
    FD_FILE: path.relative(ROOT_DIR, design.path),
    SUB_ITEM: subItem,
    SUB_ITEM_LABEL: targetSubItem.what,
    SUB_ITEM_DEPENDS_ON: targetSubItem.dependsOn,
    SUB_ITEM_STATUS: targetSubItem.status,
    TASKS_LINE: formatHintLine('Linked tasks', getDesignTaskIds(design).join(', ')),
    REPO_HINT_LINE: formatHintLine('Repo hint', design.metadata.repo),
    PROVIDER_HINT_LINE: formatHintLine('Provider hint', provider || design.metadata.providerHint),
    PROFILE_HINT_LINE: formatHintLine('Profile hint', profile || design.metadata.profileHint),
    BRANCH_SUFFIX_LINE: formatHintLine('Branch suffix', design.metadata.branchSuffix),
    VERIFICATION_COMMAND_LINE: formatHintLine('Verification command', design.metadata.verificationCommand),
    TASK_TRACKING_SECTION: buildFdTaskTrackingSection(
      getDesignTaskIds(design),
      fdId,
      subItem,
      provider || design.metadata.providerHint,
      profile || design.metadata.profileHint,
    ),
    BASE_BRANCH_LINE: baseBranchLine,
    SUB_ITEM_SECTION: subItemSection,
  });

  return prompt;
}

function createWorkerTrackingId(fdId, subItem, provider) {
  const stamp = nowIso().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `worker-${fdId.toLowerCase()}-${subItem.toLowerCase()}-${provider}-${stamp}`;
}

function registerWorkerLaunch(design, fdId, subItem, provider, profile, model) {
  const taskIds = getDesignTaskIds(design);
  if (taskIds.length === 0) {
    return null;
  }

  const workerId = createWorkerTrackingId(fdId, subItem, provider);
  const timestamp = nowIso();
  const repo = design.metadata.repo || undefined;

  for (const taskId of taskIds) {
    const filePath = path.join(TASKS_DIR, `${taskId}.json`);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    updateTaskFile(filePath, (nextTask) => {
      if (nextTask.design === null || nextTask.design === undefined || nextTask.design === '') {
        nextTask.design = fdId;
      }
      if (!Array.isArray(nextTask.sub_items)) {
        nextTask.sub_items = [];
      }
      if (!nextTask.sub_items.includes(subItem)) {
        nextTask.sub_items.push(subItem);
      }
      if (!Array.isArray(nextTask.workers)) {
        nextTask.workers = [];
      }

      const workerRecord = {
        id: workerId,
        sub_item: subItem,
        provider,
        profile,
        status: 'running',
        model: model || null,
        started_at: timestamp,
        updated_at: timestamp,
      };

      if (repo) {
        workerRecord.repo = repo;
      }

      nextTask.workers.push(workerRecord);
      if (!Array.isArray(nextTask.log)) {
        nextTask.log = [];
      }
      nextTask.log.push({
        date: timestamp,
        entry: `Worker launched: ${workerId} for ${fdId} ${subItem} (${provider}/${profile}).`,
      });
      nextTask.updated_at = timestamp;
      return nextTask;
    });
  }

  return {
    workerId,
    taskIds,
  };
}

function finalizeWorkerLaunch(tracking, finalStatus) {
  if (!tracking) {
    return;
  }

  const timestamp = nowIso();
  for (const taskId of tracking.taskIds) {
    const filePath = path.join(TASKS_DIR, `${taskId}.json`);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    updateTaskFile(filePath, (nextTask) => {
      if (!Array.isArray(nextTask.workers)) {
        nextTask.workers = [];
      }
      const target = nextTask.workers.find((worker) => worker.id === tracking.workerId);
      if (target) {
        target.status = finalStatus;
        target.updated_at = timestamp;
      }
      if (!Array.isArray(nextTask.log)) {
        nextTask.log = [];
      }
      nextTask.log.push({
        date: timestamp,
        entry: `Worker ${tracking.workerId} finished with status=${finalStatus}.`,
      });
      nextTask.updated_at = timestamp;
      return nextTask;
    });
  }
}

function resolveWorkerModel(provider, profile, explicitModel) {
  if (explicitModel) {
    return explicitModel;
  }

  const envSuffixes = {
    claude: {
      fast: 'CLAUDE_FAST_MODEL',
      strong: 'CLAUDE_STRONG_MODEL',
    },
    codex: {
      fast: 'CODEX_FAST_MODEL',
      strong: 'CODEX_STRONG_MODEL',
    },
  };

  const suffix = envSuffixes[provider]?.[profile];
  if (suffix) {
    // Read AGENT_<suffix> first; MALVIN_<suffix> is the deprecated legacy name.
    const override = process.env[`AGENT_${suffix}`] ?? process.env[`MALVIN_${suffix}`];
    if (override) {
      return override;
    }
  }

  const providerEntry = getProviderEntry(provider);
  const profileEntry = providerEntry.profiles?.[profile];
  if (!profileEntry) {
    throw new Error(`Unknown profile for ${provider}: ${profile}`);
  }

  return profileEntry.model || '';
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function commandFdStatus() {
  const designs = readDesignIndex();

  if (designs.length === 0) {
    console.log('No feature designs found in designs/INDEX.md.');
    return;
  }

  const rows = [['FD', 'Title', 'Status', 'Effort', 'Priority', 'Tasks']];
  for (const design of designs) {
    rows.push([
      design.id,
      design.title,
      design.status,
      design.effort,
      design.priority,
      design.tasks.join(', ') || '--',
    ]);
  }

  console.log('# Feature Designs');
  console.log('');
  console.log(renderTable(rows));

  const counts = new Map();
  for (const design of designs) {
    counts.set(design.status, (counts.get(design.status) || 0) + 1);
  }

  const activeDesigns = designs.filter((design) => design.status === 'open' || design.status === 'in_progress');
  for (const designRow of activeDesigns) {
    const design = readDesign(designRow.id);
    const tasks = getDesignTaskIds(design)
      .map((taskId) => readTask(taskId))
      .filter(Boolean);
    const doneCount = design.subItems.filter((item) => item.status === 'done').length;
    const totalCount = design.subItems.length;
    const readyItems = getReadySubItems(design);
    const workers = getWorkersForDesign(tasks, designRow.id, getDesignTaskIds(design));
    const runningWorkers = workers.filter((worker) => worker.status === 'running').length;

    console.log('');
    console.log(`## ${designRow.id} — ${designRow.title}`);
    console.log(`Sub-items: ${doneCount}/${totalCount} done`);
    console.log(`Workers: ${workers.length} tracked (${runningWorkers} running)`);

    if (getDesignTaskIds(design).length > 0) {
      const taskSummary = getDesignTaskIds(design)
        .map((taskId) => {
          const task = readTask(taskId);
          return task ? `${taskId} [${task.status}]` : `${taskId} [missing]`;
        })
        .join(', ');
      console.log(`Tasks: ${taskSummary}`);
    }

    console.log(formatHintLine('Repo hint', design.metadata.repo));
    console.log(formatHintLine('Provider hint', design.metadata.providerHint));
    console.log(formatHintLine('Profile hint', design.metadata.profileHint));
    console.log(formatHintLine('Branch suffix', design.metadata.branchSuffix));
    console.log(formatHintLine('Verification command', design.metadata.verificationCommand));

    if (design.openQuestions.length > 0) {
      console.log('Open questions:');
      for (const question of design.openQuestions) {
        console.log(`- ${question}`);
      }
    }

    if (readyItems.length > 0) {
      console.log('Ready sub-items:');
      for (const item of readyItems) {
        console.log(`- ${item.step}: ${item.what}`);
      }
    } else {
      console.log('Ready sub-items: none');
    }
  }

  const summary = Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ');

  console.log('');
  console.log(`Summary: ${summary}`);
}

function commandFdNewPrompt(args) {
  console.log(buildFdNewPrompt(args));
}

function commandFdNew(args) {
  const {
    title,
    effort,
    priority,
    repo,
    providerHint,
    profileHint,
    branchSuffix,
    verificationCommand,
    dryRun,
  } = parseFdNewArgs(args);

  validateFdNewArgs({ title, effort, priority, providerHint, profileHint });

  const fdId = getNextFdId();
  const workspaceTemplatePath = path.join(DESIGNS_DIR, 'TEMPLATE.md');
  const templatePath = fs.existsSync(workspaceTemplatePath)
    ? workspaceTemplatePath
    : path.join(SKILL_DIR, 'designs', 'TEMPLATE.md');
  const outputPath = path.join(DESIGNS_DIR, `${fdId}.md`);
  const indexPath = path.join(DESIGNS_DIR, 'INDEX.md');

  let content = fs.readFileSync(templatePath, 'utf8');
  content = replaceFrontmatterLine(content, 'id', fdId);
  content = replaceFrontmatterLine(content, 'title', quoteYamlString(title));
  content = replaceFrontmatterLine(content, 'status', 'planned');
  content = replaceFrontmatterLine(content, 'effort', effort);
  content = replaceFrontmatterLine(content, 'priority', priority);
  content = replaceFrontmatterLine(content, 'repo', repo ? quoteYamlString(repo) : '""');
  content = replaceFrontmatterLine(content, 'provider_hint', providerHint || '');
  content = replaceFrontmatterLine(content, 'profile_hint', profileHint || '');
  content = replaceFrontmatterLine(content, 'branch_suffix', branchSuffix ? quoteYamlString(branchSuffix) : '""');
  content = replaceFrontmatterLine(content, 'verification_command', verificationCommand ? quoteYamlString(verificationCommand) : '""');
  content = replaceFrontmatterLine(content, 'tasks', '[]');
  content = content.replace(
    '[What problem are we solving? Why does it matter?]',
    `TODO: describe the problem this feature solves. Seed title: ${title}`,
  );

  const nextRow = `| [${fdId}](${fdId}.md) | ${title} | planned | ${effort} | ${priority} | -- |`;

  if (dryRun) {
    console.log(`Would create: designs/${fdId}.md`);
    console.log(`Would append to index: ${nextRow}`);
    if (repo || providerHint || profileHint || branchSuffix || verificationCommand) {
      console.log('Would set design metadata:');
      console.log(`  repo=${repo || '(none)'}`);
      console.log(`  provider_hint=${providerHint || '(none)'}`);
      console.log(`  profile_hint=${profileHint || '(none)'}`);
      console.log(`  branch_suffix=${branchSuffix || '(none)'}`);
      console.log(`  verification_command=${verificationCommand || '(none)'}`);
    }
    return;
  }

  fs.writeFileSync(outputPath, content, 'utf8');

  const indexContent = fs.readFileSync(indexPath, 'utf8').trimEnd();
  fs.writeFileSync(indexPath, `${indexContent}\n${nextRow}\n`, 'utf8');

  console.log(`Created designs/${fdId}.md`);
  console.log(`Updated designs/INDEX.md`);
  console.log('Next: flesh out Context, Solution, Files to Modify, and Sub-items.');
}

function commandFdWorkPrompt(args) {
  const fdId = args[0];
  const subItem = args[1];
  const baseBranch = getArgValue(args, '--base') || '';

  if (!fdId || !subItem) {
    throw new Error('Usage: scripts/<agent> fd-work-prompt <FD-ID> <SUB-ITEM> [--base <branch>]');
  }

  console.log(buildFdWorkPrompt(fdId, subItem, { baseBranch }));
}

function commandWorker(args) {
  const fdId = args[0];
  const subItem = args[1];

  if (!fdId || !subItem) {
    throw new Error('Usage: scripts/<agent> worker <FD-ID> <SUB-ITEM> [--provider <provider>] [--profile <profile>] [--model <model>] [--base <branch>] [--dry-run]');
  }

  const design = readDesign(fdId);
  const provider = getArgValue(args, '--provider') || design.metadata.providerHint || 'claude';
  const profile = getArgValue(args, '--profile') || design.metadata.profileHint || 'fast';
  const model = getArgValue(args, '--model') || '';
  const baseBranch = getArgValue(args, '--base') || '';
  const dryRun = hasFlag(args, '--dry-run');

  const prompt = buildFdWorkPrompt(fdId, subItem, {
    baseBranch,
    provider,
    profile,
  });
  const resolvedModel = resolveWorkerModel(provider, profile, model);
  const providerEntry = getProviderEntry(provider);
  const fdPath = path.join(ROOT_DIR, 'designs', `${fdId}.md`);

  console.log(`Launching worker: ${fdId} ${subItem}`);
  console.log(`   Provider: ${provider}`);
  console.log(`   Profile: ${profile}`);
  if (resolvedModel) {
    console.log(`   Model: ${resolvedModel}`);
  }
  console.log(`   Design: ${fdPath}`);
  if (baseBranch) {
    console.log(`   Base: ${baseBranch}`);
  }
  if (design.metadata.repo) {
    console.log(`   Repo hint: ${design.metadata.repo}`);
  }
  console.log('');

  const command = providerEntry.command;
  const commandArgs = provider === 'claude'
    ? [...(resolvedModel ? ['--model', resolvedModel] : []), prompt]
    : [
      '--cd',
      ROOT_DIR,
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      ...(resolvedModel ? ['--model', resolvedModel] : []),
      prompt,
    ];

  if (dryRun) {
    console.log('Dry run only.');
    console.log(`Command: ${command} ${commandArgs.map((arg) => JSON.stringify(arg)).join(' ')}`);
    return;
  }

  const tracking = registerWorkerLaunch(design, fdId, subItem, provider, profile, resolvedModel);
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    // HUSKY=0 skips husky hooks for the worker's own commits; a no-op where husky
    // is not used.
    env: { ...process.env, HUSKY: '0' },
  });
  const finalStatus = result.status === 0 ? 'stopped' : 'failed';
  finalizeWorkerLaunch(tracking, finalStatus);
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function commandFdClose(args) {
  const fdId = args[0];
  const force = hasFlag(args, '--force');
  const dryRun = hasFlag(args, '--dry-run');

  if (!fdId) {
    throw new Error('Usage: scripts/<agent> fd-close <FD-ID> [--force] [--dry-run]');
  }

  const design = readDesign(fdId);
  const pendingItems = design.subItems.filter((item) => item.status !== 'done');
  const verificationSection = extractSection(design.body, 'Verification');
  const uncheckedVerification = verificationSection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- [ ] '))
    .map((line) => line.slice(6).trim());

  if (!force && (pendingItems.length > 0 || uncheckedVerification.length > 0)) {
    const issues = [];
    if (pendingItems.length > 0) {
      issues.push(`pending sub-items: ${pendingItems.map((item) => item.step).join(', ')}`);
    }
    if (uncheckedVerification.length > 0) {
      issues.push(`unchecked verification items: ${uncheckedVerification.join('; ')}`);
    }
    throw new Error(`FD ${fdId} is not ready to close (${issues.join(' | ')}). Re-run with --force to archive anyway.`);
  }

  const taskIds = Array.isArray(design.frontmatter.tasks) ? design.frontmatter.tasks : [];

  if (dryRun) {
    console.log(`Would archive: designs/${fdId}.md -> designs/archive/${fdId}.md`);
    if (taskIds.length > 0) {
      console.log(`Would update task logs: ${taskIds.join(', ')}`);
    }
    return;
  }

  const archivedContent = replaceFrontmatterLine(design.content, 'status', 'archived');
  const archiveDir = path.join(DESIGNS_DIR, 'archive');
  const archivePath = path.join(archiveDir, `${fdId}.md`);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(archivePath, archivedContent, 'utf8');
  fs.unlinkSync(design.path);

  const indexPath = path.join(DESIGNS_DIR, 'INDEX.md');
  const nextIndexContent = fs.readFileSync(indexPath, 'utf8')
    .split('\n')
    .filter((line) => !line.includes(`[${fdId}](${fdId}.md)`))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  fs.writeFileSync(indexPath, `${nextIndexContent}\n`, 'utf8');

  for (const taskId of taskIds) {
    const result = spawnSync(path.join(ROOT_DIR, 'scripts', 'task'), ['log', taskId, `${fdId} completed and archived`], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      throw new Error(output || `Failed to append task log for ${taskId}`);
    }
  }

  console.log(`Archived designs/${fdId}.md -> designs/archive/${fdId}.md`);
  if (taskIds.length > 0) {
    console.log(`Updated task logs: ${taskIds.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Exports used by session-review and other commands that reference FD data
// ---------------------------------------------------------------------------

module.exports = {
  buildFdNewPrompt,
  buildFdWorkPrompt,
  commandFdClose,
  commandFdNew,
  commandFdNewPrompt,
  commandFdStatus,
  commandFdWorkPrompt,
  commandWorker,
  getDesignTaskIds,
  getWorkersForDesign,
};
