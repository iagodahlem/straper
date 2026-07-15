const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { ROOT_DIR, getArgValue, nowIso } = require('../../scripts/lib/cli-utils.js');

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function getSessionsConfig() {
  const configPath = path.join(ROOT_DIR, 'config', 'sessions.json');
  if (!fs.existsSync(configPath)) {
    return { sessions_dir: '.sessions', retention_days: 7 };
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function getSessionsDir() {
  const config = getSessionsConfig();
  return path.join(ROOT_DIR, config.sessions_dir || '.sessions');
}

function readAllSessions() {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  return fs.readdirSync(sessionsDir)
    .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
    .map((file) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function formatSessionDuration(startedAt, endedAt = null) {
  const start = new Date(startedAt);
  const end = endedAt ? new Date(endedAt) : new Date();
  const diffMs = end - start;
  const hours = Math.floor(diffMs / 3600000);
  const mins = Math.floor((diffMs % 3600000) / 60000);
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }

  return `${mins}m`;
}

// pidStartTime — kernel start-time string for a PID, or '' if dead/unknown.
function pidStartTime(pid) {
  if (!pid && pid !== 0) {
    return '';
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return '';
  }
}

// isSessionLive — true if the session's PID is alive AND (when a start-time was
// recorded) the live start-time matches. Defeats PID reuse. Legacy records with
// no recorded proc_start fall back to a bare liveness probe.
function isSessionLive(s) {
  const pid = s.pid;
  if (!pid && pid !== 0) {
    return false;
  }
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    alive = err.code === 'EPERM'; // exists but not ours -> still alive
  }
  if (!alive) {
    return false;
  }
  if (!s.proc_start) {
    return true; // legacy record — best effort
  }

  return pidStartTime(pid) === s.proc_start;
}

// ---------------------------------------------------------------------------
// Session subcommands
// ---------------------------------------------------------------------------

function commandSessionList() {
  const sessions = readAllSessions().filter((s) => s.status === 'active');

  if (sessions.length === 0) {
    console.log('No active sessions.');
    return;
  }

  let staleCount = 0;
  for (const s of sessions) {
    const duration = formatSessionDuration(s.started_at, null);
    const task = s.task ? `  ${s.task}` : '';
    const live = isSessionLive(s);
    const state = live ? 'active' : 'stale';
    if (!live) {
      staleCount += 1;
    }
    console.log(`${s.id}  ${s.emoji}  ${s.name}  (${state}, ${duration})${task}`);
  }

  if (staleCount > 0) {
    console.log('');
    console.log(`${staleCount} session(s) marked (stale): PID dead or recycled. Run a SessionStart (boot) or '<agent> session close-all' to reap.`);
  }
}

function commandSessionHistory() {
  const sessions = readAllSessions()
    .filter((s) => s.status === 'closed')
    .sort((a, b) => (b.closed_at || '').localeCompare(a.closed_at || ''));

  const recent = sessions.slice(0, 10);

  if (recent.length === 0) {
    console.log('No closed sessions.');
    return;
  }

  for (const s of recent) {
    const duration = formatSessionDuration(s.started_at, s.closed_at);
    const task = s.task ? `  ${s.task}` : '';
    console.log(`${s.id}  ${s.emoji}  ${s.name}  (closed, ${duration})${task}`);
    if (s.summary) {
      console.log(`       ${s.summary}`);
    }
  }
}

function commandSessionInfo(args) {
  const id = args[0];
  if (!id) {
    throw new Error('Usage: scripts/<agent> session info <id>');
  }

  const sessionsDir = getSessionsDir();
  const filePath = path.join(sessionsDir, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Session not found: ${id}`);
  }

  console.log(JSON.stringify(JSON.parse(fs.readFileSync(filePath, 'utf8')), null, 2));
}

function commandSessionCloseAll() {
  const sessionsDir = getSessionsDir();
  const sessions = readAllSessions().filter((s) => s.status === 'active');

  if (sessions.length === 0) {
    console.log('No active sessions to close.');
    return;
  }

  const now = new Date().toISOString();
  for (const s of sessions) {
    const filePath = path.join(sessionsDir, `${s.id}.json`);
    const updated = { ...s, status: 'closed', closed_at: now, summary: 'Session closed via CLI' };
    fs.writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    console.log(`Closed: ${s.id}  ${s.emoji}  ${s.name}`);
  }
}

// findSessionByNameOrId — newest record matching a 6-hex id or a (case-insensitive) name.
function findSessionByNameOrId(query) {
  const all = readAllSessions();

  // Exact id match first.
  if (/^[0-9a-f]{6}$/.test(query)) {
    const byId = all.find((s) => s.id === query);
    if (byId) {
      return byId;
    }
  }

  // Name match, newest wins (by started_at).
  const q = query.toLowerCase();
  const matches = all
    .filter((s) => (s.name || '').toLowerCase() === q)
    .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));

  return matches[0] || null;
}

function commandSessionResume(args) {
  const query = args.join(' ').trim();
  if (!query) {
    throw new Error('Usage: scripts/<agent> session resume <name-or-id>');
  }

  const session = findSessionByNameOrId(query);
  if (!session) {
    console.log(`No session found matching '${query}'.`);
    console.log("Tip: run 'claude --resume' (no arg) for Claude's interactive picker.");
    return;
  }

  const claudeId = session.claude_session_id;
  if (claudeId) {
    // Print the exact resume invocation. We print rather than exec so the user
    // can copy/paste into the terminal they want the session to live in.
    console.log(`claude -r ${claudeId}`);
    console.log(`# Resumes "${session.name}" (${session.id}, ${session.status}).`);
  } else {
    console.log(`Session "${session.name}" (${session.id}) has no stored Claude session id.`);
    console.log("Fall back to Claude's session picker:");
    console.log('  claude --resume');
    console.log(`  # then select the entry named "${session.name}" (set via /rename).`);
  }
}

// ---------------------------------------------------------------------------
// Handoff helpers (TASK-126)
//
// handoffs/<name>.md is a structured, per-planned-session ledger entry: YAML
// frontmatter (name, created_at, recommended_model?, consumed?) + a markdown
// body (Scope / Context pointers / First actions). Frontmatter here is
// deliberately flat (no arrays/nesting), so this stays a small self-contained
// parser rather than reaching into skills/fd/designs.js's array-aware one —
// keeps the session skill's own surface self-contained.
//
// "Open" mirrors the exact convention scripts/ack.sh and
// scripts/session-start.sh's pulse_pending_ack_digest already use for
// memory/pulse|review|brain-drafts: a file is open (unconsumed) while its
// frontmatter lacks a `consumed:` key; `consume` stamps it, same idea as
// `scripts/ack.sh` stamping `acked:`.
// ---------------------------------------------------------------------------

const HANDOFFS_DIR = path.join(ROOT_DIR, 'handoffs');

function parseHandoffFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return {};
  }

  const data = {};
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') {
      continue;
    }
    const keyValueMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!keyValueMatch) {
      continue;
    }
    const [, key, rawValue] = keyValueMatch;
    data[key] = rawValue.trim();
  }
  return data;
}

function extractHandoffBody(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? content.slice(match[0].length) : content;
}

function handoffPath(name) {
  return path.join(HANDOFFS_DIR, `${name}.md`);
}

function readHandoffFile(name) {
  const filePath = handoffPath(name);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return {
    name,
    filePath,
    content,
    frontmatter: parseHandoffFrontmatter(content),
    body: extractHandoffBody(content),
  };
}

function listHandoffNames() {
  if (!fs.existsSync(HANDOFFS_DIR)) {
    return [];
  }
  return fs.readdirSync(HANDOFFS_DIR)
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -3))
    .sort();
}

// handoffScopeGist — one-line gist: the first non-blank line under the
// body's '## Scope' heading, else the first non-heading, non-blank body
// line. Mirrors _handoff_scope_gist in scripts/session-start.sh so the CLI
// and the boot digest agree on what a handoff's one-line summary is.
function handoffScopeGist(body) {
  const scopeMatch = body.match(/^##\s+Scope\s*\n+([^\n]*)/m);
  if (scopeMatch && scopeMatch[1].trim()) {
    return scopeMatch[1].trim();
  }
  const line = body
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith('#'));
  return line || '';
}

// ---------------------------------------------------------------------------
// Handoff subcommands (`<agent> session handoff <verb>`)
// ---------------------------------------------------------------------------

function commandSessionHandoffList() {
  const open = listHandoffNames()
    .map((name) => readHandoffFile(name))
    .filter((handoff) => handoff && !handoff.frontmatter.consumed);

  if (open.length === 0) {
    console.log('No open handoffs.');
    return;
  }

  for (const handoff of open) {
    const name = handoff.frontmatter.name || handoff.name;
    const createdAt = handoff.frontmatter.created_at || 'unknown';
    const model = handoff.frontmatter.recommended_model || 'unspecified';
    const gist = handoffScopeGist(handoff.body) || '(no scope line found)';
    console.log(`${name}  (created: ${createdAt}, recommended model: ${model})`);
    console.log(`  ${gist}`);
  }
}

function commandSessionHandoffRead(args) {
  const name = args[0];
  if (!name) {
    throw new Error('Usage: scripts/<agent> session handoff read <name>');
  }

  const handoff = readHandoffFile(name);
  if (!handoff) {
    throw new Error(`Handoff not found: handoffs/${name}.md`);
  }

  process.stdout.write(handoff.body.replace(/^\n+/, ''));
}

function commandSessionHandoffWrite(args) {
  const name = args[0];
  if (!name) {
    throw new Error('Usage: <content> | scripts/<agent> session handoff write <name> [--recommended-model <model>]');
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Invalid handoff name: "${name}" — expected a short kebab-case slug`);
  }

  const recommendedModel = getArgValue(args, '--recommended-model');

  let body = '';
  try {
    body = fs.readFileSync(0, 'utf8');
  } catch {
    body = '';
  }
  if (!body.trim()) {
    throw new Error('No body content received on stdin. Usage: printf \'%s\' "$content" | scripts/<agent> session handoff write <name>');
  }

  fs.mkdirSync(HANDOFFS_DIR, { recursive: true });

  const frontmatterLines = ['---', `name: ${name}`, `created_at: ${nowIso()}`];
  if (recommendedModel) {
    frontmatterLines.push(`recommended_model: ${recommendedModel}`);
  }
  frontmatterLines.push('---');

  const trimmedBody = body.replace(/^\s+/, '').replace(/\s+$/, '');
  const fileContent = `${frontmatterLines.join('\n')}\n\n${trimmedBody}\n`;

  // write/overwrite unconditionally — a fresh write always resets the
  // lifecycle (no `consumed` key), even if a prior handoff of the same name
  // had already been consumed.
  fs.writeFileSync(handoffPath(name), fileContent, 'utf8');
  console.log(`Wrote handoffs/${name}.md`);
}

function commandSessionHandoffConsume(args) {
  const name = args[0];
  if (!name) {
    throw new Error('Usage: scripts/<agent> session handoff consume <name>');
  }

  const handoff = readHandoffFile(name);
  if (!handoff) {
    throw new Error(`Handoff not found: handoffs/${name}.md`);
  }
  if (handoff.frontmatter.consumed) {
    console.log(`already consumed: handoffs/${name}.md (${handoff.frontmatter.consumed})`);
    return;
  }

  // Stamp `consumed: <now>` as the last frontmatter key, right before the
  // closing fence — same idea as scripts/ack.sh's in-place frontmatter stamp
  // (insert into the fenced block, leave everything else untouched),
  // reimplemented directly in JS since ack.sh is bash and this is a Node CLI.
  const stamped = handoff.content.replace(
    /^(---\n[\s\S]*?)\n---\n/,
    (whole, frontmatterBody) => `${frontmatterBody}\nconsumed: ${nowIso()}\n---\n`,
  );

  if (stamped === handoff.content) {
    throw new Error(`Could not find a frontmatter fence to stamp in handoffs/${name}.md`);
  }

  fs.writeFileSync(handoff.filePath, stamped, 'utf8');
  console.log(`consumed: handoffs/${name}.md`);
}

function commandSessionHandoff(args) {
  const verb = args[0];
  const verbArgs = args.slice(1);

  switch (verb) {
    case 'list':
      commandSessionHandoffList();
      break;
    case 'read':
      commandSessionHandoffRead(verbArgs);
      break;
    case 'write':
      commandSessionHandoffWrite(verbArgs);
      break;
    case 'consume':
      commandSessionHandoffConsume(verbArgs);
      break;
    default:
      throw new Error('Usage: scripts/<agent> session handoff <list|read <name>|write <name> [--recommended-model <model>]|consume <name>>');
  }
}

function commandSession(args) {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'list':
      commandSessionList();
      break;
    case 'close-all':
      commandSessionCloseAll();
      break;
    case 'history':
      commandSessionHistory();
      break;
    case 'info':
      commandSessionInfo(subArgs);
      break;
    case 'resume':
      commandSessionResume(subArgs);
      break;
    case 'handoff':
      commandSessionHandoff(subArgs);
      break;
    default:
      throw new Error('Usage: scripts/<agent> session <list|close-all|history|info <id>|resume <name-or-id>|handoff <list|read|write|consume>>');
  }
}

module.exports = {
  commandSession,
};
