// Locked task-file updates for the ship pipeline — module-local copy so the
// module doesn't depend on this helper living in the workspace's shared lib.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');

function sleepMs(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function withTaskFileLock(filePath, callback) {
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
      throw new Error(`Unable to acquire task lock for ${path.basename(filePath)}: ${error.message}`);
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

function updateTaskFile(filePath, updater) {
  withTaskFileLock(filePath, () => {
    const originalRaw = fs.readFileSync(filePath, 'utf8');
    const nextTask = updater(JSON.parse(originalRaw));
    fs.writeFileSync(filePath, `${JSON.stringify(nextTask, null, 2)}\n`, 'utf8');

    const validation = spawnSync(process.execPath, [path.join(ROOT_DIR, 'skills', 'task', 'validate.js'), filePath], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    });
    if (validation.status !== 0) {
      fs.writeFileSync(filePath, originalRaw, 'utf8');
      const output = [validation.stdout, validation.stderr].filter(Boolean).join('\n').trim();
      throw new Error(output || `Task validation failed for ${path.basename(filePath)}`);
    }
  });
}

module.exports = { updateTaskFile };
