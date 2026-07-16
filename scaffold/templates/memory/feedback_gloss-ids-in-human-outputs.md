---
name: gloss-ids-in-human-outputs
description: Never show the user a bare internal ID (task, design, or sub-item code) — the first mention always carries a plain-language gloss; lead with the description, code in parens.
metadata:
  type: feedback
---

**What:** The first mention of any task, design, or sub-item in a user-facing message leads with a plain-language description and puts the code in parentheses — "the login-rate-limit fix (TASK-014)", not "TASK-014". Later mentions in the same message may be bare.

**Why:** The user juggles parallel sessions with far less loaded context than the agent. A bare ID forces them to go gather context before they can decide anything — the output was supposed to save them that trip. Verbosity isn't the fix either; the gloss is one clause, not a paragraph.

**How to apply:** Sub-item codes alone are banned in messages to the user; task and design IDs need their title or a short hook. This applies to every human surface: session replies, notifications, boot greetings, PR-ready summaries. Same shape as a naked link — see [[always-show-links]].
