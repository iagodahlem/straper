# Registry

Published modules that a Straper workspace consumes on demand. Each subdirectory here is one **self-describing module** — a versioned, independently publishable unit (for example, a skill). A workspace pulls modules in through a separate add step; this directory is where those modules are published from.

## Module layout

Every module lives in its own directory and describes itself. Nothing outside the directory is needed to understand or version it:

```
registry/<name>/
├── module.json      # Manifest — identity, version, dependencies, provenance
├── CHANGELOG.md     # Human-readable history, newest version first
└── <source files>   # The module's actual content
```

### `module.json`

The manifest is the single source of truth for a module:

| Field | Description |
|-------|-------------|
| `name` | Module identifier; matches the directory name |
| `type` | Kind of module (e.g. `skill`) |
| `version` | Semantic version of the published module |
| `deps` | Names of other modules this one depends on (empty when standalone) |
| `config_keys` | Configuration keys the module reads, if any |
| `source_commit` | Commit the module was published from (provenance) |
| `published_at` | ISO-8601 timestamp of publication |

### `CHANGELOG.md`

One section per released version, newest first, recording what changed at each version.

## No central manifest

There is deliberately **no top-level index or registry manifest** enumerating every module. Each `module.json` is authoritative for its own module, and nothing aggregates them. Because there is no shared file to edit, two modules can be published in independent pull requests without ever touching common state — so publish PRs never conflict.

## How modules are consumed

Modules are consumed by **vendored copy plus lockfile**, not as git submodules:

- On add, a module's files are copied into the consuming workspace.
- The workspace records a lock entry pinning the module to its `{ version, source commit }`, so the vendored copy is reproducible and upgrades are explicit.

Because consumption is a copy, a workspace keeps working with no live link back to this registry. Re-running add against a newer published version updates the vendored copy and its pin.

> The shape of what gets written into a consuming workspace — file naming and on-disk layout on the consumer side — is defined by the add step, not here. This document covers only what a published module contains and how it is versioned and consumed.
