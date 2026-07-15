---
name: minimal-comment-density
description: Keep comments sparse — only constraints the code can't express. No JSDoc walls or rationale essays. Applies to product code AND workspace scripts/skills/hooks.
metadata:
  type: feedback
---

**What:** Code shipped under the user's name has low comment density. A comment exists only to state a constraint the code cannot express — an API fact, a non-obvious trap. No multi-paragraph JSDoc walls, no narrating machine behavior, no rationale essays; the code and its tests document behavior.

**Why:** The failure mode isn't "some comments were unjustified" — it's that justified-in-isolation comments still add up to noise when every step of a function gets its own explanatory block. Individually defensible, collectively a wall.

**How to apply:** Worker prompts for any code — product repos and this workspace's own scripts, skills, and hooks — set the bar explicitly: one-line comments max, only for inexpressible constraints; when in doubt, delete. Watch the aggregate trap: a worker asked to "explain the why" for several sequential steps will comment above each one. Cap it ("one comment per function, not one per step") rather than trusting "only when non-obvious" to self-limit. Same "individually fine, collectively too much" shape as [[gloss-ids-in-human-outputs]].
