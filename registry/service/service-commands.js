const path = require('path');

const { runCommand } = require('../../scripts/lib/cli-utils.js');

// Start, track, and stop the dev services the agent spins up (clerk-js sandbox
// first) with port discipline and cross-session visibility.
//
// Thin wrapper over skills/service/service.sh (the implementation), surfaced as
// a first-class `malvin service` command. All arguments pass straight through;
// service.sh owns its own usage/help, argument parsing, and validation.
function commandService(args) {
  const script = path.join(__dirname, 'service.sh');
  const result = runCommand('bash', [script, ...args], { stdio: 'inherit' });
  if (result.status && result.status !== 0) {
    process.exit(result.status);
  }
}

module.exports = { commandService };
