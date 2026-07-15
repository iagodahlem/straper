#!/usr/bin/env node
// Backing helper for the `review` skill.
//
// Given a worktree name, this computes the diff (changed files + repo) and
// applies the Domain-Specific Spawn Rules from TOOLS.md deterministically,
// then emits one ready-to-dispatch parallel-subagent prompt per matched
// reviewer. It does NOT spawn the subagents — it prints the prompts for the
// orchestrator to dispatch in parallel (up to 5, read-only) and
// synthesize.
//
// Run directly:
//   node skills/review/review-commands.js <worktree> [--base <branch>] [--ci]
//
// This helper is intentionally self-contained (no registration in
// scripts/<agent>.js required). It reuses the shared cli-utils helpers so the
// diff/repo/task resolution matches the ship pipeline.

const fs = require('fs');
const path = require('path');

const {
  ROOT_DIR,
  detectCurrentWorktreeName,
  defaultBaseBranchForWorktree,
  extractRepoNameFromWorktree,
  findLinkedTasks,
  getArgValue,
  getGitOutput,
  hasFlag,
} = require('../../scripts/lib/cli-utils.js');
const { analyzeDiff } = require('./comment-density.js');

// ---------------------------------------------------------------------------
// Mandatory boilerplate injected into every emitted reviewer prompt
// ---------------------------------------------------------------------------

const REVIEW_BOILERPLATE = [
  'Read the repo\'s `AGENTS.md` or `CLAUDE.md` before starting any work.',
  'Before any Read/Grep/Glob/Bash that touches a repo, run `/investigate <repo>` (or `--branch <name>` / `--ref <ref>` when targeting a specific branch/ref) and use the absolute path it prints. Reads from your local source clones are blocked by the `repo-scope` hook.',
  'This is a READ-ONLY review pass. Do not modify files. Report findings only.',
].join('\n');

// ---------------------------------------------------------------------------
// Domain-Specific Spawn Rules — data-driven, config-overridable.
//
// The ordered rule set is read from `review.rules` in config/workspace.json
// when present; otherwise the generic defaults below apply. Each rule is
// `{ label?, match, reviewers[] }`: a rule contributes its reviewers when
// every condition in `match` holds. A reviewer maps to an agent profile under
// agents/<profile>.md and a subagent_type; the first reviewer seen per profile
// wins (later duplicates are skipped), so rule order is significant.
//
// Match conditions (all present must hold):
//   always        (bool)   — matches any non-trivial diff
//   repo          (string) — repo name equals this value
//   repoHasFile   (string) — worktree contains this file (e.g. "go.mod")
//   pathPattern   (regex)  — some changed file (lowercased) matches
//   minFiles      (number) — changed-file count is >= this
//   crossRepo     (bool)   — changed files span more than one top-level dir
//   ciFailures    (bool)   — CI failures were reported (--ci)
// ---------------------------------------------------------------------------

// Generic, brand-neutral defaults used when no `review.rules` config is set.
const GENERIC_DEFAULT_RULES = [
  {
    label: 'baseline — always runs',
    match: { always: true },
    reviewers: [{
      role: 'Code Reviewer',
      subagentType: 'Code Reviewer',
      profile: 'code-reviewer',
      focus: 'correctness, edge cases, error handling, naming, test coverage, scope',
    }],
  },
  {
    label: 'Go module detected (go.mod)',
    match: { repoHasFile: 'go.mod' },
    reviewers: [{
      role: 'Go Reviewer',
      subagentType: 'Backend Architect',
      profile: 'go-reviewer',
      focus: 'layer boundaries, error wrapping, query safety, Go idioms',
    }],
  },
  {
    label: 'security-sensitive paths',
    match: { pathPattern: '(auth|token|secret|session|credential|password)' },
    reviewers: [{
      role: 'Security Reviewer',
      subagentType: 'Security Engineer',
      profile: 'security-reviewer',
      focus: 'authentication, authorization, secret handling, input validation',
    }],
  },
];

function readReviewRules() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config', 'workspace.json'), 'utf8'));
    const rules = config && config.review && config.review.rules;
    if (Array.isArray(rules) && rules.length > 0) {
      return rules;
    }
  } catch (_) {
    // no config / unreadable / malformed — fall back to generic defaults
  }
  return GENERIC_DEFAULT_RULES;
}

function ruleMatches(match, ctx) {
  if (!match || typeof match !== 'object') {
    return false;
  }
  if (match.always) {
    return true;
  }
  if (match.repo !== undefined && ctx.repoName !== match.repo) {
    return false;
  }
  if (match.repoHasFile !== undefined
      && !(ctx.worktreePath && fs.existsSync(path.join(ctx.worktreePath, match.repoHasFile)))) {
    return false;
  }
  if (match.pathPattern !== undefined) {
    const re = new RegExp(match.pathPattern);
    if (!ctx.lowerFiles.some((file) => re.test(file))) {
      return false;
    }
  }
  if (match.minFiles !== undefined && !(ctx.changedFiles.length >= match.minFiles)) {
    return false;
  }
  if (match.crossRepo && !ctx.crossRepo) {
    return false;
  }
  if (match.ciFailures && !ctx.ciFailures) {
    return false;
  }
  return true;
}

function matchReviewers(repoName, changedFiles, { ciFailures = false, worktreePath = null } = {}) {
  const lowerFiles = changedFiles.map((file) => file.toLowerCase());
  const crossRepo = new Set(
    changedFiles
      .map((file) => file.split('/')[0])
      .filter(Boolean),
  ).size > 1;

  const ctx = { repoName, changedFiles, lowerFiles, crossRepo, ciFailures, worktreePath };

  const reviewers = [];
  const seen = new Set();
  const add = (reviewer, label) => {
    if (!reviewer || seen.has(reviewer.profile)) {
      return;
    }
    seen.add(reviewer.profile);
    reviewers.push({ ...reviewer, rule: reviewer.rule || label || 'matched' });
  };

  for (const rule of readReviewRules()) {
    if (!ruleMatches(rule.match, ctx)) {
      continue;
    }
    for (const reviewer of (rule.reviewers || [])) {
      add(reviewer, rule.label);
    }
  }

  return reviewers;
}

// ---------------------------------------------------------------------------
// Comment-density advisory — see comment-density.js and review.md
// ---------------------------------------------------------------------------

function formatCommentDensityFinding(finding) {
  const pct = Math.round(finding.ratio * 100);
  const chunkNote = finding.chunkFlagged
    ? `, ${finding.chunkCount} comment-before-code chunks across ${finding.codeCount} code lines (one comment per step)`
    : '';
  return `${finding.filePath} — ${pct}% comment lines (${finding.commentCount}/${finding.total} added lines)${chunkNote}, consider trimming to a minimal comment density`;
}

// ---------------------------------------------------------------------------
// Prompt rendering — one ready-to-dispatch prompt per matched reviewer
// ---------------------------------------------------------------------------

function renderReviewerPrompt(reviewer, context) {
  const { repoName, changedFiles, baseBranch, branchName, taskContext } = context;
  const profilePath = `agents/${reviewer.profile}.md`;
  const profileExists = fs.existsSync(path.join(ROOT_DIR, profilePath));

  const fileList = changedFiles.length > 0
    ? changedFiles.map((file) => `  - ${file}`).join('\n')
    : '  (no changed files detected)';

  const lines = [
    `### ${reviewer.role}  (subagent_type: ${reviewer.subagentType})`,
    `Matched rule: ${reviewer.rule}`,
    reviewer.optional
      ? `NOTE: optional pass — dispatch only if \`${profilePath}\` exists (currently ${profileExists ? 'present' : 'ABSENT — skip'}).`
      : null,
    '',
    'Prompt to dispatch:',
    '',
    `> You are running a read-only pre-PR review pass on \`${repoName}\` (branch \`${branchName}\`).`,
    `> Profile to follow: \`${profilePath}\`${profileExists ? '' : ' (MISSING — fall back to the role description above)'}.`,
    `> Review focus: ${reviewer.focus}.`,
    '>',
    `> ${REVIEW_BOILERPLATE.split('\n').join('\n> ')}`,
    '>',
    `> Diff context: \`git -C workspaces/${context.worktreeName} diff origin/${baseBranch}...HEAD\``,
    '> Changed files:',
    fileList.split('\n').map((l) => `> ${l}`).join('\n'),
    '>',
    `> Task/FD context: ${taskContext}`,
    '>',
    '> Return a structured report in the Output Format from the profile. Findings only — do not modify any files.',
  ].filter((line) => line !== null);

  return lines.join('\n');
}

function buildTaskContext(repoName, branchName, worktreeName) {
  const linked = findLinkedTasks(repoName, branchName, worktreeName);
  if (linked.length === 0) {
    return '(no linked task found — ask the orchestrator for the task/FD this diff belongs to)';
  }
  return linked
    .map(({ task }) => {
      const title = task.title ? ` — ${task.title}` : '';
      const design = task.design ? ` (design ${task.design})` : '';
      return `${task.id}${title}${design}`;
    })
    .join('; ');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function commandReview(args) {
  const baseArg = getArgValue(args, '--base');
  const ciFailures = hasFlag(args, '--ci');
  const worktreeName = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--base')
    || detectCurrentWorktreeName();

  if (!worktreeName) {
    throw new Error('Usage: node skills/review/review-commands.js <worktree> [--base <branch>] [--ci]');
  }

  const worktreePath = path.join(ROOT_DIR, 'workspaces', worktreeName);
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`Worktree not found: workspaces/${worktreeName}`);
  }

  const repoName = extractRepoNameFromWorktree(worktreeName);
  const branchName = getGitOutput(worktreePath, ['branch', '--show-current']);
  const baseBranch = baseArg || defaultBaseBranchForWorktree(worktreePath);

  const changedFiles = getGitOutput(worktreePath, ['diff', '--name-only', `origin/${baseBranch}...HEAD`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const diffStat = getGitOutput(worktreePath, ['diff', '--stat', `origin/${baseBranch}...HEAD`]);
  const patchText = getGitOutput(worktreePath, ['diff', '--patch', '--no-color', '-M', `origin/${baseBranch}...HEAD`]);
  const commentDensityFindings = analyzeDiff(patchText);

  const reviewers = matchReviewers(repoName, changedFiles, { ciFailures, worktreePath });
  const taskContext = buildTaskContext(repoName, branchName, worktreeName);

  const context = {
    worktreeName,
    repoName,
    branchName,
    baseBranch,
    changedFiles,
    taskContext,
  };

  console.log(`Worktree: ${worktreeName}`);
  console.log(`Repo: ${repoName}`);
  console.log(`Branch: ${branchName}`);
  console.log(`Base: origin/${baseBranch}`);
  console.log(`Task/FD context: ${taskContext}`);
  console.log('');
  console.log('Diff stat:');
  console.log(diffStat || '(no diff)');
  console.log('');
  for (const finding of commentDensityFindings) {
    console.log(`⚠ Comment density: ${formatCommentDensityFinding(finding)}`);
  }
  if (commentDensityFindings.length > 0) {
    console.log('');
  }
  console.log(`Matched reviewers (${reviewers.length}) — dispatch in parallel (max 5, read-only), then synthesize:`);
  for (const reviewer of reviewers) {
    console.log(`- ${reviewer.role} [${reviewer.rule}]`);
  }
  console.log('');
  console.log('============================================================');
  console.log('READY-TO-DISPATCH PROMPTS');
  console.log('============================================================');
  for (const reviewer of reviewers) {
    console.log('');
    console.log(renderReviewerPrompt(reviewer, context));
  }
}

module.exports = {
  matchReviewers,
  renderReviewerPrompt,
  formatCommentDensityFinding,
  buildTaskContext,
  commandReview,
  REVIEW_BOILERPLATE,
};

// Allow direct execution: `node skills/review/review-commands.js <worktree>`
if (require.main === module) {
  try {
    commandReview(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
