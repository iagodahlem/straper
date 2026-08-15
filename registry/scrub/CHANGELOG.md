# scrub changelog

## 0.1.1 — 2026-08-04

`--profile publish` resolves its personal config from `skills/scrub/config/publish-gate.conf` (skill-local, current contract) first. A workspace-root `config/publish-gate.conf` is still read too, for one release, as a deprecated fallback with a stderr notice — a workspace that hasn't migrated its config yet keeps its personal pattern classes. Docs and tests updated for the new resolution order.

## 0.1.0 — 2026-07-15

Publish scrub v0.1.0.
