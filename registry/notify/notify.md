---
name: notify
description: Deliver a notification to the user through any configured channel (Telegram, at-desk terminal banner) — callable from any session, job, or hook
version: 1
visibility: user
triggers:
  - /notify
backing_script: notify.sh
depends_on: []
composes: []
---

# Notify Skill

A single notification channel any session, scheduler job, or hook can call to
reach the user out-of-band. Backed by `skills/notify/notify.sh` — a sourceable
library plus a CLI entrypoint, cloned from `skills/slack-status/slack.sh`: every
path **no-ops silently (exit 0) when the channel is unconfigured**, so callers
never have to guard.

## Purpose

Deliver a short notification to the user across whatever transports are configured —
Telegram (outbound) and the at-desk macOS terminal banner. This is the central
notification surface: the [[scheduler]] dispatches job output through it, and the
`Notification` hook (`scripts/hooks/notify-on-attention.sh`) routes
permission/idle prompts through it.

## Boundary (load-bearing — SOUL.md)

This skill notifies **the user only**. It NEVER posts to Slack, GitHub, or Linear —
nothing that lands in another person's notifications or feed. The `slack`
channel is a draft-only stub that never auto-posts. The SOUL.md "no unsolicited
external messages" boundary lives here, centrally:

- Every outbound payload is run through `notify_scrub` first, which strips
  internal workspace references (`FD-XXX`, `TASK-XXX`, standalone `A1`/`F1`/`R1`
  sub-item codes, the agent's name, and `workspaces/` / `plans/` / `designs/`
  paths) before delivery.
- No transport in this skill can post to a shared surface. Telegram goes to
  the user's own chat; terminal is a local banner.

## Arguments

```
/notify <channel> <title> <body> [group]
/notify check
```

Or call the backing script directly:

```
skills/notify/notify.sh <channel> <title> <body> [group]
skills/notify/notify.sh check
```

| Argument | Required | Description |
|----------|----------|-------------|
| `channel` | yes | One of `telegram`, `terminal`, `slack`, `memory`. Defaults to `telegram` if omitted. |
| `title` | yes | Short headline. Scrubbed of internal refs before delivery. |
| `body` | no | Longer body text. Scrubbed of internal refs before delivery. |
| `group` | no | Coalescing group id (terminal channel only) — repeat banners with the same group replace rather than stack. Typically a `session_id`. |
| `check` | — | Report which channels are configured. No delivery. |

### Channels

| Channel | Status | Behavior |
|---------|--------|----------|
| `telegram` | implemented | Outbound `sendMessage` to `TELEGRAM_CHAT_ID`. Silent no-op when chat id or bot token is unresolvable. |
| `terminal` | implemented | At-desk macOS banner via `terminal-notifier`; clicking it focuses ghostty (`-activate`). Silent no-op when `terminal-notifier` is not on PATH. |
| `slack` | draft-only stub | NEVER auto-posts (SOUL.md). Logs that a draft would be produced and no-ops. |
| `memory` | stub | Harvest-sink placeholder; the harvest mode owns the real writer. |

## Configuration

Telegram (Phase 1, outbound-only):

- `TELEGRAM_CHAT_ID` — non-secret, lives in `.env` (gitignored).
- Bot token — resolved in two tiers:
  - **PRIMARY** `TELEGRAM_BOT_TOKEN` in `.env` (gitignored, never committed). This
    is the headless-safe source: a launchd / `claude -p` run has no GUI 1Password
    session, so a runtime `op read` would block on a biometric/desktop unlock that
    never arrives and hang the job. Reading the token straight from `.env` removes
    that hang. Populate it once from 1Password.
  - **FALLBACK** `op read "$TELEGRAM_BOT_TOKEN_OP_REF"` — used ONLY when the direct
    token is empty (e.g. an interactive box with a live `op` session but no
    populated `.env`). The `op read` is bounded with `timeout` so even the fallback
    can never hang a run.

Set up the Telegram bot via BotFather to obtain a bot token, and install the
terminal channel dependency with `brew install terminal-notifier`.

## Execution

### `check`

Report channel configuration without sending anything:

```bash
skills/notify/notify.sh check
```

- Telegram: "Telegram configured (chat_id set, token resolvable)." or
  "Telegram not configured (silent no-op mode)."
- Terminal: "Terminal configured ..." or "Terminal not configured
  (terminal-notifier absent — silent no-op; brew install terminal-notifier)."

### `<channel> <title> <body> [group]`

1. Source `skills/notify/notify.sh` (or invoke it directly as a CLI).
2. Call `notify_dispatch "<channel>" "<title>" "<body>" "<group>"`.
3. The router scrubs internal refs from title and body, then delivers via the
   named transport.
4. Always returns 0 — unknown or unconfigured channels no-op rather than fail,
   so a caller (the scheduler, a hook) is never broken by a notification.

As a library, the per-transport functions are also available after sourcing:
`telegram_send`, `telegram_send_chunked`, `terminal_notify`,
`notify_telegram_configured`, `notify_terminal_configured`, `notify_scrub`.

`telegram_send_chunked "<message>" [max_chars]` sends a long, multi-block
payload by splitting it across multiple `sendMessage` calls (default cap 3500,
under Telegram's ~4096 limit), breaking on paragraph/line boundaries so a
paste-ready draft block is not torn mid-line. The scheduled slack-pulse job
calls this directly to deliver ranked drafts to the user's phone.

## Metrics

`notify` keeps its own detailed per-dispatch log at `.metrics/notify.jsonl`
(session, subtype, message). For uniform skills-metrics coverage, an agent that
invokes `notify` as a skill (not via the hook/scheduler, which log their own way)
should also append a row to `.metrics/skills.jsonl` by calling the shared helper —
never hand-write the JSON:

```bash
source scripts/lib/skills.sh
skills_log_event notify dispatch /notify <duration_ms> true "" "<model-id>"
```

`skills_log_event` builds the row via jq and pins `at` to UTC `Z`. If `.metrics/`
is unavailable, skip silently — never fail the run over metrics.

## Consumers

- **[[scheduler]]** — `skills/scheduler/scheduler.sh` calls `notify_dispatch`
  per the due job's `notify` policy (`silent`/`on-change`/`always`/`error`).
- **Notification hook** — `scripts/hooks/notify-on-attention.sh` (wired to the
  `Notification` hook in `.claude/settings.json`) routes permission/idle prompts
  to the `terminal` channel. It joins the session registry (by stored
  `claude_session_id`, else the `.current-<pid>` pointer) so the banner names the
  firing session and the specific ask:
  `<emoji> <Name> — needs approval|waiting for you` /
  `<tool: command | idle> · <task|branch> · <cwd basename>`. With no matching
  record it degrades to a generic title and the raw message. Every dispatch is
  appended to `.metrics/notify.jsonl` (`session_id`, `name`, `subtype`,
  `message`, `at`), and repeat idle banners for the same session are suppressed
  within a short cooldown window (permission prompts always fire).
- **Any session or job** — call the script directly to ping the user.

## Graceful Degradation

- No `.env` / no `TELEGRAM_CHAT_ID` / no resolvable bot token → telegram no-ops
  silently (exit 0).
- No direct `TELEGRAM_BOT_TOKEN` AND no resolvable `op` fallback → telegram no-ops
  silently. The fallback `op read` is bounded with `timeout`, so it can never hang
  a headless run.
- `terminal-notifier` not on PATH → terminal channel no-ops silently.
- Unknown channel → logged to stderr, no-op, exit 0.
- A delivery failure (e.g. Telegram API error) logs a warning to stderr but
  never aborts the caller.

## Examples

```
/notify check
→ Telegram not configured (silent no-op mode).
→ Terminal not configured (terminal-notifier absent — silent no-op; brew install terminal-notifier).

/notify telegram "Job ran: pr-babysit" "web#1234 MERGED"
→ (delivers to the user's Telegram chat when configured; silent no-op otherwise)

/notify terminal "Permission needed" "Claude needs your approval to use Bash" attn-abc123
→ (at-desk banner that coalesces by group when terminal-notifier is installed)
```

The attention hook (`scripts/hooks/notify-on-attention.sh`) builds an enriched
banner automatically from the session registry, e.g.:

```
title: "💻 Self-serve SSO reset dialog — needs approval"
body:  "Bash: pnpm vitest · yourname/feature-x · web--yourname--feature-x"
```
