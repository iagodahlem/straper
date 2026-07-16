const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  ROOT_DIR,
  formatDate,
  getAllTasks,
  hasFlag,
} = require('../../scripts/lib/cli-utils.js');

const { readDesign, readDesignIndex } = require('../fd/designs.js');

// ---------------------------------------------------------------------------
// workspace-review — on-demand workspace HEALTH & LEARNING review.
//
// Distinct from session-review (per-session WORK TRACKING). This module runs
// the three DETERMINISTIC scans. The agent-driven harvest (scan 4) lives in
// prompts/workspace-review.md.
//
// Every scan is READ-ONLY and advisory. workspace-review NEVER mutates
// MEMORY.md, skills, or tasks — it produces a report; fixes are ack-gated or
// run through the `skillify` scaffold.
// ---------------------------------------------------------------------------

const SKILLS_DIR = path.join(ROOT_DIR, 'skills');
const MEMORY_DIR = path.join(ROOT_DIR, 'memory');
const MEMORY_INDEX = path.join(ROOT_DIR, 'MEMORY.md');
const SKILLS_LIB = path.join(ROOT_DIR, 'scripts', 'lib', 'skills.sh');

// FD statuses that are not terminal — an FD in one of these but already
// implemented in code is tracking drift.
const NON_TERMINAL_FD_STATUSES = new Set(['design', 'open', 'planned']);

// Workspace-internal top-level dirs we treat as "real file references" when
// deciding whether an FD looks implemented.
const WORKSPACE_PATH_PREFIX = /^(skills|scripts|designs|tasks|memory|prompts|\.claude|\.githooks|jobs|config|completions)\//;

function sourceSkillsLib(snippet) {
  return spawnSync('bash', ['-c', `source ${shellSingleQuote(SKILLS_LIB)} && ${snippet}`], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function listSkillNames() {
  if (!fs.existsSync(SKILLS_DIR)) {
    return [];
  }
  return fs.readdirSync(SKILLS_DIR)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => fs.existsSync(path.join(SKILLS_DIR, name, `${name}.md`)))
    .sort();
}

// ---------------------------------------------------------------------------
// Scan 1 — Skill drift & self-containment
//   a. Reuse skills_validate over all skills (do NOT reimplement).
//   b. Diff a freshly generated INDEX against the committed skills/INDEX.md.
//   c. Grep every skills/*/ dir for hardcoded absolute paths — SCHEMA.md
//      mandates self-containment but the validator does not enforce it.
// ---------------------------------------------------------------------------
function scanSkillDrift() {
  const lines = [];

  // a. Validation (reuse skills_validate).
  const validate = sourceSkillsLib('skills_validate 2>&1');
  const validateOut = (validate.stdout || '').trim();
  const failLines = validateOut.split('\n').filter((l) => l.startsWith('FAIL:'));
  const warnLines = validateOut.split('\n').filter((l) => l.startsWith('WARN:'));
  if (failLines.length === 0) {
    lines.push(`- Validation: PASS (all skills valid)${warnLines.length ? `, ${warnLines.length} warn` : ''}`);
  } else {
    lines.push(`- Validation: ${failLines.length} FAIL`);
    for (const f of failLines) {
      lines.push(`  ${f}`);
    }
  }
  for (const w of warnLines) {
    lines.push(`  ${w}`);
  }

  // b. INDEX staleness — generate into a temp file, diff against committed INDEX.
  const committedIndexPath = path.join(SKILLS_DIR, 'INDEX.md');
  const committedIndex = fs.existsSync(committedIndexPath) ? fs.readFileSync(committedIndexPath, 'utf8') : '';
  // Generate a fresh index to a temp dir without touching the committed file:
  // we copy the generator output by re-running skills_generate_index against a
  // temp INDEX path via a small bash wrapper that overrides _SKILLS_DIR is not
  // safe; instead generate normally, capture, then restore. To stay strictly
  // read-only we snapshot, regenerate, read, and restore the original bytes.
  const fresh = regenerateIndexReadOnly(committedIndexPath, committedIndex);
  if (fresh === null) {
    lines.push('- INDEX: could not regenerate for comparison (skipped)');
  } else if (normalize(fresh) === normalize(committedIndex)) {
    lines.push('- INDEX: up to date (matches generated)');
  } else {
    lines.push('- INDEX: STALE — committed skills/INDEX.md differs from generated. Run `<agent> skills sync`.');
  }

  // c. Hardcoded-path self-containment grep.
  const violations = grepHardcodedPaths();
  if (violations.length === 0) {
    lines.push('- Self-containment: clean (no hardcoded /Users/ or ~/Developer/malvin paths in skills/)');
  } else {
    lines.push(`- Self-containment: ${violations.length} hardcoded-path violation(s) — SCHEMA.md mandates portability:`);
    for (const v of violations) {
      lines.push(`  ${v}`);
    }
  }

  // d. Straper publish drift — published skill modules whose git-archived HEAD
  //    content diverged from the .straper-publish.json ledger (reuses P6).
  for (const line of scanPublishDriftLines()) {
    lines.push(line);
  }

  return lines;
}

// Advisory publish-drift lines for the weekly review. Drifted/missing are
// actionable so they're enumerated; never-published is expected (publishing is
// opt-in) so it's a count only, not a noisy 20-skill list.
//
// Source resolution, in order:
//   1. `straper drift` CLI when resolvable (the published path). Its report is
//      surfaced verbatim — same drifted/missing/never-published semantics.
//   2. The local ledger reader scripts/lib/publish-drift.js when the straper
//      drift command isn't available but the legacy module is present, so an
//      unmigrated workspace behaves exactly as before.
//   3. Neither present → skip the scan with a notice.
function scanPublishDriftLines() {
  const straper = spawnSync('straper', ['drift', '--quiet'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  if (!straper.error && straper.status === 0) {
    const out = (straper.stdout || '').trim();
    if (!out) {
      return ['- Publish drift: none (published modules match HEAD)'];
    }
    return ['- Publish drift (via straper):'].concat(
      out.split('\n').map((l) => `  ${l.trim()}`),
    );
  }

  const legacyPath = path.join(ROOT_DIR, 'scripts', 'lib', 'publish-drift.js');
  if (!fs.existsSync(legacyPath)) {
    return ['- Publish drift: skipped (no straper drift command, no local ledger reader)'];
  }
  let computeDrift;
  try {
    ({ computeDrift } = require(legacyPath));
  } catch (_) {
    return ['- Publish drift: could not load the local ledger reader (skipped)'];
  }
  let drift;
  try {
    drift = computeDrift();
  } catch (_) {
    return ['- Publish drift: could not read the straper ledger (skipped)'];
  }
  const lines = [];
  if (drift.drifted.length === 0 && drift.missing.length === 0) {
    lines.push('- Publish drift: none (published modules match HEAD)');
  } else {
    if (drift.drifted.length > 0) {
      lines.push(`- Publish drift: ${drift.drifted.length} published module(s) drifted from the ledger — re-publish: ${drift.drifted.join(', ')}`);
    }
    if (drift.missing.length > 0) {
      lines.push(`- Publish drift: ${drift.missing.length} ledgered module(s) missing from skills/: ${drift.missing.join(', ')}`);
    }
  }
  if (drift.neverPublished.length > 0) {
    lines.push(`- Never published: ${drift.neverPublished.length} skill(s) not in the straper ledger (opt-in; count only).`);
  }
  return lines;
}

// Regenerate the index, read it, and restore the original bytes so the scan is
// strictly read-only. Returns the freshly generated content, or null on error.
function regenerateIndexReadOnly(indexPath, original) {
  try {
    const res = sourceSkillsLib('skills_generate_index >/dev/null 2>&1');
    if (res.status !== 0) {
      // Restore just in case the generator partially wrote.
      if (original) {
        fs.writeFileSync(indexPath, original, 'utf8');
      }
      return null;
    }
    const fresh = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
    // Restore the committed bytes — workspace-review must not mutate tracked files.
    fs.writeFileSync(indexPath, original, 'utf8');
    return fresh;
  } catch (err) {
    if (original) {
      try { fs.writeFileSync(indexPath, original, 'utf8'); } catch (_) { /* best-effort */ }
    }
    return null;
  }
}

function normalize(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function grepHardcodedPaths() {
  const violations = [];
  const patterns = [/\/Users\//, /~\/Developer\/malvin/];
  for (const skill of listSkillNames()) {
    // Skip our own skill dir — it necessarily contains the search patterns as
    // string literals / prose, which are not real portability violations.
    if (skill === 'workspace-review') {
      continue;
    }
    const dir = path.join(SKILLS_DIR, skill);
    walkFiles(dir, (file) => {
      // Only inspect text-ish skill source files.
      if (!/\.(md|js|sh|json|txt)$/.test(file)) {
        return;
      }
      const rel = path.relative(ROOT_DIR, file);
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch (_) {
        return;
      }
      const fileLines = content.split('\n');
      fileLines.forEach((line, idx) => {
        for (const pat of patterns) {
          if (pat.test(line)) {
            violations.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 120)}`);
            break;
          }
        }
      });
    });
  }
  return violations;
}

function walkFiles(dir, fn) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, fn);
    } else if (entry.isFile()) {
      fn(full);
    }
  }
}

// ---------------------------------------------------------------------------
// Scan 2 — Memory / pointer integrity
//   Cross-check MEMORY.md feedback_* references against on-disk
//   memory/feedback_*.md files. Flag orphans (on disk but not indexed) and
//   broken pointers (indexed but missing).
// ---------------------------------------------------------------------------
function scanMemoryIntegrity() {
  const lines = [];

  const onDisk = fs.existsSync(MEMORY_DIR)
    ? fs.readdirSync(MEMORY_DIR)
      .filter((f) => /^feedback_[a-z0-9_]+\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, ''))
    : [];
  const onDiskSet = new Set(onDisk);

  const indexContent = fs.existsSync(MEMORY_INDEX) ? fs.readFileSync(MEMORY_INDEX, 'utf8') : '';
  const referenced = new Set();
  const refRe = /feedback_[a-z0-9_]+/g;
  let m;
  while ((m = refRe.exec(indexContent)) !== null) {
    referenced.add(m[0]);
  }

  // Orphans: on disk but not referenced in MEMORY.md.
  const orphans = onDisk.filter((name) => !referenced.has(name)).sort();
  // Broken pointers: referenced in MEMORY.md but missing on disk.
  const broken = [...referenced].filter((name) => !onDiskSet.has(name)).sort();

  lines.push(`- Feedback files on disk: ${onDisk.length}, referenced in MEMORY.md: ${referenced.size}`);

  if (orphans.length === 0) {
    lines.push('- Orphans (on disk, not in MEMORY.md): none');
  } else {
    lines.push(`- Orphans (on disk, not in MEMORY.md): ${orphans.length}`);
    for (const name of orphans) {
      lines.push(`  ${name}`);
    }
  }

  if (broken.length === 0) {
    lines.push('- Broken pointers (in MEMORY.md, missing on disk): none');
  } else {
    lines.push(`- Broken pointers (in MEMORY.md, missing on disk): ${broken.length}`);
    for (const name of broken) {
      lines.push(`  ${name}`);
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Scan 3 — Tracking drift (best-effort heuristics, advisory)
//   a. in_progress tasks with failed workers.
//   b. FDs implemented-in-code but still status:design/open/planned.
// ---------------------------------------------------------------------------
function scanTrackingDrift() {
  const lines = [];

  // a. in_progress tasks with failed workers.
  const tasks = getAllTasks().map(({ task }) => task);
  const tasksWithFailedWorkers = tasks
    .filter((t) => t.status === 'in_progress')
    .map((t) => ({
      id: t.id,
      failed: (Array.isArray(t.workers) ? t.workers : []).filter((w) => w.status === 'failed'),
    }))
    .filter((t) => t.failed.length > 0);

  if (tasksWithFailedWorkers.length === 0) {
    lines.push('- in_progress tasks with failed workers: none');
  } else {
    lines.push(`- in_progress tasks with failed workers: ${tasksWithFailedWorkers.length}`);
    for (const t of tasksWithFailedWorkers) {
      lines.push(`  ${t.id}: failed workers = ${t.failed.map((w) => w.id).join(', ')}`);
    }
  }

  // b. Implemented-but-unclosed FDs.
  const implementedUnclosed = findImplementedUnclosedFds();
  if (implementedUnclosed.length === 0) {
    lines.push('- FDs implemented-in-code but not closed: none detected');
  } else {
    lines.push(`- FDs implemented-in-code but still ${[...NON_TERMINAL_FD_STATUSES].join('/')}: ${implementedUnclosed.length} (advisory — verify before closing)`);
    for (const fd of implementedUnclosed) {
      lines.push(`  ${fd.id} (status:${fd.status}) — ${fd.exist}/${fd.total} referenced workspace files exist (${Math.round(fd.ratio * 100)}%)`);
    }
  }

  return lines;
}

function findImplementedUnclosedFds() {
  let index;
  try {
    index = readDesignIndex();
  } catch (_) {
    return [];
  }

  const flagged = [];
  for (const row of index) {
    if (!NON_TERMINAL_FD_STATUSES.has(row.status)) {
      continue;
    }
    let design;
    try {
      design = readDesign(row.id);
    } catch (_) {
      continue;
    }

    const refs = extractWorkspacePaths(design.body);
    if (refs.length < 5) {
      // Too few file references to judge — skip (avoids false positives).
      continue;
    }
    let exist = 0;
    for (const rel of refs) {
      if (fs.existsSync(path.join(ROOT_DIR, rel))) {
        exist += 1;
      }
    }
    const ratio = exist / refs.length;
    if (ratio >= 0.6) {
      flagged.push({ id: row.id, status: row.status, exist, total: refs.length, ratio });
    }
  }
  return flagged;
}

function extractWorkspacePaths(body) {
  const set = new Set();
  const re = /`([A-Za-z0-9_.\/-]+\.(?:md|js|sh|json|ts|tsx))`/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const p = m[1];
    if (p.startsWith('/') || p.startsWith('~') || p.startsWith('http')) {
      continue;
    }
    if (WORKSPACE_PATH_PREFIX.test(p)) {
      set.add(p);
    }
  }
  return [...set];
}

// ---------------------------------------------------------------------------
// Command: workspace-review (deterministic scans)
// ---------------------------------------------------------------------------
function commandWorkspaceReview(args) {
  // skillify subcommand routes to the scaffold playbook.
  if (args[0] === 'skillify') {
    return commandSkillify(args.slice(1));
  }

  const today = formatDate(new Date());

  console.log(`# Workspace Review — Health & Drift (${today})`);
  console.log('');
  console.log('Read-only, advisory. Nothing here is mutated; fixes are ack-gated or via `workspace-review skillify`.');
  console.log('');

  console.log('## Scan 1 — Skill drift & self-containment');
  for (const line of scanSkillDrift()) {
    console.log(line);
  }
  console.log('');

  console.log('## Scan 2 — Memory / pointer integrity');
  for (const line of scanMemoryIntegrity()) {
    console.log(line);
  }
  console.log('');

  console.log('## Scan 3 — Tracking drift (heuristic, advisory)');
  for (const line of scanTrackingDrift()) {
    console.log(line);
  }
  console.log('');

  console.log('## Scan 4 — Feedback & repeated-action harvest (agent-driven)');
  console.log('- This deterministic CLI covers scans 1-3 only.');
  console.log('- Run the `/workspace-review` skill for the agent-driven feedback/repeated-action');
  console.log('  harvest that ranks candidate skills (advisory + ack-gated). See');
  console.log('  prompts/workspace-review.md.');
  console.log('');
  console.log('Next: surface findings to the user. Promote MEMORY.md/skill fixes only on their ack.');
  console.log('To scaffold an ACKED candidate into a skill: `<agent> workspace-review skillify <name>`.');
}

// ---------------------------------------------------------------------------
// Subcommand: skillify <candidate> — scaffold an ACKED candidate into a skill.
//
// Folded in (NOT a standalone skill) because candidate SELECTION lives in the
// harvest above — a bare /skillify has no entry point. This scaffolds + emits
// the 10-step skill-authoring checklist; it does NOT fully autogenerate the skill.
// ---------------------------------------------------------------------------
function commandSkillify(args) {
  const candidate = (args.find((a) => !a.startsWith('-')) || '').trim();
  const dryRun = hasFlag(args, '--dry-run');
  const withScript = hasFlag(args, '--with-script');

  if (!candidate) {
    throw new Error('Usage: scripts/<agent> workspace-review skillify <candidate-name> [--with-script] [--dry-run]');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(candidate)) {
    throw new Error(`Invalid skill name '${candidate}' — must be kebab-case (lowercase, digits, hyphens).`);
  }

  const skillDir = path.join(SKILLS_DIR, candidate);
  if (fs.existsSync(skillDir)) {
    throw new Error(`skills/${candidate}/ already exists — pick a different name or remove it first.`);
  }

  const mdPath = path.join(skillDir, `${candidate}.md`);
  const scriptName = `${candidate}-commands.js`;
  const scriptPath = path.join(skillDir, scriptName);

  const mdTemplate = renderSkillTemplate(candidate, withScript ? scriptName : null);
  const scriptTemplate = withScript ? renderScriptTemplate(candidate) : null;

  console.log(`# skillify — scaffold candidate '${candidate}'`);
  console.log('');

  if (dryRun) {
    console.log('Dry run — no files written. Would create:');
    console.log(`- skills/${candidate}/${candidate}.md`);
    if (withScript) {
      console.log(`- skills/${candidate}/${scriptName}`);
    }
    console.log('');
  } else {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(mdPath, mdTemplate, 'utf8');
    console.log(`Created skills/${candidate}/${candidate}.md`);
    if (withScript) {
      fs.writeFileSync(scriptPath, scriptTemplate, 'utf8');
      console.log(`Created skills/${candidate}/${scriptName}`);
    }
    console.log('');
  }

  console.log('## Wire-up (manual, before validate passes)');
  if (withScript) {
    console.log(`- Add a \`cli_command: ${candidate}\` route in scripts/<agent>.js (import the command, add a \`case '${candidate}'\`, add it to SKILL_BY_COMMAND, add a usage line).`);
  } else {
    console.log('- Prompt-only skill: no cli_command needed. Coverage comes from the `## Metrics` step.');
  }
  console.log('');

  console.log('## Skillify checklist (worker-dispatch plan)');
  console.log('Operationalizes Garry Tan\'s 10-step pattern — "the latent space builds the deterministic tool, then the deterministic tool constrains the latent space."');
  console.log('1. SKILL.md — purpose, arguments, execution, examples (scaffolded above; fill in).');
  console.log('2. Deterministic code — the backing script/command that does the real work.');
  console.log('3. Unit tests — cover the deterministic logic (node --test / bash harness).');
  console.log('4. Integration tests — exercise the skill end-to-end in the workspace.');
  console.log('5. LLM evals — confirm the agent invokes the skill on the triggering ask.');
  console.log('6. Resolver trigger — register triggers (slash / hook / compose) so it fires automatically.');
  console.log('7. Resolver eval — verify the trigger routes to this skill and not a sibling.');
  console.log('8. DRY audit — check no other skill/script already does this; reuse over reinvent.');
  console.log('9. E2E smoke test — one real invocation against the live workspace.');
  console.log('10. Filing rules — document where outputs land (memory/brain/holding dir).');
  console.log('');
  console.log('## Verify');
  console.log(`- \`./scripts/<agent> skills validate ${candidate}\` → must PASS (fix frontmatter/wiring until it does).`);
  console.log('- `./scripts/<agent> skills sync` → regenerates INDEX.md + command pointer.');
  console.log('- Then open a task and dispatch a worker for the checklist above.');
}

function renderSkillTemplate(name, scriptName) {
  const backing = scriptName ? `backing_script: ${scriptName}\n` : '';
  const cli = scriptName ? `cli_command: ${name}\n` : '';
  const metricsNote = scriptName
    ? 'Covered automatically via the <agent>.js CLI chokepoint (cli_command).'
    : 'Add a `## Metrics` step calling `skills_log_event` (prompt-only skills have no CLI path).';
  return `---
name: ${name}
description: TODO — one-line summary of what this skill does
version: 1
visibility: user
triggers:
  - /${name}
${cli}${backing}depends_on: []
composes: []
---

## Purpose

TODO — what this skill does and when to use it (1-2 sentences).

## Arguments

\`\`\`
/${name} [args]
\`\`\`

| Argument | Required | Description |
|----------|----------|-------------|
| (none yet) | — | TODO |

## Execution

1. TODO — step-by-step instructions the agent follows.

## Examples

\`\`\`
/${name}
→ TODO — describe the outcome
\`\`\`

## Metrics

${metricsNote}
`;
}

function renderScriptTemplate(name) {
  const fnName = `command${name.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')}`;
  return `const { ROOT_DIR } = require('../../scripts/lib/cli-utils.js');

// ${name} — TODO implement the deterministic logic.
function ${fnName}(args) {
  console.log('${name}: not implemented yet');
  void ROOT_DIR;
  void args;
}

module.exports = {
  ${fnName},
};
`;
}

module.exports = {
  commandWorkspaceReview,
  commandSkillify,
};
