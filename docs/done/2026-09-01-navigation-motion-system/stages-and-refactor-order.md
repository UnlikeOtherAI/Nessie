# Stage assignment, refactor order, and the decisions

Chapter of [One navigation framework](overview.md). Which screen becomes which
stage, the order the refactor was taken in, and the usability, safety and
stability decisions of 2026-09-01.

## 5. Stage assignment

Every census stage maps to a type. Families, not individual rows; the full
per-stage tables live in the census outputs and the registry is the durable
form.

| family | Root | Detail | Nested detail | Tab host | Flow | Overlay |
| --- | --- | --- | --- | --- | --- | --- |
| Channels | `/channels` | conversation (incl. the personal-assistant DM, which has no info chain), `/channels/projects/:id`, `/unread-messages`, `/threads` (a Root-level list whose cards embed feeds, so it is a Detail that never offers pull-to-refresh) | info → members → add; reply thread (`single`) | Messages / Files / Automations / Agents | compose (`/channels/new`), document stream, DeepWater + executor launchers, record routine | members popup, channel settings + archive confirm, agent/user info drawers, call dialogs, thought process, attachment viewer, secret capture, emoji pickers, reaction popover, search strip |
| Projects | `/projects` | project | (none by route) | Overview / Board / Backlog / Insights / Docs / Executors / Settings | task create/edit | members dialog, project menus, create/edit/delete project, iteration and column confirms, archive-done menu |
| Dashboards | — | `/dashboards` | `/dashboards/:id`; add-widget panel; versions panel (nested stages on `single`, side panels on `split`) | — | edit mode (a Flow whose layout draft auto-saves; Done and Back both leave it with the draft kept) | — |
| Knowledge | `/knowledge-base` | space, product view | folder, document / file, history, editor (nested stages); zip peek | Full / Column / Tree, needs-review filter | — | attachments drawer, space settings, create space, file version upload, notes card and composer, wikilink confirm and suggestions, drop overlays |
| Agents | Admin | `/agents`, `/agents/:id` | sub-agent (`/agents/:childId` pushed from its parent, so Back returns to the parent agent) | Edit / To-dos / Activity / Sub-agents / Tools / Messages / Documents | designer, workflow designer | design-assistant drawer, agent quick-view drawer (`AgentDetailDrawer`, mounted from the shell), avatar quick edit + cropper, model combobox, to-do editors, workflow node menus |
| Automation | Admin | workflows, triggers, tools, executors | template → installation → run; failed-runs and drafts columns; trigger detail; tool detail; executor selection, access change, promotion | trigger status filter, tool source filter, executor tabs | trigger editor | import, delete confirms, inspector disclosures |
| Apps | Admin | `/apps` | `/apps/:slug` | Overview / Capabilities / Accounts / Agents; All / Installed | connect (dialog on `split`, screen on `single`) | custom app, secret, remove, disconnect confirms |
| Settings + ops | `/settings` | every settings page, `/audit`, `/approvals`, `/alerts`, `/tokens`, `/policy`, `/ops`, `/feedback`, integrations | status detail, `/ops/usage`, integration product | Colours / Text size | logo and photo croppers, session debug | create secret, emoji picker, billing cancellation dialogs, connection expanders |
| Shell | — | — | — | — | — | nav drawer, tab bar, home header, team menu, account menu, create menu, alerts bell, top-bar search, native search overlay, rail tooltips, header menus |
| Outside | login, bootstrap, external-auth completion, not-found, service-worker clicks, checkout hand-offs, SSO launches | | | | | never inside the stack |

## 6. Refactor order

Each step is independently shippable, verified with headless Playwright at
phone, tablet and desktop widths, and leaves the app consistent at its own
level. Commit and push per step.

1. **Kill the bounce.** `overflow: clip` on the four containers, `TabBar`
   track-only scroll, `focus({ preventScroll: true })` on the mount-time
   focus calls. Verify on device and with `repro.mjs`.
2. **One motion spec.** Tokens + `runStackTransition`; the route push and the
   gesture settle share it; delete the keyframes and the blanket reduced-motion
   rule. Give the JSDOM harness a fake `animate()` timeline; rewrite
   `phone-back-swipe-viewport.test.ts` and the keyframe regex in
   `phone-navigation-transition.test.ts` against the function; add the
   duration-parity test. **The Playwright job, seed and three viewports land
   here** (§4.19): it is the safety floor for every step after, so it cannot
   come last.
3. **Total registry.** Every route classified with real depths; delete
   `admin:detail`; `/alerts`, `/feedback`, `/threads` join their sections; the
   lint test that every router path has a row. Extend
   `phone-navigation-routes.test.ts`; leave the shell's `tabs.ts` alone, it is
   replaced in step 9. With this alone, every Agents and Settings push
   animates on a phone.
4. **One controller.** Promote the ledger and the Back registry; add
   `redirect()`, `back()`, `openFlow()`; delete `useHistoryNav`'s counter,
   `section-route-memory`, and the two designer smart-Backs; forward `state`
   through the `<Navigate>` redirects (fixes the workflow-run bug); route the
   six effect redirects through `redirect()`.
   **One Back** in the same step: `resolveBack()` behind every Back entry
   point (header, swipe, hardware Back, Escape, POP), and the top bar and
   iPad toolbar re-pointed at the one ledger as history controls that
   consult the registry first;
   `BackButton` replaces the four chevrons and the "Apps" / "Agents" /
   "Cancel" text buttons; Android tablets get the hardware handler; the
   `phone-back-doorway.test.ts` source pins move to the registry. The gesture
   finish (velocity-scaled settle, dimming scrim, `nessie:haptic`) lands
   here too, since it is the same resolver's commit.
5. **Split layout.** `ShellEnvironment.navigation`; `NavigationStack` in the
   shell's detail column and in the page-owned detail columns; the thread
   panel becomes a nested stage on `single` and a `Sheet` on `split`; project
   Docs rail and dashboard side panels follow the layout. The iPad and
   large-phone-landscape native swipe stays **on** until step 9.
6. **Nested stages.** `useNestedStage`; fold `ColumnBrowserViewport` (phone),
   Knowledge folder/document/history/editor, workflows/triggers/tools/
   integrations columns, executors panels and dashboard panels into the stack.
   Delete `animate-kb-view-slide`. Rewrite `phone-back-doorway.test.ts` and
   `knowledge-local-back.test.ts` against the registry.
7. **Tab hosts.** One state model (URL param, `replace`) for all fifteen
   strips; project section switch uses `replace`. `ProjectView` is one
   element reconciled in place across its seven routes, so its state
   survives; this step sits after step 4 because the old top-bar counter only
   advanced on `PUSH` and would stop reflecting section switches.
8. **Overlays and Flows.** The layer scale first (a pure token swap, no
   behaviour change); then `useOverlay` + `Modal`; then `Sheet` (eight
   drawers), `Popover` (menus, pickers, tooltips, one placement helper),
   `Card` (toasts, call banner, incoming-call ring); Flows present per
   layout; the fourteen bespoke dialogs adopt or justify. Rewrite
   `dialog-shell.test.ts` against `useOverlay`; add one test per kind that
   Back closes it before any route change.
9. **Screen header.** `ScreenHeader` per page type with the subtitle slot;
   the seven hero headers and the two 58 px headers converge; `OwnerGate`
   moves under the header; every screen gets its `h1`; `document.title` and
   `nessie:screen` post from the header; the shell drops its path matching,
   keeps a last-known section, and gains per-section badges. **Only now** the
   iPad and large-phone-landscape native swipe turns off, because every
   screen has a Back in its leading lane.
10. **Arriving with content.** `prewarm` on `controller.push()` wired to
    every navigating row; `keepPreviousData` on per-id detail hooks;
    `isPending` on list hooks with the three false-empty states fixed; one
    `Skeleton` per page type; the blob cache behind `useAuthedObjectUrl`.
11. **Focus, announcement, scroll, keyboard.** The settle hook focuses the
    `h1`; one live region; `aria-current` and the skip link; `useScrollMemory`
    per layer and manual scroll restoration; blur before push; the
    `visualViewport` listener; `dvh` on the remaining `vh` panels;
    `forced-colors` signals.
12. **Drafts.** `useDraft` and its storage; adoption in risk order (thread
    reply, composers keyed by channel, task, inline edit, designer, page
    editor, trigger editor, dashboard edit, settings forms); the idempotency
    key on message create; `If-Match` on the three versioned update routes;
    save buttons removed as each surface flushes on its own.
13. **Cold starts.** Stack seeding from `parentOf`; declared intent params
    with one consume path; `state` through every redirect; `from` on
    project-to-channel links; the desktop pending path.
14. **Shell polish.** `expo-haptics` + `nessie:haptic`; native pull-to-refresh
    off and the web gesture on Root and Detail scrollers; visibility-aware
    transitions; queued navigations during a slide.
15. **Gates and the transition suite.** Each gate lands with the step it
    guards (listed in §4.18); the Playwright job, seed and three viewports
    land with step 2 and grow with every step after.
16. **Docs — one rulebook, two pointers.** `docs/navigation/overview.md` is the
   standing reference for how navigation is done: the six page types, the
   registry, the controller API, the overlay kinds, Back, motion tokens,
   drafts, deep links, focus, and the gates. It is created in step 1 with the
   parts that exist and grows with every step, so the pointer is never ahead
   of the code. `AGENTS.md` and `CLAUDE.md` each get exactly one line, no
   restatement: *"Anything that moves a person between screens, opens an
   overlay, or handles Back goes through the navigation framework — read
   `docs/navigation/overview.md` first; it is the only way, and adding a second one is
   the defect Rule zero names."* The existing prose in `CLAUDE.md` → "Message
   reply threads" about panel widths, and the "One tab bar" / "One dialog
   shell" bullets, are trimmed to point at the rulebook rather than restate
   it; the claim there that `T` opens the focused message's thread is deleted,
   since no such handler exists in the admin. `docs/plans/2026-08-13-responsive-coherence.md`
   Phase 5 is marked delivered by this plan, and this file moves to
   `docs/done/` when built.

## 7. Decisions (made 2026-09-01, on usability, safety and stability)

These change behaviour a person can see, so they are recorded with the reason:

- **Project sections stop being history entries.** Back leaves the project,
  as it does for every other tab host; the URL still names the section, so
  links and refresh keep working. One rule for all fifteen strips beats a
  special case nobody can predict, and it removes the only place where Back
  could loop through seven entries before leaving a screen.
- **`/alerts` and `/feedback` are Details whose parent is their origin.** They
  are reached from the bell, the account menu and push notifications, from
  any section. Their registry row declares `parent: 'origin'`: Back pops to
  the previous in-app entry when one exists, and falls back to the Admin root
  on a cold deep link. Landing someone on Admin after they tapped a mention
  from Channels would be the surprise; the ledger already knows where they
  were. Their drawer shows the Admin nav, which is where both are listed.
- **Dialogs get a 150 ms fade and 4 px rise, no scale.** Reduced motion makes
  it 0 ms through the same path. Dismissal (Escape, scrim, close) is never
  gated on the animation, so a person can always close a dialog instantly.
- **iPad and large-phone landscape turn the native back/forward swipe off,
  after step 9.** The native gesture is a WebView-wide switch and cannot be
  scoped to the list column, and two owners of one edge gesture is the exact
  failure phones already fixed. The web stack owns the edge swipe in the
  detail column; the iPad toolbar's Back/Forward stay as history controls on
  the one ledger (§4.7), so cross-section history stays reachable. Until
  `ScreenHeader` lands, that toolbar is the only on-screen Back on iPad, so
  the native swipe is not removed before it.
- **Android predictive back is opted into** (`predictiveBackGestureEnabled`)
  in the same change that extends hardware Back to tablets, because the
  handler must move to the invoked-callback API for either to keep working on
  Android 14+. The system preview shows the launcher, never an in-app screen;
  the in-app motion stays the web stack's.
- **Direction follows `dir`.** The slide, the parallax and the edge zone
  flip for right-to-left locales; nothing hard-codes left. Print gets the
  current layer only, with overlays and retained layers hidden.
- **Status-bar tap-to-top** on iOS scrolls the current layer's scroll owner
  through a `nessie:scroll-to-top` message, because the document itself
  never scrolls.
- **`AgentDetailDrawer` stays.** The census row calling it dead was wrong: it
  is mounted from `AdminShellLayout.tsx:348` and opened by `selectAgent` from
  `ChannelMessageRow`. It is the agent quick view over a conversation; it
  converges on the shared `Drawer` primitive, registers with Back, and keeps
  reusing `AgentDetailTabs` so the drawer and `/agents/:id` cannot drift.
- **Tab state lives in a URL search param written with `replace`.** Linkable
  and refresh-safe, never a history entry, one model everywhere. Component-
  only tab state is migrated; nothing new may introduce it.
- **Safety floor for every step.** No step removes a Back path before its
  replacement is in place; `overflow: clip` ships first and alone so the
  bounce fix cannot be entangled with a refactor regression; each step lands
  with its rewritten tests and a Playwright pass at phone, tablet and desktop
  widths before the next begins.
