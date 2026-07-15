---
name: scrub
description: Deterministic banned-token check for external surfaces — run before posting any PR body, commit message, or Slack draft with workspace origin, to catch FD-XXX/TASK-XXX/sub-item refs, the word Malvin, and workspace paths before they leak public
version: 1
visibility: user
triggers:
  - /scrub
backing_script: scrub.sh
depends_on: []
composes: []
---

## Purpose

Replace the manual "grep for `FD-`, `TASK-`, `Malvin`, ..." step in `TOOLS.md`
("Public vs internal surfaces") with a deterministic, scriptable check.
External surfaces — PR titles/bodies, commit messages, Slack drafts, docs —
must never carry workspace-internal references. That rule already failed
once as a manual step (an internal ref leaked into a public PR body); `scrub`
makes the check something a skill or gate can run and trust, instead of
something an agent has to remember.

Backed by `skills/scrub/scrub.sh` — a dependency-free bash/awk/grep script,
no third-party tools, no hardcoded machine paths.

A second, stricter profile — `--profile publish` — gates a different bar:
exporting workspace modules (skills, scripts, docs) to the public straper
registry, where even Linear-ID-style references that are fine in a PR to the
team (per `TOOLS.md`) need to come out. See "Publish profile" below.

## Arguments

```
/scrub [--strict] [--quiet] [--profile <name>] [file ...]
```

Or call the backing script directly (this is the common case — most callers
are gating a piece of drafted text, not a file already on disk):

```
skills/scrub/scrub.sh [--strict] [--quiet] [--profile <name>] [file ...]
<producer> | skills/scrub/scrub.sh [--strict] [--quiet] [--profile <name>]
```

| Argument | Required | Description |
|----------|----------|--------------|
| `file ...` | no | One or more file paths to scan. When omitted, reads the text from stdin instead. |
| `--strict` | no | `subitem-ref?` hits also fail the exit code. Default: advisory-only — still printed, but doesn't flip a clean exit to a failing one by itself. |
| `--quiet` | no | Suppress per-hit stdout lines. Only the exit code is meaningful (usage errors on stderr are never suppressed). |
| `--profile <name>` | no | Select a profile. Only `publish` is implemented today (see "Publish profile" below); omit for the default internal-jargon profile. An unrecognized value is a usage error (exit 2). |

### Token classes (default profile)

| Class | Pattern | Notes |
|-------|---------|-------|
| `fd-ref` | `FD-<digits>` | Case-sensitive. e.g. `FD-020`. |
| `task-ref` | `TASK-<digits>` | Case-sensitive. e.g. `TASK-114`. |
| `subitem-ref?` | bare `A`/`F`/`T`/`R` + one digit | e.g. `A1`, `F2`, `R1`, `T1`. **Always advisory** — the trailing `?` is permanent, not a severity toggle. These single-letter-plus-digit tokens collide with ordinary prose too often ("F1", "A1 sauce", "T1 line") to hard-fail by default. `--strict` is the caller's opt-in to treat them as hard failures anyway. |
| `assistant-name` | `Malvin` | Case-insensitive substring match, no word-boundary requirement — matches the workspace ban literally. |
| `workspace-path` | `workspaces/`, `plans/`, `designs/`, `agents/`, `tasks/`, `~/Developer/malvin`, `Developer/malvin` | Not preceded by a letter, so `myworkspaces/` isn't flagged. |

Exit codes: `0` clean, `1` hits found, `2` usage error (bad flag, missing or
unreadable file).

Output format, one line per hit, in file/line order:

```
<source>:<line>: <token-class>: <matched text (trimmed)>
```

`<source>` is the file path as given, or `stdin` when reading piped input.
"Matched text" is the full source line with leading/trailing whitespace
trimmed (not just the matched token) — enough context to judge a hit without
opening the file. A line that trips more than one class (e.g.
`tasks/TASK-001.json` is both `workspace-path` and `task-ref`) prints one row
per class, not one row per raw regex occurrence.

## Execution

1. Have the drafted external-surface text ready — a PR title, PR body,
   commit message, or Slack draft. Either write it to a file or pipe it
   straight into the script; piping is usually more convenient since the
   text is already in-hand as a string, not a file on disk:

   ```bash
   printf '%s\n%s\n' "$PR_TITLE" "$PR_BODY" | skills/scrub/scrub.sh
   ```

2. Read the exit code:
   - `0` — clean. Proceed (post the PR, commit, or Slack message).
   - `1` — hits found. Read the printed `<source>:<line>: <class>: <text>`
     rows, rewrite the flagged text per `TOOLS.md` ("Public vs internal
     surfaces" — e.g. describe a follow-up functionally instead of naming its
     sub-item ID), then re-run `scrub` on the rewritten text. Repeat until
     clean. Never ship text that still fails — a non-clean result blocks.
   - `2` — usage error (bad flag or missing file). Fix the invocation and
     retry; this is not a verdict on the text.
3. Treat a `subitem-ref?` hit as a prompt to look at the line, not an
   automatic failure — decide whether it's a real workspace reference or
   ordinary prose. Pass `--strict` when the caller wants that judgment call
   removed and every `subitem-ref?` hit to hard-fail too (this is what the
   `ship` gate does — see Consumers).

## Examples

```
$ printf 'Fixes the SSO wizard bug.\n' | skills/scrub/scrub.sh
$ echo $?
0

$ printf 'Part of FD-020, follow-up TASK-114. Malvin drafted this.\n' | skills/scrub/scrub.sh
stdin:1: fd-ref: Part of FD-020, follow-up TASK-114. Malvin drafted this.
stdin:1: task-ref: Part of FD-020, follow-up TASK-114. Malvin drafted this.
stdin:1: assistant-name: Part of FD-020, follow-up TASK-114. Malvin drafted this.
$ echo $?
1

$ echo 'See A1 for the sub-item.' | skills/scrub/scrub.sh
stdin:1: subitem-ref?: See A1 for the sub-item.
$ echo $?
0

$ echo 'See A1 for the sub-item.' | skills/scrub/scrub.sh --strict
stdin:1: subitem-ref?: See A1 for the sub-item.
$ echo $?
1

$ skills/scrub/scrub.sh --quiet pr-body-draft.txt notes/commit-msg.txt
$ echo $?
1
```

## Publish profile

`--profile publish` is a separate, stricter gate: the privacy check for
exporting workspace modules (skills, scripts, docs) to the public straper
registry. It runs a different set of checks than the default profile above
— your personal identity, your org's internal systems and people,
personal-workflow assumptions, branding, and credential-shaped strings — and
does **not** also run the internal-jargon checks. Run scrub twice (once
default, once `--profile publish`) for full coverage before an export.

```
skills/scrub/scrub.sh --profile publish [--strict] [--quiet] [file ...]
```

### Config file: why it lives in root `config/`, not `skills/scrub/`

Personal pattern classes (`identity`, `org-internal`, `personal-workflow`,
`branding`) load from `config/publish-gate.conf` — at the **workspace
root**, not inside `skills/scrub/`. This is deliberate: root `config/` is
your personal overlay, deliberately outside anything packaged when
`skills/` is exported to the public straper registry. If these patterns
lived inside `skills/scrub/` instead, exporting the scrub skill would ship
your own name, your org's internal repo/people/domain list, and your timezone
straight into a public registry — exactly what this gate exists to prevent.

The credential-shape checks (Slack/GitHub/AWS/Anthropic/OpenAI token shapes,
the publishable-key decode-check, the entropy backstop) are the opposite case:
they're hardcoded directly in `scrub.sh` because they're **not personal** —
"this looks like an API key" is generically useful to anyone who reuses the
exported skill, you included. So the exported skill still runs a real (if
reduced) gate with zero configuration: `--profile publish` never no-ops.

Override the config path with the `SCRUB_PUBLISH_PROFILE` env var — useful
for testing a draft config, or pointing at a different overlay entirely:

```bash
SCRUB_PUBLISH_PROFILE=/path/to/other-gate.conf skills/scrub/scrub.sh --profile publish file.md
```

When no config is found at the resolved path (missing, or unreadable), scrub
prints a notice to stderr and falls back to the hardcoded credentials-shape
checks only — it never fails silently or skips scanning entirely.

### Config format

One pattern per line: `<tier>|<class>|<extended-regex>`.

- `tier` — `FAIL` (always fails the exit code) or `WARN` (prints, only fails
  under `--strict`)
- `class` — free-form label, printed in hit output
- `regex` — POSIX extended regex (`grep -E` / awk ERE). No `\b`, no `(?i)` —
  neither is POSIX ERE. Use bracket classes for case-insensitivity (e.g.
  `[Ii]ago`) and `(^|[^A-Za-z0-9_])...([^A-Za-z0-9_]|$)` for word
  boundaries — the same convention `scrub.sh`'s own hardcoded patterns use.

Only lines starting with exactly `FAIL|` or `WARN|` are parsed; everything
else (blank lines, comments, anything malformed) is ignored, so a comment
just has to not start with one of those two literal prefixes. The regex
field may itself contain `|` (ERE alternation, e.g. `(internal-repo|other-repo)`)
— the parser splits on the first two pipes only, so this is safe.

The real config lives at `config/publish-gate.conf` (git-tracked, but not
under `skills/`), with classes grouped by remediation bucket in its own
comments.

### Token classes (`--profile publish`)

| Class | Tier(s) | Source | Notes |
|-------|---------|--------|-------|
| `identity` | FAIL | config | Your name, email, machine paths |
| `org-internal` | FAIL, WARN | config | Your org's internal repos/people/domains/tickets (FAIL); ambiguous repo words that are only sensitive in a repo/path context (WARN) |
| `personal-workflow` | FAIL, WARN | config | A literal timezone string (IANA zone or abbreviation) must come from config, never hardcoded (FAIL); single-channel assumptions, personal tool bundle ids (WARN) |
| `branding` | WARN | config | Your agent's env vars, bundle ids, and CLI name — a rename decision, not a leak |
| `credentials-shape` | FAIL, WARN | hardcoded (FAIL) + config (WARN) | Slack/GitHub/AWS/Anthropic/OpenAI/Telegram token shapes, the publishable-key decode-check, entropy backstop — all FAIL, hardcoded, always active; `op://` refs are WARN, config-driven |

The `(pk|sk)_(live|test)_` decode-check base64-decodes the key payload and
treats it as a placeholder (no hit) if it decodes to a generic `*.example`
host or a shared `accounts.dev` dev/test instance — so example keys already
published in docs don't fire, but a real-looking key does. Decode failure is
never treated as a placeholder (fails closed).

Output format is `[<FAIL|WARN>] <class>` instead of the bare `<class>:` the
default profile uses, so the two profiles are visually distinct:

```
skills/example/example.md:3: [FAIL] identity: description: notify <your-name> when the job finishes
skills/example/example.md:12: [WARN] branding: run ./scripts/<agent> example to start
```

### Example: gating a skill before export

```
$ skills/scrub/scrub.sh --profile publish skills/example/example.md skills/example/*.js
skills/example/example.md:3: [FAIL] identity: description: notify <your-name> when the job finishes
skills/example/example.md:12: [WARN] branding: run ./scripts/<agent> example to start
skills/example/example.md:20: [FAIL] org-internal: clone from your-internal-host/internal-repo
...
$ echo $?
1
```

A non-clean result means: rewrite the flagged lines (genericize, move to
config, or drop) per the remediation bucket noted in
`config/publish-gate.conf`'s comments, then re-run until clean — same loop
as the default profile's Execution step 2 above, just against a stricter
bar.

## Consumers

- **[[ship]]** — `skills/ship/ship.md` runs `scrub` as a mandatory gate on
  the drafted PR title, body, and latest commit message before `gh pr
  create`/`gh pr edit`. A non-clean result blocks the pipeline; the text must
  be rewritten and rescanned.
- **Any agent** about to post a Slack message, GitHub comment/PR, or
  public-facing doc that originated in this workspace — run `scrub` on the
  drafted text first, per `TOOLS.md` ("Public vs internal surfaces").
- **`--profile publish`** has no automated consumer yet — this is the gate
  itself, not the export pipeline. Run it manually before publishing a
  module to the straper registry until an export skill wires it in.

## Metrics

`scrub` has no `cli_command` and is not a `composes` target, so it doesn't
get automatic metrics coverage. An agent that invokes it as a skill should
append a row to `.metrics/skills.jsonl` by calling the shared helper — never
hand-write the JSON:

```bash
source scripts/lib/skills.sh
skills_log_event scrub check /scrub <duration_ms> <true|false> "" "<model-id>"
```

`skills_log_event` builds the row via jq and pins `at` to UTC `Z`. If
`.metrics/` is unavailable, skip silently — never fail the run over metrics.
