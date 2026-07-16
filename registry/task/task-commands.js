const path = require('path');

const { runCommand } = require('../../scripts/lib/cli-utils.js');

// Thin wrapper over skills/task/task.js (the implementation), surfaced as a
// first-class `task` command. task.js is a standalone CLI that reads its own
// argv, so it runs as a child process; all arguments pass straight through.
function commandTask(args) {
  const script = path.join(__dirname, 'task.js');
  const result = runCommand('node', [script, ...args], { stdio: 'inherit' });
  if (result.status && result.status !== 0) {
    process.exit(result.status);
  }
}

module.exports = { commandTask };
