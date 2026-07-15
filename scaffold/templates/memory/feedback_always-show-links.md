---
name: always-show-links
description: Anything reachable that gets mentioned to the user (PR, chat thread, dashboard, doc, ticket) must come with its link inline — no naked mentions.
metadata:
  type: feedback
---

**What:** Every user-facing mention of something reachable — a PR, a chat thread or message, a ticket, a dashboard, a doc — carries its URL inline on the first mention.

**Why:** A mention without a link forces the user to go hunt for the thing before they can act on it. The message was supposed to save that trip, not add one. The bare identifier (a PR number, a ticket code) is the easy thing to reach for and reads as "enough" in the moment, but it isn't clickable.

**How to apply:** Construct the full URL before sending, not just the shorthand. When no URL was ever captured, say so explicitly and give the best pointer you have (channel + date + author). This applies to session replies, notifications, and any summary meant for the user. Same context-blocker class as bare internal IDs — see [[gloss-ids-in-human-outputs]].
