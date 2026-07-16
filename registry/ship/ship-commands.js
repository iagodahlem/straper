const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  ROOT_DIR,
  detectCurrentWorktreeName,
  defaultBaseBranchForWorktree,
  extractRepoNameFromWorktree,
  findLinkedTasks,
  getArgValue,
  getGitOutput,
  hasFlag,
  nowIso,
  resolveRepoSlug,
  runChecked,
  stripFlagArgs,
} = require('../../scripts/lib/cli-utils.js');

// Module-local copy preferred; fall back to the shared lib for workspaces
// whose cli-utils still exports it.
const { updateTaskFile } = fs.existsSync(path.join(__dirname, 'lib', 'task-file.js'))
  ? require('./lib/task-file.js')
  : require('../../scripts/lib/cli-utils.js');

// ---------------------------------------------------------------------------
// Ship helpers
// ---------------------------------------------------------------------------

function createPrBody({ worktreeName, branchName, baseBranch, verifyCommand, changedFiles }) {
  const summaryBullets = changedFiles.slice(0, 5).map((file) => `- Update \`${file}\``);
  const summary = summaryBullets.length > 0 ? summaryBullets : ['- Update the target worktree changes'];

  return [
    '## Summary',
    ...summary,
    '',
    '## Test plan',
    `- ${verifyCommand}`,
  ].join('\n');
}

function suggestReviewPasses(worktreePath, changedFiles) {
  const suggestions = [];
  const lowerFiles = changedFiles.map((file) => file.toLowerCase());

  if (fs.existsSync(path.join(worktreePath, 'go.mod'))) {
    suggestions.push('Security Engineer');
    suggestions.push('Go Reviewer');
  }

  if (lowerFiles.some((file) => /(auth|scim|sso|rbac)/.test(file))) {
    suggestions.push('Security Reviewer');
  }

  if (changedFiles.length >= 3) {
    suggestions.push('Technical Writer');
  }

  return Array.from(new Set(suggestions));
}

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

function parseShipArgs(args) {
  const positionalArgs = stripFlagArgs(
    args,
    ['--base', '--tier', '--title', '--body-file'],
    ['--quick', '--skip-verify', '--push', '--create-pr', '--dry-run'],
  );

  return {
    baseBranch: getArgValue(args, '--base'),
    tier: getArgValue(args, '--tier') || '2',
    titleOverride: getArgValue(args, '--title'),
    bodyFile: getArgValue(args, '--body-file'),
    quick: hasFlag(args, '--quick'),
    skipVerify: hasFlag(args, '--skip-verify'),
    push: hasFlag(args, '--push'),
    createPr: hasFlag(args, '--create-pr'),
    dryRun: hasFlag(args, '--dry-run'),
    worktreeName: positionalArgs[0] || detectCurrentWorktreeName(),
  };
}

function buildShipPrompt(args) {
  const parsed = parseShipArgs(args);
  if (!parsed.worktreeName) {
    throw new Error('Usage: scripts/<agent> ship-prompt [<worktree-name>] [--base <branch>] [--tier 1|2] [--quick] [--skip-verify] [--push] [--create-pr] [--title <title>] [--body-file <path>] [--dry-run]');
  }

  return renderTemplate('ship', {
    WORKTREE_NAME: parsed.worktreeName,
    BASE_BRANCH: parsed.baseBranch || '(default)',
    TIER: parsed.tier,
    QUICK_MODE: parsed.quick ? 'yes' : 'no',
    SKIP_VERIFY: parsed.skipVerify ? 'yes' : 'no',
    PUSH_BRANCH: parsed.push ? 'yes' : 'no',
    CREATE_PR: parsed.createPr ? 'yes' : 'no',
  });
}

function commandShipPrompt(args) {
  console.log(buildShipPrompt(args));
}

function commandShip(args) {
  const {
    baseBranch,
    tier,
    titleOverride,
    bodyFile,
    quick,
    skipVerify,
    push,
    createPr,
    dryRun,
    worktreeName,
  } = parseShipArgs(args);

  if (!worktreeName) {
    throw new Error('Usage: scripts/<agent> ship [<worktree-name>] [--base <branch>] [--tier 1|2] [--quick] [--skip-verify] [--push] [--create-pr] [--title <title>] [--body-file <path>] [--dry-run]');
  }

  const worktreePath = path.join(ROOT_DIR, 'workspaces', worktreeName);
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`Worktree not found: workspaces/${worktreeName}`);
  }

  const repoName = extractRepoNameFromWorktree(worktreeName);
  const branchName = getGitOutput(worktreePath, ['branch', '--show-current']);
  const resolvedBaseBranch = baseBranch || defaultBaseBranchForWorktree(worktreePath);
  const workspaceVerifyScript = path.join(ROOT_DIR, 'scripts', 'verify.sh');
  const verifyScript = fs.existsSync(workspaceVerifyScript) ? workspaceVerifyScript : path.join(__dirname, 'verify.sh');
  const verifyCommand = `./${path.relative(ROOT_DIR, verifyScript)} ${worktreeName}${tier !== '2' ? ` --tier ${tier}` : ''}${quick ? ' --quick' : ''}`;

  if (dryRun) {
    if (!skipVerify) {
      console.log(`Would run: ${verifyCommand}`);
    }
    if (push || createPr) {
      console.log(`Would push branch: ${branchName}`);
    }
    if (createPr) {
      console.log(`Would create PR against origin/${resolvedBaseBranch}`);
    }
  } else if (!skipVerify) {
    const verifyArgs = [verifyScript, worktreeName, '--tier', tier];
    if (quick) {
      verifyArgs.push('--quick');
    }

    const verifyResult = spawnSync(verifyArgs[0], verifyArgs.slice(1), {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (verifyResult.status !== 0) {
      process.exit(verifyResult.status || 1);
    }
  }

  const changedFiles = getGitOutput(worktreePath, ['diff', '--name-only', `origin/${resolvedBaseBranch}...HEAD`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const diffStat = getGitOutput(worktreePath, ['diff', '--stat', `origin/${resolvedBaseBranch}...HEAD`]);
  const latestCommitTitle = getGitOutput(worktreePath, ['log', '-1', '--pretty=%s']);
  const prTitle = titleOverride || latestCommitTitle;
  const prBody = bodyFile
    ? fs.readFileSync(path.resolve(ROOT_DIR, bodyFile), 'utf8')
    : createPrBody({
      worktreeName,
      branchName,
      baseBranch: resolvedBaseBranch,
      verifyCommand,
      changedFiles,
    });
  const reviewSuggestions = suggestReviewPasses(worktreePath, changedFiles);

  let prUrl = '';
  let prNumber = null;

  if (!dryRun && (push || createPr)) {
    const pushResult = spawnSync('git', ['-C', worktreePath, 'push', '-u', 'origin', branchName], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (pushResult.status !== 0) {
      process.exit(pushResult.status || 1);
    }
  }

  if (!dryRun && createPr) {
    const repoSlug = resolveRepoSlug(repoName, [worktreePath]);
    if (!repoSlug) {
      console.log(`Note: could not derive the GitHub org from ${worktreePath}; letting gh infer the repo from the worktree remote.`);
    }
    const createResult = runChecked('gh', [
      'pr',
      'create',
      ...(repoSlug ? ['--repo', repoSlug] : []),
      '--head',
      branchName,
      '--base',
      resolvedBaseBranch,
      '--title',
      prTitle,
      '--body',
      prBody,
    ], repoSlug ? {} : { cwd: worktreePath });
    prUrl = createResult.stdout.trim();
    const match = prUrl.match(/\/pull\/(\d+)/);
    prNumber = match ? Number.parseInt(match[1], 10) : null;

    const linkedTasks = findLinkedTasks(repoName, branchName, worktreeName);
    for (const { filePath, task } of linkedTasks) {
      updateTaskFile(filePath, (nextTask) => {
        if (!Array.isArray(nextTask.prs)) {
          nextTask.prs = [];
        }
        if (!nextTask.prs.some((pr) => pr.repo === repoName && pr.number === prNumber)) {
          nextTask.prs.push({
            repo: repoName,
            number: prNumber,
            status: 'open',
          });
        }
        if (!Array.isArray(nextTask.log)) {
          nextTask.log = [];
        }
        nextTask.log.push({
          date: nowIso(),
          entry: `Opened PR #${prNumber ?? 'unknown'} in ${repoName} from ${branchName}.`,
        });
        nextTask.updated_at = nowIso();
        return nextTask;
      });
      console.log(`Updated task tracking: ${task.id}`);
    }
  }

  console.log(`Worktree: ${worktreeName}`);
  console.log(`Branch: ${branchName}`);
  console.log(`Base: origin/${resolvedBaseBranch}`);
  console.log(`Review diff: git -C ${worktreePath} diff origin/${resolvedBaseBranch}...HEAD`);
  console.log('');
  console.log('Suggested PR title:');
  console.log(prTitle);
  console.log('');
  console.log('Suggested PR body:');
  console.log(prBody);
  console.log('');
  console.log('Diff stat:');
  console.log(diffStat || '(no diff)');

  console.log('');
  console.log('Suggested review passes:');
  if (reviewSuggestions.length === 0) {
    console.log('- none');
  } else {
    for (const suggestion of reviewSuggestions) {
      console.log(`- ${suggestion}`);
    }
  }

  if (prUrl) {
    console.log('');
    console.log(`PR URL: ${prUrl}`);
  }
}

module.exports = {
  commandShip,
  commandShipPrompt,
};
