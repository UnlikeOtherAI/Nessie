# Navigation — how it is done

This is the standing rulebook for anything that moves a person between
screens, opens an overlay, or handles Back, in the admin (`admin/`), the
native shells (`mobile/`, `desktop/`) and the tests that pin them. It was built
in the order laid out in
[`done/2026-09-01-navigation-motion-system/overview.md`](../done/2026-09-01-navigation-motion-system/overview.md);
each section says what is **built** and what is still **planned**, so this
rulebook is never ahead of the code.

**The rule:** there is one navigation framework. Adding a second way to push
a screen, slide a layer, open an overlay, decide Back, or classify a route is
the defect Rule zero names. If what you need is not here, extend the
framework; do not go around it.

## Table of Contents

Section numbers are stable: a reference to "§7" in a comment or a lint message
means section 7, wherever it now lives.

- [Page types, containers and motion](page-types-and-motion.md) — §1 Page
  types, §2 Stack containers never scroll, §3 Motion.
- [Registry, Back, layout and nested stages](stacks-and-layout.md) — §4
  Registry, controller and Back, §5 Layout, §6 Nested stages.
- [Overlays](overlays.md) — §7 Overlays.
- [Deep links, cold starts and screen headers](deep-links-and-headers.md) — §8
  Deep links and cold starts, §9 Screen headers.
- [The native shell contract](native-shell.md) — §10 Native shell contract.
- [Verification, the settle, and interruption](verification-and-settle.md) —
  §11 Verification, §12 Focus, announcement and scroll, §13 Interruption and
  visibility.
- [Arriving with content, and drafts](content-and-drafts.md) — §14 Arriving
  with content, §15 Drafts.

## 16. Still planned

Everything the plan
([`done/2026-09-01-navigation-motion-system/overview.md`](../done/2026-09-01-navigation-motion-system/overview.md))
names is built and described in the chapters above, except these, each noted
where it belongs and listed here so nothing hides:

- The centred-panel rendering of a Flow on `split` (§7).
- Per-layer `useScrollMemory` on `split` and the second-scroller lint (§11).
- The remaining `NAVIGATION_KEYFRAME_ALLOWLIST` / `BESPOKE_DIALOG_ALLOWLIST`
  entries in `admin/test/navigation-gates.test.ts`: each is one conversion
  away from deletion, and the gate refuses new entries.
