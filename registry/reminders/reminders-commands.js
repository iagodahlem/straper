// <agent> reminder — personal follow-up ledger (memory/reminders.json).
//
// Skill name/directory/trigger are `reminders` (plural — see reminders.md),
// but the CLI verb is singular: `<agent> reminder add|done|list`. Mirrors the
// shape of skills/task/task.js (a single file handling multiple subcommands
// against JSON files under a tracked directory) but is required directly
// in-process — like commandSkill/commandService — rather than spawned as a
// separate `node` process, so it exports a plain `command<X>` function.
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');
const REMINDERS_PATH = path.join(ROOT_DIR, 'memory', 'reminders.json');

function nowIso() {
  return new Date().toISOString();
}

// Same busy-wait file lock as skills/task/task.js — reminders.json is edited
// by short-lived `<agent> reminder ...` CLI invocations from potentially
// concurrent sessions, so read-modify-write needs the same cross-process
// guard the task ledger uses.
function sleepMs(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function withFileLock(filePath, callback) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 5000;
  let lockFd = null;

  while (lockFd === null) {
    try {
      lockFd = fs.openSync(lockPath, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST' && Date.now() < deadline) {
        sleepMs(25);
        continue;
      }
      throw new Error(`Unable to acquire reminders lock: ${error.message}`);
    }
  }

  try {
    return callback();
  } finally {
    if (lockFd !== null) {
      fs.closeSync(lockFd);
    }
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  }
}

function readReminders() {
  if (!fs.existsSync(REMINDERS_PATH)) {
    return [];
  }
  const raw = fs.readFileSync(REMINDERS_PATH, 'utf8').trim();
  if (!raw) {
    return [];
  }
  return JSON.parse(raw);
}

function writeReminders(list) {
  fs.mkdirSync(path.dirname(REMINDERS_PATH), { recursive: true });
  const formatted = `${JSON.stringify(list, null, 2)}\n`;
  fs.writeFileSync(REMINDERS_PATH, formatted, 'utf8');
}

function nextId(list) {
  let maxNum = 0;
  for (const entry of list) {
    const match = /^REM-(\d+)$/.exec(entry.id || '');
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) {
        maxNum = num;
      }
    }
  }
  return `REM-${String(maxNum + 1).padStart(3, '0')}`;
}

// splitSourceFlag — mirrors task.js's splitNoteFlag: everything after the
// first `--source` is joined back into the source string, everything before
// it is the reminder text. Lets `add` accept either a quoted single-token
// text or an unquoted multi-word one (same leniency as `task create`).
function splitSourceFlag(args) {
  const idx = args.indexOf('--source');
  if (idx === -1) {
    return { textArgs: args, source: '' };
  }
  return {
    textArgs: args.slice(0, idx),
    source: args.slice(idx + 1).join(' ').trim(),
  };
}

function addReminder(args) {
  const { textArgs, source } = splitSourceFlag(args);
  const text = textArgs.join(' ').trim();
  if (!text) {
    throw new Error('Usage: scripts/<agent> reminder add "<text>" [--source "<text>"]');
  }

  let created;
  withFileLock(REMINDERS_PATH, () => {
    const list = readReminders();
    created = {
      id: nextId(list),
      text,
      added_at: nowIso(),
      source,
      status: 'open',
      done_at: null,
    };
    list.push(created);
    writeReminders(list);
  });

  console.log(`Added ${created.id}: ${created.text}`);
}

function doneReminder(args) {
  const id = String(args[0] || '').trim().toUpperCase();
  if (!id) {
    throw new Error('Usage: scripts/<agent> reminder done <id>');
  }

  withFileLock(REMINDERS_PATH, () => {
    const list = readReminders();
    const entry = list.find((item) => item.id === id);
    if (!entry) {
      throw new Error(`Reminder not found: ${id}`);
    }
    if (entry.status === 'done') {
      throw new Error(`Reminder already done: ${id}`);
    }
    entry.status = 'done';
    entry.done_at = nowIso();
    writeReminders(list);
  });

  console.log(`${id}: marked done`);
}

function dateOnly(iso) {
  return String(iso || '').slice(0, 10);
}

function formatReminder(entry) {
  const statusTag = entry.status === 'done' ? ' [done]' : '';
  const sourceText = entry.source ? ` (source: ${entry.source})` : '';
  return `${entry.id}${statusTag} — ${entry.text}${sourceText} [added ${dateOnly(entry.added_at)}]`;
}

function listReminders(args) {
  const all = args.includes('--all');
  const list = readReminders();
  const filtered = all ? list : list.filter((entry) => entry.status === 'open');

  if (filtered.length === 0) {
    console.log(all ? 'No reminders.' : 'No open reminders.');
    return;
  }

  for (const entry of filtered) {
    console.log(formatReminder(entry));
  }
}

function commandReminder(args) {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'add':
      addReminder(rest);
      break;
    case 'done':
      doneReminder(rest);
      break;
    case 'list':
      listReminders(rest);
      break;
    default:
      throw new Error('Usage: scripts/<agent> reminder <add "<text>" [--source "<text>"]|done <id>|list [--all]>');
  }
}

module.exports = { commandReminder };
