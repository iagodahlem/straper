#!/usr/bin/env node
// Generated workspace CLI entry point.
//
// This file is intentionally thin: the whole dispatcher — command discovery from
// installed skills/*/commands.json, lazy handler routing, help, and completion —
// lives in scripts/lib/cli-runtime.js, which derives this agent's name from the
// invoked script at runtime. See docs/workspace-cli.md for the commands.json
// contract and the straper-vs-<agent> separation.

require('./lib/cli-runtime.js').run();
