const path = require('path');

const { ROOT_DIR, runCommand } = require('../../scripts/lib/cli-utils.js');

// Export a worktree's unstaged changes as a .patch file under patches/.
//
// Thin wrapper over scripts/create-patch.sh (the implementation), surfaced as a
// first-class command so the operation is discoverable in the skill catalog.
// All arguments pass straight through; create-patch.sh handles its own
// usage/help and validation (and prints usage on no args).
function commandPatch(args) {
  const script = path.join(ROOT_DIR, 'scripts', 'create-patch.sh');
  const result = runCommand('bash', [script, ...args], { stdio: 'inherit' });
  if (result.status && result.status !== 0) {
    process.exit(result.status);
  }
}

module.exports = { commandPatch };
