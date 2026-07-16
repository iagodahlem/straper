---
name: scheduler
description: Out-of-band scheduler — runs jobs on a wall clock with no Claude session open. Fires due jobs (plain scripts OR skill invocations) and delivers output via notify.
version: 1
visibility: user
triggers:
  - /scheduler
backing_script: scheduler.sh
cli_command: scheduler
depends_on:
  - notify
composes: []
---

# Scheduler Skill

## Purpose

A generic "run anything on a schedule" engine. It fires jobs on a wall clock
with **no interactive Claude session open** — the substrate for recurring work
(pulse harvests, PR babysitting, stale-worktree sweeps) that would otherwise
only run when the user opens a session.

Backed by `skills/scheduler/scheduler.sh` (the dispatcher tick),
`skills/scheduler/install.sh` (macOS launchd installer/healthcheck), and
`skills/scheduler/com.agent.scheduler.plist` (the launchd template).

## Platform support

The scheduler splits into a **portable core** and a **platform-specific
trigger**:

- **Portable:** `scheduler.sh` (one foreground tick) and `scheduler-status.sh`
  (read-only status) are plain bash + jq. `scheduler run` / `scheduler status`
  work anywhere those are installed.
- **macOS (fully wired):** `install.sh` renders `com.agent.scheduler.plist`
  into `~/Library/LaunchAgents/` and loads it with `launchctl`, so the tick
  fires every 5 minutes with no session open. This is the only bundled trigger.
- **Linux (bring your own trigger):** launchd is absent, so there is no bundled
  installer. Point a **systemd user timer** or a **cron entry** at
  `skills/scheduler/scheduler.sh` on a 5-minute cadence to get the same
  out-of-band wake. `scheduler status` and `scheduler run` still work directly.

**Known gap:** the time helpers use BSD `date` syntax (`date -j`, `date -r`),
so on Linux (GNU `date`) the `times:` schedule and the human time-formatting
degrade to empty rather than resolving. `every:` (interval) schedules, which are
pure epoch arithmetic, work on both. Porting the date calls to GNU `date` is the
outstanding item for first-class Linux support.

## Architecture

```
launchd (com.agent.scheduler, StartInterval=300, RunAtLoad)   # macOS trigger
   └─ every 5 min → skills/scheduler/scheduler.sh   (one tick)
        ├─ read jobs/*/*.md frontmatter (one def per per-job folder)
        ├─ DUE-CHECK each job (zero-inference bash/jq/date vs per-job state)
        ├─ weekday / active-hours gate
        ├─ CLAIM-BEFORE-ACT (write in_flight → overlapping ticks stand down)
        ├─ DISPATCH the job's `command`  (a plain script OR a `claude -p` skill run)
        ├─ DEDUP by result hash + NOTIFY via skills/notify/notify.sh
        └─ advance last_run only after notify completes; clear in_flight
```

- **L1 — Trigger.** `~/Library/LaunchAgents/com.agent.scheduler.plist`
  (`StartInterval=300`, `RunAtLoad`, stderr→`/tmp/agent-scheduler.err`) on
  macOS, or an equivalent systemd/cron entry on Linux. The sole out-of-band
  wake. The in-repo template lives at
  `skills/scheduler/com.agent.scheduler.plist`; `install.sh` renders
  `__AGENT_ROOT__` and copies it.
- **L2 — Dispatcher.** `skills/scheduler/scheduler.sh`. Most ticks are no-ops;
  only a genuinely-due job runs its `command` (the due-check is pure bash/jq/date,
  so cheap ticks cost nothing). A job's command is usually a plain shell script
  (no LLM); only a job whose command shells out to a nested `claude -p` (e.g.
  pulse harvest) spends a Claude turn. Idempotent under overlapping ticks via
  claim-before-act.
- **L3 — Jobs.** Each job is a **self-contained folder** `jobs/<id>/` holding
  its def `<id>.md` (md + YAML-ish frontmatter) plus an optional `run.sh` helper
  (a pure-skill job needs only the `.md`). **Jobs live TOP-LEVEL in `jobs/` by
  design** — they are data, decoupled from this engine. The scheduler is a
  generic runner; a job's `command` can be a plain script OR a skill invocation.
  See "Jobs" below.
- **L4 — Notify.** Output is delivered through the [[notify]] skill
  (`skills/notify/notify.sh`), per each job's `notify` policy. The
  no-auto-post boundary lives there.

## The scheduler runs ANYTHING, including skills

A job's `command` is just a shell string. It can be:

- a plain helper script colocated in the job folder — `./jobs/pr-babysit/run.sh`,
  `./jobs/stale-worktree-sweep/run.sh`; or
- a **skill invocation** via headless Claude —
  `printf '%s' "$PROMPT" | claude -p --allowedTools "..."` that runs a skill's
  mode (e.g. a combined pulse scheduled run). The helper
  `jobs/slack-pulse/run.sh` is exactly this — it drafts a notification AND
  harvests to memory in one read.

The scheduler does not care which — it runs the command, captures stdout+stderr,
hashes it for dedup, and notifies per policy. This is what makes it a generic
substrate rather than a point solution.

When a job shells out to a nested `claude -p`, the scheduler exports
`AGENT_SCHEDULER_JOB=1` into the command's environment so the workspace
`SessionStart`/`SessionEnd` hooks stand down (no boot/teardown housekeeping, no
status churn for headless runs). Consumers dual-read `AGENT_SCHEDULER_JOB` and
then the legacy `MALVIN_`-prefixed name.

## Arguments

```
/scheduler install      # install + load the LaunchAgent + fire one tick (macOS)
/scheduler uninstall    # bootout + remove the installed plist (macOS)
/scheduler status       # jobs status view (table; --json for machine output)
/scheduler health       # launchd healthcheck (launchctl print + recent stderr)
/scheduler run-now      # run one tick right now (foreground, no launchd)
/scheduler add-job      # how to add a new job (guidance)
```

These map to `skills/scheduler/scheduler-status.sh` (status),
`skills/scheduler/install.sh` (install / uninstall / health), and
`skills/scheduler/scheduler.sh` (run-now).

## Execution

### `install`

```bash
bash skills/scheduler/install.sh
```

macOS only. Renders the plist template with the resolved repo root,
`launchctl bootstrap` + `enable` + `kickstart` (fires one tick now). Idempotent —
re-running boots out the old service first. **This is the user's to run** (it
touches `launchctl`). On Linux, wire `scheduler.sh` into a systemd user timer or
cron entry instead (see Platform support).

### `uninstall`

```bash
bash skills/scheduler/install.sh --uninstall
```

`launchctl bootout` and removes `~/Library/LaunchAgents/com.agent.scheduler.plist`.

### `status`

The jobs status view — a read-only, aligned table of every discovered job with
its schedule, last run, **next due**, last result, notify policy, and live state,
under a one-line launchd LOADED/NOT-LOADED header.

```bash
bash skills/scheduler/scheduler-status.sh            # human table
bash skills/scheduler/scheduler-status.sh --json     # machine output (data layer)
```

```
Scheduler: LOADED  (com.agent.scheduler)

JOB                   SCHEDULE                       LAST RUN                NEXT DUE               LAST RESULT  NOTIFY     STATE
pr-babysit            every 1h Mon-Fri                43m ago (Jun 04 10:04)  in 16m (Jun 04 11:04)  ok           on-change  idle
slack-pulse           10:00,14:00,18:30 Mon-Fri       43m ago (Jun 04 10:04)  in 3h (Jun 04 14:00)   ok (sent)    silent     idle
stale-worktree-sweep  09:30 Mon-Fri                   1h ago (Jun 04 09:34)   in 22h (Jun 05 09:30)  ok           on-change  idle
```

The `LAST RESULT` cell appends a delivery tag — `(sent)` / `(not sent)` — for a
self-delivering job (one that is `notify: silent` because it sends a
notification itself). Such a job emits a `delivered_telegram=true|false` sentinel
in its stdout that the scheduler captures into the metric row's `delivered` field
(`last_delivered` in `--json`); jobs that emit no sentinel show no tag. This makes
a self-delivering job's notification visible even though the scheduler never
sends it.

It is **pure read + format**: it never runs a job, never spawns `claude -p`,
never mutates state. `NEXT DUE` is computed by **reusing scheduler.sh's own
due-check helpers** (`is_due` / `days_allows_today` / `within_active_hours` /
the `every`-vs-`times` split, plus the frontmatter parser) — sourced directly so
there is ONE source of truth. The displayed next-due is exactly the next instant
the scheduler's due-check would flip the job to DUE.

`--json` emits a stable, documented object —
`{ scheduler_loaded, generated_at, jobs: [...] }` with snake_case keys (see the
schema comment block atop `scheduler-status.sh`). **This is the shared data
layer a future menubar plugin and a jobs dashboard page would both consume** —
keep it stable when extending.

### `health`

The launchd healthcheck (macOS):

```bash
bash skills/scheduler/install.sh --status
```

Reports LOADED/NOT LOADED, the key `launchctl print` lines, plist presence, and
the tail of `/tmp/agent-scheduler.err`. For the raw service record:
`launchctl print gui/$(id -u)/com.agent.scheduler`. The jobs `status` view above
already surfaces the LOADED/NOT-LOADED line; use `health` for the deeper
launchctl detail.

### `run-now`

Run one tick in the foreground without waiting for launchd (useful to test a
job or after editing a job def):

```bash
bash skills/scheduler/scheduler.sh
```

To force a specific job due first, reset its state:

```bash
echo '{"in_flight":null,"last_run":0,"last_result_hash":""}' > .scheduler/state/<id>.json
bash skills/scheduler/scheduler.sh
```

### `add-job`

A job is a self-contained folder `jobs/<id>/` holding `<id>.md` (frontmatter +
optional body) plus an optional `run.sh` helper. See `jobs/README.md` for the
full frontmatter schema. Minimal shape — `jobs/my-job/my-job.md`:

```markdown
---
id: my-job
every: 6h               # OR  times: ["09:30","18:30"]
days: mon-fri
tz: UTC                 # any IANA tz; defaults to $AGENT_SCHEDULER_TZ, else UTC
active_hours: "09:00-19:30"
substrate: local
notify: on-change       # silent | on-change | always | error
recurring: true
command: ./jobs/my-job/run.sh
persist_paths: memory/pulse/   # optional — scoped git commit of job output
---

# my-job
Body is free-form notes (or the headless prompt for a `claude -p` command).
```

- `command` is **relative to the repo root** and can be the colocated
  `./jobs/<id>/run.sh` helper OR an inline `claude -p` skill run (see above). A
  pure-skill job needs only the `.md` — no `run.sh`.
- Jobs go in **`jobs/<id>/` at the workspace root**, never inside this skill
  dir — jobs are data, the engine is logic (SCHEMA.md "Data vs. Logic").
- The scheduler discovers jobs via the `jobs/*/*.md` glob, which excludes the
  schema doc `jobs/README.md` at the `jobs/` root.
- No validator yet — `jobs/schema.json` + `validate-jobs.sh` is a later step.
  `jobs/README.md` is the contract until then.

## State & output

- Per-job state: `.scheduler/state/<id>.json` (gitignored) — `last_run`,
  `last_result_hash`, `in_flight`.
- Tick metrics: `.metrics/scheduler.jsonl` (one JSON line per outcome).
- launchd logs: `/tmp/agent-scheduler.out`, `/tmp/agent-scheduler.err`.
- **Pulse output lands in `memory/pulse/YYYY-MM-DD-HHMM.md` (harvest) and
  `memory/pulse-drafts/YYYY-MM-DD-HHMM.md` (drafts)** — the combined pulse job
  writes both per run (drafts file only when there is ≥1 opportunity), and
  delivers the drafts to the user itself (the job is `notify: silent` so the
  scheduler does not double-notify). Because a nested `claude -p` writes from a
  separate process, the workspace `PostToolUse` auto-commit hook never sees the
  files; so the job declares `persist_paths: memory/pulse/, memory/pulse-drafts/`
  and the scheduler does a scoped `git add <paths> && git commit` (never
  `git add -A`, never a push) after a successful run, so away-for-days runs persist.
- **Delivery visibility:** `jobs/slack-pulse/run.sh` appends a
  `delivered_telegram=true|false` sentinel to its stdout; the scheduler captures it
  into the metric row's `delivered` field, so the otherwise-invisible (`notify:
  silent`) send shows up in `.metrics/scheduler.jsonl` and `scheduler-status`.
- **Boot digest + retention:** `scripts/session-start.sh` prints a deterministic
  digest of `memory/pulse/*.md` since the last boot (frontmatter counts + "N pending
  ack"), advances a gitignored `.sessions/.last-boot` marker, and archives pulse /
  pulse-drafts files older than 14 days into an `archive/` subdir. Promotion stays
  agent-driven + ack-gated (BOOT.md step 3) — the digest only makes discovery exact.

## Graceful Degradation

- No `jobs/` dir or no job files → logs and exits 0.
- A job with no `command` → logged, skipped (not run).
- `substrate: remote` → not wired yet; logged and skipped gracefully.
- `notify.sh` absent → the tick logs and degrades; it never fails.
- An overlapping tick on a slow job → claim-before-act makes the second tick
  stand down; exactly one execution, one notification.

## Examples

```
/scheduler status
→ Scheduler: LOADED  (com.agent.scheduler)
→
→ JOB                   SCHEDULE                       LAST RUN                NEXT DUE               LAST RESULT  NOTIFY     STATE
→ pr-babysit            every 1h Mon-Fri                43m ago (Jun 04 10:04)  in 16m (Jun 04 11:04)  ok           on-change  idle
→ slack-pulse           10:00,14:00,18:30 Mon-Fri       43m ago (Jun 04 10:04)  in 3h (Jun 04 14:00)   ok (sent)    silent     idle
→ stale-worktree-sweep  09:30 Mon-Fri                   1h ago (Jun 04 09:34)   in 22h (Jun 05 09:30)  ok           on-change  idle

/scheduler health
→ Service: gui/501/com.agent.scheduler
→ State: LOADED
→ program = /bin/bash ... skills/scheduler/scheduler.sh

/scheduler run-now
→ [scheduler] slack-pulse: due — dispatching (substrate=local notify=silent)
→ [scheduler] slack-pulse: persisted output (2 file(s)) under: memory/pulse/ memory/pulse-drafts/

/scheduler uninstall
→ Booted out gui/501/com.agent.scheduler
→ Removed ~/Library/LaunchAgents/com.agent.scheduler.plist
```

## Metrics

Autonomous ticks — launchd firing `scheduler.sh` with no Claude session open — already
log their own way, per-job, to `.metrics/scheduler.jsonl` (see State & output above). That
ledger is the source of truth for tick/dispatch outcomes and is not duplicated here.

For an agent-initiated `/scheduler <subcommand>` invocation (`status` / `health` / `install`
/ `uninstall` / `run-now`), also append a row to `.metrics/skills.jsonl` for uniform
skills-metrics coverage — never hand-write the JSON:

```bash
source scripts/lib/skills.sh
skills_log_event scheduler "<subcommand>" /scheduler <duration_ms> true "" "<model-id>"
```

`<subcommand>` is the resolved argument (`status` / `health` / `install` / `uninstall` /
`run-now`). If `.metrics/` is unavailable, skip silently — never fail the run over metrics.
