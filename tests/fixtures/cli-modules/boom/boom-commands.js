// Throws at module-load time. Proves lazy loading: if a DIFFERENT command runs,
// this file is never required, so its throw never fires. It only blows up when
// the `boom` command is actually invoked.
throw new Error('boom module was loaded');

// eslint-disable-next-line no-unreachable
module.exports = { run() {} };
