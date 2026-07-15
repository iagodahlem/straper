const path = require('path');
const { spawnSync } = require('child_process');

const {
  ROOT_DIR,
  shellQuote,
} = require('../../scripts/lib/cli-utils.js');

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function commandSlackStatus(args) {
  const subcommand = args[0];
  if (!subcommand || !['check', 'clear-all', 'set', 'clear'].includes(subcommand)) {
    throw new Error('Usage: scripts/<agent> slack-status <check|clear|clear-all|set "<text>" --emoji <emoji> [--expires <minutes>]>');
  }

  const slackScript = path.join(ROOT_DIR, 'skills', 'slack-status', 'slack.sh');
  const quotedScript = shellQuote(slackScript);

  let bashScript;
  if (subcommand === 'check') {
    bashScript = `source ${quotedScript} && if slack_token_exists; then slack_check_token; else echo 'No token configured (SLACK_USER_TOKEN not set in .env)'; fi`;
  } else if (subcommand === 'clear') {
    bashScript = `source ${quotedScript} && if slack_token_exists; then slack_clear_status && echo 'Slack status cleared.'; else echo 'No token configured — nothing to clear.'; fi`;
  } else if (subcommand === 'clear-all') {
    bashScript = `source ${quotedScript} && if slack_token_exists; then slack_clear_status && echo 'Slack status cleared.'; else echo 'No token configured — nothing to clear.'; fi`;
  } else if (subcommand === 'set') {
    const setArgs = args.slice(1);
    let emoji = ':speech_balloon:';
    let expires = 0;
    const textParts = [];

    for (let i = 0; i < setArgs.length; i++) {
      if (setArgs[i] === '--emoji' && setArgs[i + 1]) {
        emoji = setArgs[++i];
      } else if (setArgs[i] === '--expires' && setArgs[i + 1]) {
        expires = parseInt(setArgs[++i], 10) || 0;
      } else {
        textParts.push(setArgs[i]);
      }
    }

    const text = textParts.join(' ').substring(0, 100);
    if (!text) {
      throw new Error('Usage: scripts/<agent> slack-status set "<text>" --emoji <emoji> [--expires <minutes>]');
    }

    const safeEmoji = emoji.replace(/'/g, "'\\''");
    const safeText = text.replace(/'/g, "'\\''");
    bashScript = `source ${quotedScript} && if slack_token_exists; then slack_set_status '${safeEmoji}' '${safeText}' ${expires} && echo 'Status set: ${safeEmoji} ${safeText}'; else echo 'No token configured (SLACK_USER_TOKEN not set in .env)'; fi`;
  }

  const result = spawnSync('bash', ['-c', bashScript], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

module.exports = {
  commandSlackStatus,
};
