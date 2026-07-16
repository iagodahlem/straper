---
name: audit-the-class-not-the-instance
description: When the second instance of the same problem class appears, stop fixing instances — name the class and audit all of it before the user finds the third.
metadata:
  type: feedback
---

**What:** When the second instance of the same violation class shows up, stop. Name the class, run a comprehensive audit of the whole class (evidence-traced, with a classification table and a target-state proposal), and present the complete picture for review before executing fixes.

**Why:** Reactive instance-fixing feels productive and keeps momentum, but it outsources the discovery work to the person who should be reviewing conclusions, not hunting bugs. The trust cost of "you missed more of the same thing" is far higher than the time cost of a systematic pass. Never let the user find the third instance.

**How to apply:** This applies to any class: content leaks, ownership violations, stale docs, drifted copies, naming conventions. The trigger is the count — one is an instance, two is a class. On the second, switch from fixing to auditing.
