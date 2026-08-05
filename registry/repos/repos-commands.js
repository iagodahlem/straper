const path = require('path');

const { runCommand } = require('../../scripts/lib/cli-utils.js');

// `<agent> repos <sync|status|guard>` — thin exec wrapper over repos.sh (the
// implementation). All arguments pass straight through; repos.sh owns its own
// usage/help, argument parsing, and validation. Mirrors the
// service-commands.js / scheduler-commands.js pattern: no logic lives here,
// this file only exists so the workspace CLI has a lazily-loadable handler.
function commandRepos(args) {
  const script = path.join(__dirname, 'repos.sh');
  const result = runCommand('bash', [script, ...args], { stdio: 'inherit' });
  if (result.status && result.status !== 0) {
    process.exit(result.status);
  }
}

module.exports = { commandRepos };
