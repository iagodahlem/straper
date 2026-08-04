// Skills-framework metrics sink, delegated to by scripts/lib/cli-runtime.js.
//
// The workspace CLI's dispatcher looks for this exact file
// (skills/lib/metrics.js) after every command it routes and calls
// logSkillMetric() so `.metrics/skills.jsonl` gets a row per invocation (see
// `skills stats` / `skills validate --stats` in scripts/lib/skills.sh). Schema
// matches scripts/lib/skills.sh#skills_log exactly, so bash-invoked skills
// (composition, hooks) and CLI-invoked commands land in the same file with
// the same shape.
//
// This file is not part of the `straper init` baseline — a brand-new,
// zero-skill workspace has no skills/ directory at all. It is copied into
// skills/lib/metrics.js the first time a workspace vendors a module
// (`straper add` / `straper migrate`), which is when skills/ starts to exist.
// It is never overwritten once present, so local edits survive re-adds.

const fs = require('fs');
const path = require('path');

const { ROOT_DIR } = require('../../scripts/lib/cli-utils.js');

const METRICS_DIR = path.join(ROOT_DIR, '.metrics');
const SKILLS_METRICS_FILE = path.join(METRICS_DIR, 'skills.jsonl');

function logSkillMetric(skill, action, trigger, durationMs, ok, error = '', model = '') {
  try {
    fs.mkdirSync(METRICS_DIR, { recursive: true });

    const entry = {
      skill,
      action,
      trigger,
      at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : 0,
      ok: Boolean(ok),
    };

    if (error) {
      entry.error = error;
    }

    if (model) {
      entry.model = model;
    }

    fs.appendFileSync(SKILLS_METRICS_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Metrics should never break the CLI.
  }
}

module.exports = { logSkillMetric };
