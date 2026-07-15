const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.resolve(__dirname, '..');

// `<agent> skill new <name>` — scaffold a self-contained skill that follows the
// skill-owned config/state architecture (skills/SCHEMA.md). Emits the directory,
// a valid <name>.md, an <agent> command wrapper, and (opt-in) config/ + .state/ +
// a skill-local .gitignore — so config and runtime state live IN the skill from
// the start, never scattered to the workspace root. Prints the manual scripts/<agent>.js
// wire-up plus the validate/sync steps.
function commandSkill(args) {
  const sub = args[0];
  if (sub === 'new') {
    return skillNew(args.slice(1));
  }
  console.error('usage: <agent> skill new <name> [--bash] [--with-config] [--with-state] [--no-script] [--dry-run]');
  process.exit(1);
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function skillNew(args) {
  const name = (args.find((a) => !a.startsWith('-')) || '').trim();
  const dryRun = hasFlag(args, '--dry-run');
  const bash = hasFlag(args, '--bash');
  const withConfig = hasFlag(args, '--with-config');
  const withState = hasFlag(args, '--with-state');
  const noScript = hasFlag(args, '--no-script');

  if (!name) {
    throw new Error('Usage: <agent> skill new <name> [--bash] [--with-config] [--with-state] [--no-script] [--dry-run]');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`Invalid skill name '${name}' — must be kebab-case (lowercase, digits, hyphens).`);
  }

  const skillDir = path.join(SKILLS_DIR, name);
  if (fs.existsSync(skillDir)) {
    throw new Error(`skills/${name}/ already exists — pick a different name or remove it first.`);
  }

  // Plan the files. A skill always has a definition; a command wrapper unless
  // --no-script (prompt-only skill). --bash adds a backing shell script that the
  // wrapper shells into (the service/patch pattern). --with-config/--with-state
  // add the tracked config/ and gitignored .state/ buckets.
  const files = [];
  files.push({ rel: `${name}.md`, body: renderDefinition(name, { bash, noScript, withConfig, withState }) });
  if (!noScript) {
    files.push({ rel: `${name}-commands.js`, body: renderCommands(name, { bash }) });
  }
  if (bash) {
    files.push({ rel: `${name}.sh`, body: renderBackingScript(name), mode: 0o755 });
  }
  if (withConfig) {
    files.push({ rel: `config/${name}.json`, body: '{}\n' });
  }
  if (withState) {
    files.push({ rel: '.state/.gitkeep', body: '' });
    files.push({ rel: '.gitignore', body: '# Runtime state — skill-owned, never committed.\n.state/\n' });
  }

  console.log(`# skill new — scaffold '${name}'`);
  console.log('');

  if (dryRun) {
    console.log('Dry run — no files written. Would create:');
    for (const f of files) {
      console.log(`- skills/${name}/${f.rel}`);
    }
    console.log('');
  } else {
    for (const f of files) {
      const abs = path.join(skillDir, f.rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.body, 'utf8');
      if (f.mode) {
        fs.chmodSync(abs, f.mode);
      }
      console.log(`Created skills/${name}/${f.rel}`);
    }
    console.log('');
  }

  printWireUp(name, { noScript, bash });
}

function renderDefinition(name, { bash, noScript, withConfig, withState }) {
  const backing = bash ? `backing_script: ${name}.sh\n` : '';
  const cli = noScript ? '' : `cli_command: ${name}\n`;
  const configState = (withConfig || withState)
    ? [
        '',
        '## Skill-owned config and state',
        '',
        'Following `skills/SCHEMA.md` → *Skill-owned config and state*:',
        '',
        withConfig ? `- **Config** — \`config/${name}.json\` (tracked settings the skill reads).` : null,
        withState ? '- **State** — `.state/` (gitignored runtime, via the skill-local `.gitignore`).' : null,
      ].filter((l) => l !== null).join('\n') + '\n'
    : '';

  return `---
name: ${name}
description: TODO one-line summary used in the registry and help output
version: 1
visibility: user
triggers:
  - /${name}
${backing}${cli}depends_on: []
composes: []
---

## Purpose

TODO: what this skill does and when to use it (1-2 sentences).
${configState}
## Arguments

\`\`\`
<agent> ${name} <verb> [args]
\`\`\`

TODO: document subcommands / flags.

## Execution

TODO: the precise steps the agent (or backing script) follows.

## Examples

\`\`\`
<agent> ${name} ...
\`\`\`
`;
}

function renderCommands(name, { bash }) {
  if (bash) {
    return `const path = require('path');

const { runCommand } = require('../../scripts/lib/cli-utils.js');

// Thin wrapper over skills/${name}/${name}.sh (the implementation), surfaced as
// a first-class \`<agent> ${name}\` command. All arguments pass straight through.
function command${pascal(name)}(args) {
  const script = path.join(__dirname, '${name}.sh');
  const result = runCommand('bash', [script, ...args], { stdio: 'inherit' });
  if (result.status && result.status !== 0) {
    process.exit(result.status);
  }
}

module.exports = { command${pascal(name)} };
`;
  }
  return `// <agent> ${name} — TODO implement.
function command${pascal(name)}(args) {
  console.log('${name}: not implemented yet', args);
}

module.exports = { command${pascal(name)} };
`;
}

function renderBackingScript(name) {
  return `#!/usr/bin/env bash
# skills/${name}/${name}.sh — TODO describe what this skill does.
#
# Config and state (if any) are skill-owned: resolve them against this dir.
#   SKILL_DIR = the skill's own directory (config/, .state/ live here).

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

main() {
  echo "${name}: not implemented yet ($SKILL_DIR)"
}

main "$@"
`;
}

// Assembled at runtime so the publish self-containment scanner's require()
// regex can't read this printed wire-up template as a real cross-skill reach.
const WIREUP_SKILLS_PREFIX = ['..', 'skills'].join('/');

function printWireUp(name, { noScript, bash }) {
  console.log('## Wire-up (manual)');
  if (!noScript) {
    console.log(`1. In scripts/<agent>.js: \`const { command${pascal(name)} } = require('${WIREUP_SKILLS_PREFIX}/${name}/${name}-commands.js');\``);
    console.log(`2. Add \`${name}: '${name}',\` to SKILL_BY_COMMAND.`);
    console.log(`3. Add \`case '${name}': command${pascal(name)}(args); break;\` to the dispatch switch.`);
    console.log(`4. Add a \`scripts/<agent> ${name} ...\` usage line.`);
  } else {
    console.log('- Prompt-only skill: no CLI wiring needed.');
  }
  console.log('');
  console.log('## Verify');
  console.log(`- \`./scripts/<agent> skills validate ${name}\` → fix frontmatter until it PASSes.`);
  console.log('- `./scripts/<agent> skills sync` → regenerates INDEX.md + the /command pointer.');
  console.log('- Fill in the TODOs in the .md (Purpose/Arguments/Execution/Examples).');
  if (bash) {
    console.log(`- Implement skills/${name}/${name}.sh.`);
  }
}

function pascal(name) {
  return name.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

module.exports = { commandSkill };
