// Workspace CLI engine — registry-driven.
//
// This is the reusable dispatcher behind the thin per-agent entry
// (scripts/<agent>.js). It discovers commands at invocation by scanning the
// INSTALLED skill modules under skills/*/commands.json, never static-requiring a
// skill: a handler is loaded lazily, only when its command actually runs. That
// makes the three built-ins (help, skills, completion) work in a workspace with
// zero skills installed, and keeps a broken/optional module from taking down the
// whole CLI at load.
//
// The agent name is derived at runtime from the invoked entry script, so this
// engine is copied verbatim into every workspace with no per-agent templating.
//
// See docs/workspace-cli.md for the commands.json contract and the straper-vs-<agent>
// separation.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { ROOT_DIR, shellQuote } = require('./cli-utils.js');

// Skill metrics belong to the skills framework, not the runtime baseline. When
// the framework ships a JS sink (skills/lib/metrics.js) we delegate to it; with
// no skills installed this is a no-op, so a zero-skill workspace still runs.
function logSkillMetric(...metricArgs) {
  try {
    const sink = require(path.join(ROOT_DIR, 'skills', 'lib', 'metrics.js'));
    if (sink && typeof sink.logSkillMetric === 'function') {
      sink.logSkillMetric(...metricArgs);
    }
  } catch {
    // No skills-framework metrics sink installed — metrics are disabled.
  }
}

const AGENT_NAME = path.basename(process.argv[1] || 'agent', '.js');
const SKILLS_DIR = path.join(ROOT_DIR, 'skills');
const SKILLS_LIB = path.join(ROOT_DIR, 'scripts', 'lib', 'skills.sh');

// Reserved names a module may not claim — they are always served by this file.
const BUILTIN_NAMES = new Set(['help', 'completion', 'skills']);

// Help-only specs for the built-ins, so they appear in the overview, in
// `help <builtin>`, and in generated completions alongside module commands.
const BUILTINS = [
  { command: 'help', summary: 'Show this overview, or detailed help for a command.', args: '[command]' },
  {
    command: 'skills',
    summary: 'List, validate, sync, export, or import workspace skills.',
    args: '<list|validate [skill]|stats|sync|export <name>|export --all|import <path>>',
    subcommands: [
      { name: 'list' }, { name: 'validate' }, { name: 'stats' },
      { name: 'sync' }, { name: 'export' }, { name: 'import' },
    ],
  },
  { command: 'completion', summary: 'Print a shell completion script.', args: '<bash|zsh>' },
];

// ---------------------------------------------------------------------------
// DEPRECATED legacy fallback.
//
// Registry modules do not yet ship a commands.json (the module-side command
// specs land in a separate change). Without a bridge, publishing this
// registry-driven dispatcher would drop every real command (fd-new, ship, …)
// from EXISTING generated workspaces the moment they update, because discovery
// would find no specs. This table is that bridge: for the known current modules,
// if a command is NOT declared by any commands.json AND the module's handler
// file exists on disk, route it via this static map.
//
// It is intentionally scoped to the modules the pre-separation dispatcher knew.
// Remove this table once those modules publish their own commands.json — a
// zero-skill workspace registers none of these (the handler files are absent),
// so the fallback never weakens the zero-skill boot guarantee.
// ---------------------------------------------------------------------------
const LEGACY_COMMANDS = [
  {
    command: 'fd-new', module: 'fd', handler: 'fd-commands.js#commandFdNew',
    summary: 'Create a feature design and append it to designs/INDEX.md.',
    args: '<title>',
    flags: [
      { flag: '--effort <small|medium|large>', summary: 'Sizing estimate (default: medium).' },
      { flag: '--priority <low|medium|high|critical>', summary: 'Priority (default: medium).' },
      { flag: '--repo <repo>', summary: 'Repo hint recorded in the design.' },
      { flag: '--provider-hint <claude|codex>', summary: 'Preferred worker provider.' },
      { flag: '--profile-hint <fast|strong>', summary: 'Preferred worker profile.' },
      { flag: '--branch-suffix <suffix>', summary: 'Branch-name suffix hint.' },
      { flag: '--verification-command <command>', summary: 'Verification command hint.' },
      { flag: '--dry-run', summary: 'Preview without writing files.' },
    ],
    metric: { skill: 'fd', action: 'new' },
  },
  {
    command: 'fd-new-prompt', module: 'fd', handler: 'fd-commands.js#commandFdNewPrompt',
    summary: 'Render the fd-new prompt instead of creating the design directly.',
    args: '<title>',
    flags: [
      { flag: '--effort <small|medium|large>', summary: 'Sizing estimate (default: medium).' },
      { flag: '--priority <low|medium|high|critical>', summary: 'Priority (default: medium).' },
      { flag: '--repo <repo>', summary: 'Repo hint recorded in the design.' },
      { flag: '--dry-run', summary: 'Preview only.' },
    ],
    metric: { skill: 'fd', action: 'new-prompt' },
  },
  {
    command: 'fd-close', module: 'fd', handler: 'fd-commands.js#commandFdClose',
    summary: 'Archive a feature design once its sub-items are complete.',
    args: '<FD-ID>',
    flags: [
      { flag: '--force', summary: 'Archive even if incomplete.' },
      { flag: '--dry-run', summary: 'Preview only.' },
    ],
    metric: { skill: 'fd', action: 'close' },
  },
  {
    command: 'fd-status', module: 'fd', handler: 'fd-commands.js#commandFdStatus',
    summary: 'Show a status table of all feature designs.',
    metric: { skill: 'fd', action: 'status' },
  },
  {
    command: 'fd-work-prompt', module: 'fd', handler: 'fd-commands.js#commandFdWorkPrompt',
    summary: 'Render the worker prompt for one sub-item of a feature design.',
    args: '<FD-ID> <SUB-ITEM>',
    flags: [{ flag: '--base <branch>', summary: 'Override the base branch.' }],
    metric: { skill: 'fd', action: 'work-prompt' },
  },
  {
    command: 'worker', module: 'fd', handler: 'fd-commands.js#commandWorker',
    summary: 'Launch a provider-aware worker for a design sub-item.',
    args: '<FD-ID> <SUB-ITEM>',
    flags: [
      { flag: '--provider <claude|codex>', summary: 'Worker CLI to launch.' },
      { flag: '--profile <fast|strong>', summary: 'Model profile.' },
      { flag: '--model <model>', summary: 'Explicit model override.' },
      { flag: '--base <branch>', summary: 'Base branch override.' },
      { flag: '--dry-run', summary: 'Print the command without launching.' },
    ],
    metric: { skill: 'fd', action: 'worker' },
  },
  {
    command: 'worktree', module: 'worktree', handler: 'worktree-commands.js#commandWorktree',
    summary: 'Create a git worktree under workspaces/ for a new branch.',
    args: '<repo> <branch-name>',
    flags: [
      { flag: '--base <branch>', summary: 'Base branch/ref.' },
      { flag: '--dry-run', summary: 'Preview only.' },
    ],
    metric: { skill: 'worktree', action: 'create' },
  },
  {
    command: 'sync-branch', module: 'sync-branch', handler: 'sync-branch-commands.js#commandSyncBranch',
    summary: "Fetch and rebase a worktree's branch onto its base branch.",
    args: '[<worktree-name>]',
    flags: [
      { flag: '--base <branch>', summary: 'Rebase target.' },
      { flag: '--dry-run', summary: 'Preview only.' },
    ],
    metric: { skill: 'sync-branch', action: 'sync' },
  },
  {
    command: 'ship', module: 'ship', handler: 'ship-commands.js#commandShip',
    summary: 'Verify, push, and optionally open a PR for a worktree.',
    args: '[<worktree-name>]',
    flags: [
      { flag: '--base <branch>', summary: 'Base branch for the diff/PR.' },
      { flag: '--tier <1|2>', summary: 'Verification tier.' },
      { flag: '--quick', summary: 'Lint only changed files.' },
      { flag: '--skip-verify', summary: 'Skip verification.' },
      { flag: '--push', summary: 'Push the branch to origin.' },
      { flag: '--create-pr', summary: 'Open a PR via gh.' },
      { flag: '--title <title>', summary: 'Override the PR title.' },
      { flag: '--body-file <path>', summary: 'Read the PR body from a file.' },
      { flag: '--dry-run', summary: 'Preview only.' },
    ],
    metric: { skill: 'ship', action: 'run' },
  },
  {
    command: 'ship-prompt', module: 'ship', handler: 'ship-commands.js#commandShipPrompt',
    summary: 'Render the shipping-workflow prompt instead of running it.',
    args: '[<worktree-name>]',
    flags: [
      { flag: '--base <branch>', summary: 'Base branch for the diff/PR.' },
      { flag: '--tier <1|2>', summary: 'Verification tier.' },
      { flag: '--quick', summary: 'Lint only changed files.' },
      { flag: '--skip-verify', summary: 'Skip verification.' },
      { flag: '--push', summary: 'Push the branch to origin.' },
      { flag: '--create-pr', summary: 'Open a PR via gh.' },
      { flag: '--title <title>', summary: 'Override the PR title.' },
      { flag: '--body-file <path>', summary: 'Read the PR body from a file.' },
      { flag: '--dry-run', summary: 'Preview only.' },
    ],
    metric: { skill: 'ship', action: 'prompt' },
  },
  {
    command: 'session', module: 'session', handler: 'session-commands.js#commandSession',
    summary: 'Inspect and manage session records.',
    args: '<list|close-all|history|info <id>|resume <name-or-id>|handoff ...>',
    subcommands: [
      { name: 'list' }, { name: 'close-all' }, { name: 'history' },
      { name: 'info' }, { name: 'resume' }, { name: 'handoff' },
    ],
    metric: { skill: 'session', actionFromArg: true },
  },
  {
    command: 'session-review', module: 'session-review', handler: 'session-review-commands.js#commandSessionReview',
    summary: 'Print a status report of active tasks, designs, workers, and loose ends.',
    flags: [
      { flag: '--run-session-end', summary: 'Also run scripts/session-end.sh.' },
      { flag: '--dry-run', summary: 'Preview only.' },
    ],
    metric: { skill: 'session-review', action: 'run' },
  },
  {
    command: 'session-review-prompt', module: 'session-review', handler: 'session-review-commands.js#commandSessionReviewPrompt',
    summary: 'Render the session-review prompt instead of running it.',
    flags: [
      { flag: '--run-session-end', summary: 'Also run scripts/session-end.sh.' },
      { flag: '--dry-run', summary: 'Preview only.' },
    ],
    metric: { skill: 'session-review', action: 'prompt' },
  },
  {
    command: 'slack-status', module: 'slack-status', handler: 'slack-status-commands.js#commandSlackStatus',
    summary: 'Check, clear, or set the Slack status.',
    args: '<check|clear|clear-all|set "<text>">',
    subcommands: [
      { name: 'check' }, { name: 'clear' }, { name: 'clear-all' }, { name: 'set' },
    ],
    metric: { skill: 'slack-status', actionFromArg: true },
  },
];

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function listSkillDirs() {
  let entries;
  try {
    entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return []; // No skills/ directory at all — zero-skill workspace.
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

function normalizeSpec(spec, moduleName) {
  if (!spec || typeof spec.command !== 'string' || typeof spec.handler !== 'string') {
    return null;
  }
  return {
    command: spec.command,
    module: moduleName,
    handler: spec.handler,
    summary: typeof spec.summary === 'string' ? spec.summary : '',
    args: typeof spec.args === 'string' ? spec.args : '',
    flags: Array.isArray(spec.flags) ? spec.flags : [],
    subcommands: Array.isArray(spec.subcommands) ? spec.subcommands : [],
    metric: spec.metric && typeof spec.metric === 'object' ? spec.metric : null,
  };
}

// Build the command registry from installed modules' commands.json, then fill
// gaps from the deprecated legacy table. First-wins on duplicates; modules are
// scanned in sorted order so the winner is deterministic. Warnings collected,
// never thrown — discovery must not break the built-ins.
function discoverCommands() {
  const registry = new Map();
  const warnings = [];

  for (const moduleName of listSkillDirs()) {
    const specPath = path.join(SKILLS_DIR, moduleName, 'commands.json');
    if (!fs.existsSync(specPath)) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    } catch (error) {
      warnings.push(`skipping invalid commands.json in skill '${moduleName}': ${error.message}`);
      continue;
    }
    if (!Array.isArray(parsed)) {
      warnings.push(`skipping commands.json in skill '${moduleName}': expected a JSON array`);
      continue;
    }

    for (const raw of parsed) {
      const spec = normalizeSpec(raw, moduleName);
      if (!spec) {
        warnings.push(`skipping malformed command entry in skill '${moduleName}' (needs 'command' and 'handler')`);
        continue;
      }
      if (BUILTIN_NAMES.has(spec.command)) {
        warnings.push(`skill '${moduleName}' cannot override built-in command '${spec.command}' — ignoring`);
        continue;
      }
      const existing = registry.get(spec.command);
      if (existing) {
        warnings.push(`command '${spec.command}' declared by both '${existing.module}' and '${moduleName}' — keeping '${existing.module}'`);
        continue;
      }
      registry.set(spec.command, spec);
    }
  }

  // Deprecated bridge: only for commands no module declared, whose handler exists.
  for (const legacy of LEGACY_COMMANDS) {
    if (registry.has(legacy.command)) {
      continue;
    }
    const file = legacy.handler.split('#')[0];
    if (!fs.existsSync(path.join(SKILLS_DIR, legacy.module, file))) {
      continue;
    }
    registry.set(legacy.command, { ...legacy, flags: legacy.flags || [], subcommands: legacy.subcommands || [], deprecated: true });
  }

  return { registry, warnings };
}

function loadHandler(entry) {
  const [file, exportName] = entry.handler.split('#');
  const absolute = path.join(SKILLS_DIR, entry.module, file);
  const mod = require(absolute);
  const fn = exportName ? mod[exportName] : (typeof mod === 'function' ? mod : mod.default);
  if (typeof fn !== 'function') {
    throw new Error(`Handler '${entry.handler}' in skill '${entry.module}' did not resolve to a function`);
  }
  return fn;
}

// ---------------------------------------------------------------------------
// Flag parsing (shared by help + completion rendering)
// ---------------------------------------------------------------------------

function parseFlag(flagDisplay) {
  const match = String(flagDisplay).match(/^(--?[A-Za-z][\w-]*)(?:\s+<([^>]+)>)?/);
  if (!match) {
    return null;
  }
  const token = match[1];
  const inner = match[2];
  if (!inner) {
    return { token, kind: 'boolean' };
  }
  if (inner.includes('|') && !/\s/.test(inner)) {
    return { token, kind: 'choice', choices: inner.split('|') };
  }
  return { token, kind: 'value', placeholder: inner };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function padEnd(value, width) {
  return String(value).padEnd(width, ' ');
}

function renderOverview(registry) {
  const moduleEntries = [...registry.values()];
  const allNames = [...moduleEntries.map((e) => e.command), ...BUILTINS.map((b) => b.command)];
  const nameWidth = Math.max(...allNames.map((n) => n.length));

  const lines = [`${AGENT_NAME} — workspace CLI`, ''];

  const byModule = new Map();
  for (const entry of moduleEntries) {
    if (!byModule.has(entry.module)) {
      byModule.set(entry.module, []);
    }
    byModule.get(entry.module).push(entry);
  }

  for (const moduleName of [...byModule.keys()].sort()) {
    lines.push(`${moduleName}:`);
    for (const entry of byModule.get(moduleName).sort((a, b) => a.command.localeCompare(b.command))) {
      lines.push(`  ${padEnd(entry.command, nameWidth)}  ${entry.summary}`);
    }
    lines.push('');
  }

  lines.push('Built-in:');
  for (const entry of BUILTINS) {
    lines.push(`  ${padEnd(entry.command, nameWidth)}  ${entry.summary}`);
  }
  lines.push('');

  if (moduleEntries.length === 0) {
    lines.push('No skill commands installed yet. Add a skill module to contribute commands.');
    lines.push('');
  }

  lines.push(`Run '${AGENT_NAME} help <command>' for details.`);
  return lines.join('\n');
}

function renderCommandHelp(entry) {
  const lines = [`${entry.command} — ${entry.summary}`];
  if (entry.module) {
    lines.push(`Skill: ${entry.module}${entry.deprecated ? ' (legacy fallback — pending commands.json)' : ''}`);
  }

  const usageParts = [AGENT_NAME, entry.command];
  if (entry.args) {
    usageParts.push(entry.args);
  }
  for (const flag of entry.flags || []) {
    usageParts.push(`[${flag.flag}]`);
  }
  lines.push('', 'Usage:', `  ${usageParts.join(' ')}`);

  if (entry.subcommands && entry.subcommands.length > 0) {
    lines.push('', 'Subcommands:');
    for (const sub of entry.subcommands) {
      lines.push(`  ${sub.name}${sub.summary ? `  ${sub.summary}` : ''}`);
    }
  }

  if (entry.flags && entry.flags.length > 0) {
    const flagWidth = Math.max(...entry.flags.map((f) => f.flag.length));
    lines.push('', 'Options:');
    for (const flag of entry.flags) {
      lines.push(`  ${padEnd(flag.flag, flagWidth)}  ${flag.summary || ''}`);
    }
  }

  return lines.join('\n');
}

function findEntry(registry, name) {
  if (registry.has(name)) {
    return registry.get(name);
  }
  return BUILTINS.find((b) => b.command === name) || null;
}

function suggestCommands(registry, input) {
  const names = [...registry.keys(), ...BUILTINS.map((b) => b.command)];
  const target = String(input || '');
  return names
    .filter((name) => name.startsWith(target) || target.startsWith(name) || name.includes(target))
    .sort()
    .slice(0, 3);
}

function printUnknownCommand(registry, command) {
  console.error(`Unknown command: ${command}`);
  const suggestions = suggestCommands(registry, command);
  if (suggestions.length > 0) {
    console.error('');
    console.error('Did you mean:');
    for (const suggestion of suggestions) {
      console.error(`  ${suggestion}`);
    }
  }
  const available = [...registry.keys(), ...BUILTINS.map((b) => b.command)].sort();
  console.error('');
  console.error(`Available commands: ${available.join(', ')}`);
  console.error(`Run '${AGENT_NAME} help' for details.`);
}

function handleHelpRequest(registry, args) {
  const target = args.find((arg) => !arg.startsWith('-'));
  if (!target) {
    console.log(renderOverview(registry));
    return 0;
  }
  const entry = findEntry(registry, target);
  if (!entry) {
    printUnknownCommand(registry, target);
    return 1;
  }
  console.log(renderCommandHelp(entry));
  return 0;
}

// ---------------------------------------------------------------------------
// Completion generation (rendered at runtime from the discovered registry)
// ---------------------------------------------------------------------------

function completionEntries(registry) {
  // Module commands + the built-ins, sorted, so completions match the overview.
  const entries = [...registry.values()];
  entries.push(
    { command: 'completion', flags: [], subcommands: [{ name: 'bash' }, { name: 'zsh' }] },
    ...BUILTINS.filter((b) => b.command !== 'completion'),
  );
  return entries.sort((a, b) => a.command.localeCompare(b.command));
}

function renderBashCompletion(registry) {
  const entries = completionEntries(registry);
  const topLevel = entries.map((e) => e.command).join(' ');
  const lines = [];
  lines.push('# generated at runtime — do not hand-edit');
  lines.push(`_${AGENT_NAME}_completion() {`);
  lines.push('  local cur');
  lines.push('  cur="${COMP_WORDS[COMP_CWORD]}"');
  lines.push('');
  lines.push(`  local commands="${topLevel}"`);
  lines.push('');
  lines.push('  if [[ ${COMP_CWORD} -eq 1 ]]; then');
  lines.push('    COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )');
  lines.push('    return');
  lines.push('  fi');
  lines.push('');
  lines.push('  case "${COMP_WORDS[1]}" in');
  for (const entry of entries) {
    const subNames = (entry.subcommands || []).map((s) => s.name);
    const flagTokens = (entry.flags || []).map((f) => parseFlag(f.flag)).filter(Boolean).map((t) => t.token);
    const words = [...subNames, ...flagTokens];
    if (words.length === 0) {
      continue;
    }
    lines.push('    ' + entry.command + ')');
    lines.push('      COMPREPLY=( $(compgen -W "' + words.join(' ') + '" -- "${cur}") )');
    lines.push('      ;;');
  }
  lines.push('    *)');
  lines.push('      COMPREPLY=()');
  lines.push('      ;;');
  lines.push('  esac');
  lines.push('}');
  lines.push('');
  lines.push(`complete -F _${AGENT_NAME}_completion ${AGENT_NAME}`);
  return lines.join('\n') + '\n';
}

function zshFlagSpec(token) {
  if (token.kind === 'boolean') {
    return `'${token.token}[${token.token.replace(/^-+/, '')}]'`;
  }
  if (token.kind === 'choice') {
    return `'${token.token}[${token.token.replace(/^-+/, '')}]:value:(${token.choices.join(' ')})'`;
  }
  return `'${token.token}[${token.token.replace(/^-+/, '')}]:${token.placeholder}: '`;
}

function renderZshCompletion(registry) {
  const entries = completionEntries(registry);
  const lines = [];
  lines.push(`#compdef ${AGENT_NAME}`);
  lines.push('# generated at runtime — do not hand-edit');
  lines.push('');
  lines.push('local -a commands');
  lines.push('commands=(');
  for (const entry of entries) {
    const summary = (entry.summary || '').replace(/'/g, '').replace(/:/g, ' ');
    lines.push(`  '${entry.command}:${summary}'`);
  }
  lines.push(')');
  lines.push('');
  lines.push('_arguments -C \\');
  lines.push("  '1:command:->command' \\");
  lines.push("  '*::arg:->args'");
  lines.push('');
  lines.push('case $state in');
  lines.push('  command)');
  lines.push(`    _describe -t commands '${AGENT_NAME} commands' commands`);
  lines.push('    ;;');
  lines.push('  args)');
  lines.push('    case $words[2] in');
  for (const entry of entries) {
    const specs = [];
    if (entry.subcommands && entry.subcommands.length > 0) {
      specs.push(`'1:subcommand:(${entry.subcommands.map((s) => s.name).join(' ')})'`);
    }
    for (const flag of entry.flags || []) {
      const token = parseFlag(flag.flag);
      if (token) {
        specs.push(zshFlagSpec(token));
      }
    }
    if (specs.length === 0) {
      continue;
    }
    lines.push(`      ${entry.command})`);
    lines.push(`        _arguments ${specs.join(' ')}`);
    lines.push('        ;;');
  }
  lines.push('    esac');
  lines.push('    ;;');
  lines.push('esac');
  return lines.join('\n') + '\n';
}

function commandCompletion(registry, args) {
  const shell = args[0];
  if (shell === 'bash') {
    process.stdout.write(renderBashCompletion(registry));
    return;
  }
  if (shell === 'zsh') {
    process.stdout.write(renderZshCompletion(registry));
    return;
  }
  throw new Error(`Usage: scripts/${AGENT_NAME} completion <bash|zsh>`);
}

// ---------------------------------------------------------------------------
// Built-in: skills (passthrough to scripts/lib/skills.sh)
// ---------------------------------------------------------------------------

function commandSkills(args) {
  const subcommand = args[0];
  const quotedLib = shellQuote(SKILLS_LIB);

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

  const result = spawnSync('bash', ['-c', bashScript], { cwd: ROOT_DIR, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function resolveMetric(entry, args) {
  if (!entry.metric) {
    return { skill: entry.module, action: entry.command };
  }
  const skill = entry.metric.skill || entry.module;
  let action = entry.metric.action || entry.command;
  if (entry.metric.actionFromArg) {
    const verb = (args[0] || '').trim();
    action = verb && !verb.startsWith('-') ? verb : entry.command;
  }
  return { skill, action };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run() {
  const [command, ...args] = process.argv.slice(2);
  const { registry, warnings } = discoverCommands();

  for (const warning of warnings) {
    console.error(`warning: ${warning}`);
  }

  // No command → overview, exit 0.
  if (!command) {
    console.log(renderOverview(registry));
    return;
  }

  // Help built-in.
  if (command === 'help' || command === '--help' || command === '-h') {
    const code = handleHelpRequest(registry, args);
    if (code !== 0) {
      process.exit(code);
    }
    return;
  }

  // `<command> --help` for a known command (module or built-in).
  if (args.includes('--help') || args.includes('-h')) {
    const entry = findEntry(registry, command);
    if (entry) {
      console.log(renderCommandHelp(entry));
      return;
    }
  }

  // Built-ins that always work with zero skills.
  try {
    if (command === 'completion') {
      commandCompletion(registry, args);
      return;
    }
    if (command === 'skills') {
      commandSkills(args);
      return;
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  // Module (or legacy) command.
  const entry = registry.get(command);
  if (!entry) {
    printUnknownCommand(registry, command);
    process.exit(1);
  }

  const metric = resolveMetric(entry, args);
  const startedAt = Date.now();
  let ok = true;
  let errorMessage = '';

  try {
    const handler = loadHandler(entry);
    handler(args);
  } catch (error) {
    ok = false;
    errorMessage = error instanceof Error ? error.message : String(error);
    console.error(errorMessage);
    process.exitCode = 1;
  } finally {
    logSkillMetric(metric.skill, metric.action, 'cli', Date.now() - startedAt, ok && process.exitCode !== 1, errorMessage);
  }
}

module.exports = { run };
