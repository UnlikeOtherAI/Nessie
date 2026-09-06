# Admin architectural review — 2026-09-05

Status: **review complete; fixes landing in the same change** (see
[fix-plan.md](fix-plan.md) for what this PR fixes and what it leaves as
follow-ups).

Scope: `admin/` only — reusability of components, file naming and structure,
layering, data flow, state, navigation adherence, and frontend practice. The
API is owned by a parallel session and is out of scope; `packages/client-core`
and `packages/schemas` are read for contracts and touched only where the admin
is the consumer.

Method: nine parallel, read-only code audits against the written standards
(`AGENTS.md` Rule zero and Code Quality, `docs/architecture.md`,
`docs/provider-system-and-frontend-architecture.md`,
`docs/standards/design-system.md`, `docs/navigation/*.md`, the ratchet lints in
`eslint.config.js` and `scripts/lint-*.mjs`). Two Haiku sweeps for mechanical
scans, four Sonnet audits for layer consistency, three Opus audits for the deep
architectural questions. Every claim cites `path:line`; the reports are filed
unedited under `audit/`. The bug-grade claims (the knowledge deep-link render
loop, the dead call-realtime context, the inert `react-hooks` lint plugin, the
auth memo dependency gap, the two dead files) were re-verified by hand before
this synthesis. Two Haiku claims were discarded as false positives (see
[findings.md](findings.md) → "Discarded").

The existing
[content design system audit](../2026-09-01-content-design-system/overview.md)
(tables, lists, forms, pagination, dialogs, pills) is cited, not repeated.

## Table of Contents

- [findings.md](findings.md) — the consolidated register: every finding that
  survived, by theme, with severity, evidence pointer, and disposition.
- [fix-plan.md](fix-plan.md) — what lands in this change (three waves, file
  ownership per agent), what is deferred, and the decisions the team still
  owes.
- Audit reports, filed unedited:
  [the shared brief](audit/00-brief.md) ·
  [naming and placement](audit/01-naming-placement.md) ·
  [escape hatches and tokens](audit/02-escape-hatches.md) ·
  [facades](audit/03-facades.md) ·
  [components and layering](audit/04-components-layering.md) ·
  [pages and routing](audit/05-pages-routing.md) ·
  [500-line cap seams](audit/06-file-cap-seams.md) ·
  [providers and state](audit/07-providers-state.md) ·
  [navigation and dependency rules](audit/08-navigation-dependency-rules.md) ·
  [API boundary, errors, tests](audit/09-boundary-errors-tests.md).

## The one-paragraph diagnosis

The admin's architecture is better than its documentation says and worse than
its gates enforce. What is written down and gated holds remarkably well: one
identity source, one API client, one query-key module with an invariant test,
one `TabBar`, one `IdentityTile`, one `ScreenHeader`, a total surface registry,
zero `any`, zero `console.*`, zero default exports, a 48 %-unit / 26 %-render
test suite with real interaction tests. What is written down and **not** gated
has drifted in exactly the places the doc's own diagram does not model: 21 React
contexts wrap an authenticated page where the doc names five; six navigation
modules live in the shell they are supposed to sit under, which is why 60
imports run against the layer order; four routes render a second header shape
one directory below where the header gate looks; the facade layer follows a
sane convention (one `hooks.ts`, split by sub-resource) that the doc never
describes, while the doc prescribes a shape only one facade follows; and the
type boundary is asserted rather than parsed, with the shared record types
hand-duplicated in `client-core` and already drifting from the canonical zod
schemas. Two things are actual defects rather than drift: a `?pageId=` deep
link into the knowledge base can loop because the provider's context value is
rebuilt on every render, and a signed-in tab opens two SSE connections and two
WebSockets where one of each was intended — the second SSE reader feeding a
context nobody consumes. Roughly 80 % of the code follows the intended
conventions; the fixes below are mostly relocations, memoisation, and gates
that make the remaining 20 % impossible to grow back.

## What is genuinely good (do not re-audit)

- **Identity is single-source.** One `MeResponse`, one token, one writer
  (`lib/storage.ts`), 115 read sites all through `useAuthSession()`. The
  session provider already delegates renewal, logout, query reset and external
  auth to siblings ([07 §Appendix B](audit/07-providers-state.md)).
- **Navigation is one framework where it is gated.** Registry total, motion has
  one mover, `history.pushState` at zero, Back is never local state, tabs are
  URL params with `replace` on 21 hosts ([08](audit/08-navigation-dependency-rules.md)).
- **Typing and a11y hygiene** are well above the norm: 22 non-null assertions
  and one `as unknown as` in 883 files; zero genuinely unlabelled icon buttons
  in 679 ([09](audit/09-boundary-errors-tests.md) → "Not a problem").
- **The ratchet-lint idiom works.** Every gate with a self-checking allowlist
  has shrunk; `centred-modal-a11y`'s allowlist is empty. The fixes below add
  two more gates in the same idiom rather than inventing a new mechanism.
- **Facade naming is not sprawl.** `agents`/`agent-todos`/`agent-cards`/
  `designer`/`global-agents` and `mail`/`gmail`/`mailbox-connections` were each
  checked and are genuinely separate products on one core domain
  ([03](audit/03-facades.md) → "Not a problem").
- **Query keys are centralised and tested**, and `lib/query-keys.ts` is
  internally clean; its only problem is line count and five families that
  escaped it ([03 F2](audit/03-facades.md), [06 F13](audit/06-file-cap-seams.md)).

## Conventions to codify

These are the rules the code actually follows today. The docs are updated in
this change to state them, so the next author codifies rather than invents.

1. **A facade is one `hooks.ts` until it outgrows it, then it splits by
   sub-resource** (`knowledge/file-hooks.ts`, `threads/activity-hooks.ts`),
   never by CRUD layer. Query keys live in the facade's own `keys.ts`, all of
   which the invariant test scans. `api.ts`/`queries.ts`/`mutations.ts` is not
   the convention and the frontend-architecture doc no longer says it is.
2. **Imports run downward through ten layers** (`lib` → `hooks` →
   `navigation`/`facades` → `providers` → `primitives` → `overlays` → `shared`
   → `features` → `layouts` → `pages`). `components/shared` may call facade
   and provider hooks; a facade never imports from `components/`; nothing
   imports from `pages/`. Enforced by `scripts/lint-admin-layers.mjs`.
3. **`pages/<page>/` holds that page's composition and orchestration hooks**
   when they have exactly one consumer. The moment a second surface needs the
   component or the shape of the hook, it moves to `components/features/<domain>/`.
4. **Hooks are `useX.ts`**, components `PascalCase.tsx`, logic modules
   `kebab-case.ts`. No file is named `*-helpers`, `*-shared`, `*-components`,
   `shared.tsx`, or `utils`.
5. **`src/providers/` holds only components that create an app-wide React
   context.** Render-nothing native/effect bridges live in `src/bridges/`.
   Shell coordination contexts live in `layouts/admin-shell/` and are memoised.
6. **A screen is a screen wherever it renders.** `ScreenHeader` is the one
   entry point for a route's `h1` and title publication, whether the page
   renders it directly or a column browser / info flow does; the gate walks all
   of `admin/src`.
7. **A mutation that can fail says so.** Either its call site handles the
   error (inline via `toFormErrors`/`formErrorMessage`, or `onError`), or the
   `MutationCache` default toast does; a gate test lists the exceptions.
8. **Optimistic updates use the `favorites` shape** (`onMutate` snapshot,
   `onError` restore, `onSettled` invalidate) and are reserved for toggles over
   an already-cached list.
