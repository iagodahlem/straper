---
name: workers-commit-scoped
description: Worker dispatches must end with their own scoped commit so the user's later tweaks show up as a separate diff against the worker's output.
metadata:
  type: feedback
---

**What:** Worker subagents commit their own changes at the end of each dispatch — a conventional commit scoped to the dispatch (`git commit -- <paths>`), no push. The orchestrator must NOT bundle worker output with the user's post-dispatch tweaks into one end-of-task commit.

**Why:** The user layers manual tweaks on top of every worker dispatch — fixing styling, reordering, adjusting spacing. Keeping the worker commit isolated means their diff against `HEAD~1` shows exactly what they changed about the worker's output. That's how worker quality gets audited and future prompts get refined. Bundle it all together and that signal is lost.

**How to apply:** Every worker prompt includes the commit step explicitly — it's part of "done", not a follow-up. When several workers touch the workspace root, only one committing worker runs at a time; the shared git index races across parallel commits. Nothing internal leaks into the commit message — see [[minimal-comment-density]] for the code side of the same "clean handoff" discipline.
