#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { ROOT_DIR, logSkillMetric, shellQuote } = require('./lib/cli-utils.js');

const {
  commandFdClose,
  commandFdNew,
  commandFdNewPrompt,
  commandFdStatus,
  commandFdWorkPrompt,
  commandWorker,
} = require('../skills/fd/fd-commands.js');

const { commandShip, commandShipPrompt } = require('../skills/ship/ship-commands.js');
const { commandSession } = require('../skills/session/session-commands.js');
const { commandSessionReview, commandSessionReviewPrompt } = require('../skills/session-review/session-review-commands.js');
const { commandWorktree } = require('../skills/worktree/worktree-commands.js');
const { commandSyncBranch } = require('../skills/sync-branch/sync-branch-commands.js');
const { commandSlackStatus } = require('../skills/slack-status/slack-status-commands.js');

const COMMAND_SKILL_MAP = {
  'fd-new': { skill: 'fd', action: 'new' },
  'fd-new-prompt': { skill: 'fd', action: 'new-prompt' },
  'fd-close': { skill: 'fd', action: 'close' },
  'fd-status': { skill: 'fd', action: 'status' },
  'fd-work-prompt': { skill: 'fd', action: 'work-prompt' },
  worker: { skill: 'fd', action: 'worker' },
  worktree: { skill: 'worktree', action: 'create' },
  'sync-branch': { skill: 'sync-branch', action: 'sync' },
  ship: { skill: 'ship', action: 'run' },
  'ship-prompt': { skill: 'ship', action: 'prompt' },
  'session-review': { skill: 'session-review', action: 'run' },
  'session-review-prompt': { skill: 'session-review', action: 'prompt' },
};

// Self-discover agent name from the script filename (e.g., nova.js -> nova)
const AGENT_NAME = path.basename(process.argv[1] || 'agent', '.js');
const COMPLETIONS_DIR = path.join(ROOT_DIR, 'completions');

function usage() {
  console.error('Usage:');
  console.error(`  scripts/${AGENT_NAME} fd-new <title> [--effort <small|medium|large>] [--priority <low|medium|high|critical>] [--repo <repo>] [--provider-hint <provider>] [--profile-hint <profile>] [--branch-suffix <suffix>] [--verification-command <command>] [--dry-run]`);
  console.error(`  scripts/${AGENT_NAME} fd-new-prompt <title> [--effort <small|medium|large>] [--priority <low|medium|high|critical>] [--repo <repo>] [--provider-hint <provider>] [--profile-hint <profile>] [--branch-suffix <suffix>] [--verification-command <command>] [--dry-run]`);
  console.error(`  scripts/${AGENT_NAME} fd-close <FD-ID> [--force] [--dry-run]`);
  console.error(`  scripts/${AGENT_NAME} fd-status`);
  console.error(`  scripts/${AGENT_NAME} fd-work-prompt <FD-ID> <SUB-ITEM> [--base <branch>]`);
  console.error(`  scripts/${AGENT_NAME} worker <FD-ID> <SUB-ITEM> [--provider <provider>] [--profile <profile>] [--model <model>] [--base <branch>] [--dry-run]`);
  console.error(`  scripts/${AGENT_NAME} worktree <repo> <branch-name> [--base <branch>] [--dry-run]`);
  console.error(`  scripts/${AGENT_NAME} sync-branch [<worktree-name>] [--base <branch>] [--dry-run]`);
  console.error(`  scripts/${AGENT_NAME} ship [<worktree-name>] [--base <branch>] [--tier 1|2] [--quick] [--skip-verify] [--push] [--create-pr] [--title <title>] [--body-file <path>] [--dry-run]`);
  console.error(`  scripts/${AGENT_NAME} ship-prompt [<worktree-name>] [--base <branch>] [--tier 1|2] [--quick] [--skip-verify] [--push] [--create-pr] [--title <title>] [--body-file <path>] [--dry-run]`);
  console.error(`  scripts/${AGENT_NAME} session <list|close-all|history|info <id>>`);
  console.error(`  scripts/${AGENT_NAME} session-review [--run-session-end] [--dry-run]`);
  console.error(`  scripts/${AGENT_NAME} session-review-prompt [--run-session-end] [--dry-run]`);
  console.error(`  scripts/${AGENT_NAME} completion <bash|zsh>`);
  console.error(`  scripts/${AGENT_NAME} slack-status <check|clear-all|set>`);
  console.error(`  scripts/${AGENT_NAME} skills <list|validate [skill]|stats [--skill NAME] [--since DURATION]|sync|export <name>|export --all|import <path>>`);
}

function commandCompletion(args) {
  const shell = args[0];
  if (!shell || !['bash', 'zsh'].includes(shell)) {
    throw new Error(`Usage: scripts/${AGENT_NAME} completion <bash|zsh>`);
  }

  const fileName = shell === 'bash' ? `${AGENT_NAME}.bash` : `_${AGENT_NAME}`;
  const filePath = path.join(COMPLETIONS_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Completion script not found: completions/${fileName}`);
  }

  process.stdout.write(fs.readFileSync(filePath, 'utf8'));
}

function commandSkills(args) {
  const subcommand = args[0];
  const skillsLib = path.join(ROOT_DIR, 'scripts', 'lib', 'skills.sh');
  const quotedLib = shellQuote(skillsLib);

  let bashScript;
  switch (subcommand) {
    case 'list':
      bashScript = `source ${quotedLib} && skills_list_table`;
      break;
    case 'validate': {
      const targetSkill = args[1] || '';
      bashScript = targetSkill
        ? `source ${quotedLib} && skills_validate ${shellQuote(targetSkill)}`
        : `source ${quotedLib} && skills_validate`;
      break;
    }
    case 'stats': {
      const statsArgs = args.slice(1).map(shellQuote).join(' ');
      bashScript = `source ${quotedLib} && skills_stats ${statsArgs}`;
      break;
    }
    case 'sync':
      bashScript = `source ${quotedLib} && skills_generate_index && skills_sync_commands`;
      break;
    case 'export': {
      const exportAll = args.includes('--all');
      const exportName = exportAll ? null : args[1];
      if (!exportAll && !exportName) {
        throw new Error(`Usage: scripts/${AGENT_NAME} skills export <name> | scripts/${AGENT_NAME} skills export --all`);
      }
      bashScript = exportAll
        ? `source ${quotedLib} && skills_export_all`
        : `source ${quotedLib} && skills_export ${shellQuote(exportName)}`;
      break;
    }
    case 'import': {
      const importPath = args[1];
      if (!importPath) {
        throw new Error(`Usage: scripts/${AGENT_NAME} skills import <path>`);
      }
      bashScript = `source ${quotedLib} && skills_import ${shellQuote(importPath)}`;
      break;
    }
    default:
      throw new Error(`Usage: scripts/${AGENT_NAME} skills <list|validate [skill]|stats [--skill NAME] [--since DURATION]|sync|export <name>|export --all|import <path>>`);
  }

  const result = spawnSync('bash', ['-c', bashScript], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function resolveCommandMetric(command, args) {
  if (command === 'session') {
    return { skill: 'session', action: args[0] || 'unknown' };
  }

  if (command === 'slack-status') {
    return { skill: 'slack-status', action: args[0] || 'unknown' };
  }

  return COMMAND_SKILL_MAP[command] || null;
}

function dispatchCommand(command, args) {
  switch (command) {
    case 'fd-new':
      commandFdNew(args);
      return 0;
    case 'fd-new-prompt':
      commandFdNewPrompt(args);
      return 0;
    case 'fd-close':
      commandFdClose(args);
      return 0;
    case 'fd-status':
      commandFdStatus();
      return 0;
    case 'fd-work-prompt':
      commandFdWorkPrompt(args);
      return 0;
    case 'worker':
      commandWorker(args);
      return 0;
    case 'worktree':
      commandWorktree(args);
      return 0;
    case 'sync-branch':
      commandSyncBranch(args);
      return 0;
    case 'ship':
      commandShip(args);
      return 0;
    case 'ship-prompt':
      commandShipPrompt(args);
      return 0;
    case 'session':
      commandSession(args);
      return 0;
    case 'session-review':
      commandSessionReview(args);
      return 0;
    case 'session-review-prompt':
      commandSessionReviewPrompt(args);
      return 0;
    case 'completion':
      commandCompletion(args);
      return 0;
    case 'slack-status':
      commandSlackStatus(args);
      return 0;
    case 'skills':
      commandSkills(args);
      return 0;
    default:
      usage();
      return command ? 1 : 0;
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const metric = resolveCommandMetric(command, args);
  const startedAt = Date.now();
  let exitCode = 0;
  let ok = true;
  let errorMessage = '';

  try {
    exitCode = dispatchCommand(command, args);
  } catch (error) {
    ok = false;
    errorMessage = error instanceof Error ? error.message : String(error);
    console.error(errorMessage);
    exitCode = 1;
  } finally {
    if (metric) {
      logSkillMetric(metric.skill, metric.action, 'cli', Date.now() - startedAt, ok && exitCode === 0, errorMessage);
    }
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main();
