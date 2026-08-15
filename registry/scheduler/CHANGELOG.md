# scheduler changelog

## 0.1.3 — 2026-08-04

Discover jobs by glob over `skills/*/jobs/*/` (skill-owned, per the skill-owned config/jobs contract) instead of a single workspace-root `jobs/` dir. A workspace-root `jobs/` directory is still read too, for one release, with a deprecation warning on stderr when it contains jobs. `scheduler-status` reports jobs from both locations. Docs (`scheduler.md`) updated for the new layout and to drop the `jobs/README.md`-at-workspace-root reference.

## 0.1.2 — 2026-07-28

Drop a stale reference to a deprecated legacy environment-variable name from a comment and the docs.

## 0.1.1 — 2026-07-28

Replace literal `scripts/<agent>` placeholder in usage text with runtime-correct wording.

## 0.1.0 — 2026-07-16

Publish scheduler v0.1.0.
