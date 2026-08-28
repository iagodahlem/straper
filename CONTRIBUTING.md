# Contributing a module

This page is for anyone proposing a new skill, or a change to an existing one, into `registry/`. If you're working on Straper the CLI tool itself — `src/`, the scaffold engine, template variables — see [docs/contributing.md](docs/contributing.md) instead; this page only covers the registry.

## What a module is

A module is a self-describing, independently versioned unit published under `registry/<name>/`. Every module fully describes itself — nothing outside its own directory is needed to understand or install it:

```
registry/<name>/
├── module.json      # Manifest: identity, version, dependencies, provenance
├── CHANGELOG.md     # One section per released version, newest first
└── <source files>   # The module's actual content (<name>.md, scripts, etc.)
```

`module.json` fields (see [registry/README.md](registry/README.md) for the full reference):

| Field | Description |
|-------|-------------|
| `name` | Module identifier; matches the directory name |
| `type` | Kind of module. Every module published today is `type: "skill"` — no other type is implemented yet |
| `version` | Semantic version of the published module |
| `deps` | Names of other modules this one depends on |
| `config_keys` | Configuration keys the module reads, if any |
| `source_commit` | Commit the module was published from |
| `published_at` | ISO-8601 publish timestamp |

There is deliberately no top-level index enumerating every module — each `module.json` is authoritative for its own module, so two modules can be proposed in independent PRs without ever touching shared state.

## The schema a module has to satisfy

A skill module starts life as a directory `skills/<name>/` in your own workspace, containing a `<name>.md` with YAML frontmatter. The authoritative check is `skills_validate`, from `scripts/lib/skills.sh` (published from this repo's `scaffold/scripts/lib/skills.sh`) — run it against your skill before proposing it:

```bash
<agent> skills validate <name>
```

It requires:

- `name`, `description`, `version`, `visibility`, and `triggers` present in frontmatter
- `name` matches the directory name
- `visibility` is one of `user`, `system`, `internal`
- `backing_script`, if set, resolves to a real file on disk
- `depends_on` and `composes` only reference skills that actually exist
- a WARN (non-fatal) if another installed skill declares one of the same `triggers` — a collision can be intentional, so it's surfaced, not blocked

`<agent> skill new <name>` scaffolds a correct-by-construction skill — frontmatter, a command wrapper, and optionally `config/`/`.state/` — if you're starting from scratch. It ships as the `skill` module, so you need `straper add skill` in your workspace before that command exists.

Several published modules (`skill`, `service`, `scheduler`, `workspace-review`) point authors at a `skills/SCHEMA.md` for the fuller skill-owned config/state architecture. That file is expected to live in a *consuming* workspace, not in this repo — `skills_list`/`skills_validate` deliberately exclude `SCHEMA.md` and `INDEX.md` from skill discovery for that reason — and this repo does not currently ship its own copy. Whether and where a canonical `skills/SCHEMA.md` should live in this repo is a maintainer's call.

## The publish gate

`straper publish <module> --registry-repo <path-to-this-repo>` (or the `STRAPER_REGISTRY_REPO` env var in place of the flag) is what actually pushes a module toward this registry. It refuses to run at all unless your own workspace has both a gate engine (`skills/scrub/scrub.sh`) and gate config (`config/publish-gate.conf`) — publishing is gated on your environment, not a flag you pass.

What it checks, in order:

1. **Committed at HEAD.** Publish only ever picks up what's committed under `skills/<module>/`. Uncommitted edits are silently *not* published — with a warning — so what ships always matches git history.
2. **Self-containment.** Every file in the module is scanned for `require`/`import`/shell `source` references. A reference into another skill that isn't declared in `depends_on` fails the publish; a reference to anything else outside the module, and outside the small runtime baseline (`src/baseline.ts`), fails too. A module has to stand alone once it's vendored into someone else's workspace.
3. **The publish scrub gate** — `skills/scrub/scrub.sh --profile publish`, a stricter bar than the day-to-day internal-jargon scrub. It rejects personal identity, your org's internal systems/people, personal-workflow assumptions, branding, and credential-shaped strings (Slack/GitHub/AWS/Anthropic/OpenAI token shapes, plus an entropy backstop). The credential-shape checks are hardcoded in `scrub.sh` itself, not configuration, so this profile still runs a real gate even with no local config.
4. **A derivable description.** `<name>.md`'s frontmatter needs a `description:` field — the Agent Skills spec requires `SKILL.md` to carry one, and publish won't invent one for you.

If all of that passes, `publish` still doesn't push straight to the registry. It bumps the module's version (see Versioning below), writes `module.json`, appends `CHANGELOG.md`, and opens a new branch (`straper/publish-<module>`, auto-suffixed on collision) in a throwaway worktree of your `--registry-repo` checkout — committing there with `feat(registry): publish <module> module v<version>`. Nothing is pushed for you.

## Proposing a module

1. Build and validate the skill in your own workspace — `<agent> skill new`, then `<agent> skills validate <name>` until it passes.
2. Make sure your workspace has `skills/scrub/scrub.sh` and `config/publish-gate.conf`; publish refuses without both.
3. Commit the skill.
4. Run `straper publish <name> --registry-repo <path to a checkout of this repo>`.
5. Review the branch the command created, push it, and open a PR against this repo.

## Review expectations

Beyond "the gate passed," there is no separate contribution funnel yet — no skill-gap issue template, no dedicated reviewer checklist. The general PR bar from [docs/contributing.md](docs/contributing.md#pr-guidelines) applies (focused, tested where there's logic to test, a clear description of what changed and why), but what a reviewer should specifically look for in a *new module* — beyond what the gate already enforces — is a maintainer's call, to be written up once the registry has taken in outside contributions to learn from.

## Versioning

Each module's `version` in `module.json` is independent of Straper's own package version, and independent of every other module's version. Versioning is fully automatic today: `publish` reads the module's existing `module.json`, if any, and bumps the patch number by one; a module's first publish is always `0.1.0`. There is currently no supported way to request a minor or major bump instead — that mechanism, and the judgment calls around when a change deserves one, is a maintainer's call for later.

`CHANGELOG.md` gets a new `## <version> — <date>` section per publish, newest first, auto-filled with a generic "Publish `<module>` v`<version>`." entry. Replacing that with a real description of what changed is expected, but not yet enforced by any tooling.
