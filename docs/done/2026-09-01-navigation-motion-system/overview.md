# One navigation framework — census, page types, and refactor plan

**Status:** proposal, 2026-09-01. Nothing here is built yet.
**Trigger:** on the iPhone shell, tapping a channel slides the conversation in,
overshoots to the left (the avatars touch the screen edge, the Back chevron is
clipped), then springs back to rest. The investigation widened into a full
census of how the admin moves between screens, and the answer is a framework,
not a motion patch.

**Decisions this plan is built on:**

1. Consistency is the goal. Every move between two stages of the admin goes
   through one system, on phone, tablet, desktop and the native shells.
2. Animations stay, and on mobile they are the primary target. Every push and
   pop slides. The one thing that never slides is an in-page tab switch.
3. Page types are a closed set. Every screen is exactly one type, and the type
   decides its container, its motion, and its Back rule. A screen that needs a
   seventh type is a design defect to fix, not a case to special-case.

## Table of Contents

- [The bounce, the census, and the page types](census-and-page-types.md) —
  §1–§3: the root cause of the overshoot, what the admin already had, and the
  closed set of page types.
- [The framework](the-framework.md) — §4: containers, motion, the registry,
  Back, layout, overlays, headers, the native shell contract, and the gates.
- [Stage assignment, refactor order, and the decisions](stages-and-refactor-order.md)
  — §5–§7: which screen becomes which stage, the order the refactor was taken
  in, and the decisions made on usability, safety and stability.

The built framework, as it stands today, is documented in
[docs/navigation/overview.md](../../navigation/overview.md).
