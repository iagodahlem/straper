const path = require('path');

const { runCommand } = require('../../scripts/lib/cli-utils.js');

// `<agent> scheduler <status|run|install>` — thin exec wrapper over the
// scheduler skill's three standalone scripts. Unlike a single-script skill
// (service, patch, skill), the scheduler has no dispatcher script of its own
// to forward a subcommand to, so this picks the right backing script itself:
//   status  -> scheduler-status.sh  (read-only jobs table; --json passthrough)
//   run     -> scheduler.sh         (one dispatcher tick, foreground)
//   install -> install.sh           (launchd install/load/kickstart, macOS)
// No subcommand (or a leading flag, e.g. `<agent> scheduler --json`) defaults
// to `status` so a bare `<agent> scheduler` is the common "what's going on"
// check. Each script owns its own further argument parsing/validation.
const SCRIPT_BY_SUBCOMMAND = {
  status: 'scheduler-status.sh',
  run: 'scheduler.sh',
  install: 'install.sh',
};

function commandScheduler(args) {
  const first = args[0];
  const defaultsToStatus = !first || first.startsWith('-');
  const subcommand = defaultsToStatus ? 'status' : first;
  const passthrough = defaultsToStatus ? args : args.slice(1);

  const scriptName = SCRIPT_BY_SUBCOMMAND[subcommand];
  if (!scriptName) {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error('Usage: scripts/<agent> scheduler <status|run|install> [args]');
    process.exit(1);
    return;
  }

  const script = path.join(__dirname, scriptName);
  const result = runCommand('bash', [script, ...passthrough], { stdio: 'inherit' });
  if (result.status && result.status !== 0) {
    process.exit(result.status);
  }
}

module.exports = { commandScheduler };
