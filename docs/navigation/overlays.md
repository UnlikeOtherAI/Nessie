# Overlays

Chapter of [Navigation — how it is done](overview.md). §7: the overlay family
(Dialog, Sheet, Popover, Card), the one layer scale they share, their Back
rules, and the sanctioned carve-outs.

## 7. Overlays — **built** (step 8)

An overlay is one of four kinds — **Modal**, **Sheet**, **Popover**, **Card**
— plus the one sanctioned nesting, **blocking** (a confirm over an open
modal). Each kind has one layer, one Back precedence and one motion, declared
once in `navigation/overlay.ts` and mirrored as tokens:

| kind | layer token | Back | motion |
| --- | --- | --- | --- |
| Card | `--layer-card` 40 | never owns Back | slide + fade, `OVERLAY_MOTION.cardMs` |
| Popover | `--layer-popover` 50 | owns Back on `single` only | fade + 4 px rise, `popoverMs` |
| Sheet | `--layer-sheet` 60 | owns Back | slide from its edge, `drawerMs` |
| Modal | `--layer-modal` 70 | owns Back | fade + 4 px rise, `modalMs` |
| blocking | `--layer-blocking` 80 | outranks the modal beneath | as modal |

`--layer-stack` (1) is the navigation stack's own layer, and `--layer-tooltip`
(45) is the other layer without a kind: a hover hint owns no Back, traps no
focus and is never dismissed, but the two the rail and the sidebar portal
beside themselves are `position: fixed` and had picked 90 and 80 out of the
air — which put a hover hint over an open dialog. Nothing else in the admin
declares a z-index (the lint gate lands in step 15 once the fifty overlays have
adopted the scale). No scale, ever: a dialog rises 4 px.

### Every overlay leaves the page tree

The scale only decides who wins **inside one stacking context**. An overlay
left where it is declared — a task dialog inside the project board, a popover
inside a sidebar row — inherits every ancestor between it and the document, and
the admin's page path carries all three hazards: `main` clips,
`.phone-navigation-viewport` isolates, and `.phone-navigation-screen` is a
positioned, clipped layer that holds a transform for the whole of a stack
transition. Any one of them takes the viewport away as the overlay's containing
block, or traps its layer below the shell's own chrome. What that looks like is
not a subtle z-index bug: the scrim stops being the screen and becomes the
content column, so the rail and the secondary sidebar stay unblurred and paint
over the panel, and the panel is cut off at the sidebar's edge.

So no overlay renders where it is declared. Each one wraps its tree in
**`OverlayPortal`** (`components/overlays/OverlayPortal.tsx`), which portals
into one `.admin-overlay-root` host appended to `document.body` — where the
only stacking context is the root's and the only containing block is the
viewport. The host is shared by every open overlay (they are ordered by the
scale, not by DOM position) and is `display: contents`, so it is addressing
rather than layout. `admin/test/overlay-portal.test.ts` holds every `useOverlay`
consumer to it, exactly in both directions.

Two consequences worth stating:

- **The work surface's palette follows the overlay out.** Focus mode repaints
  the surface monochrome through `.focus-mode > .admin-shell`, which a portalled
  dialog is no longer inside, so the shell mirrors the mode onto the body
  (`overlays-focus-mode`) and the same rules carry a second arm for the host. A
  dialog opened in focus mode stays with the surface it came from.
- **`active={false}` is the one opt-out**, and it is not a loophole:
  `ChannelConversationComposePage` is a Flow, not a modal — on `single` it is a
  real screen in the phone navigation stack and must travel with its layer, so
  it portals only on `split`, where it visually is a centred dialog.

**`useOverlay({ id, kind, label, open, onClose, … })`**
(`components/overlays/useOverlay.ts`) is the shared work every overlay does
once: it registers `overlay:<id>` with the Back registry while open (so
hardware Back, the header Back, the edge swipe and Escape agree, and an open
overlay closes before any route change slides), composes the focus trap and
restore (modal, sheet, blocking) or Escape alone (popover), the drag-safe
scrim dismiss, the layer, and the open/close motion on the kind's token with
reduced motion at 0 ms through the same path. Dismissal is never gated on
the motion: state closes at once and the leaving element plays out inert
(`mounted` stays true while `closing`). `useModalA11y` and
`useOverlayDismiss` are its internals, and `admin/test/centred-modal-a11y.test.ts`
pins that nothing outside `useOverlay.ts` imports either one directly any
more. The fourteen bespoke centred dialogs from before this step (step 8)
split two ways, each pinned by `admin/test/dialog-adopters.test.ts`:

- **Onto `Dialog`/`ConfirmDialog`** — `CircleImageCropper` and
  `ExecutorRunLauncherDialog` fit an existing panel size outright;
  `ChannelSettingsDialog`'s hand-rolled archive confirm became the sanctioned
  nested `ConfirmDialog(blocking)`; `DocumentStreamLeaveConfirm` became
  `Dialog blocking` rather than `ConfirmDialog` because its three actions
  (Cancel / Stop and discard / the mode's own "keep writing" verb) don't fit
  `ConfirmDialog`'s two-button cancel/confirm shape.
- **Kept a carve-out on `useOverlay` alone**, each with its reason recorded
  where it stands — `MemberManagementPopup` (a fixed-header, fixed-search,
  independently-scrolling list none of the four geometries express),
  `SessionDebugDialog` (phone-tuned chrome: safe-area insets, a 44px close
  target, a dvh scrolling flex column), `AttachmentViewer` (locks page
  scroll), `AgentAvatarQuickEdit` (an avatar-centred card with no title-bar
  header), `DocumentStreamDialog` (branches its scrim on phone layout),
  `ThoughtProcessDialog` (a fixed-header / scrolling-log / fixed-footer
  split), `AgentScreenPanel`'s full-screen takeover (full-bleed rather than a
  centred card — it is the whole viewport, so it has no scrim to dismiss),
  `UoaBillingCancellationDialog` and
  `DeepWaterResearchLauncherDialog` (each its own `admin-card` panel family,
  the second with a sticky in-scroll header), and `TriggerEditorDialog` (a
  680px panel with a `text-sm` subtitle, neither of which is one of the
  shell's four geometries). `ChannelConversationComposePage` is the
  exception among exceptions: a Flow, not a modal — on `single` it is
  already a full screen in the phone-navigation stack, so it registers
  `useOverlay` only on `split`, where it visually is a centred dialog over
  the channel list.

**`Dialog`** (`components/shared/Dialog.tsx`) is the Modal primitive on this
hook, unchanged in API plus `blocking` for the sanctioned nesting;
`ConfirmDialog` builds on it. **`Sheet`** (`components/overlays/Sheet.tsx`) is
the Sheet primitive on the same hook — `side`, a four-name `size` drawn from
the geometries the drawers actually ship, full width and height on the
`single` layout (the one sanctioned layout branch, never a breakpoint), and a
swipe-to-close that projects the phone back-swipe's own slop, commit ratio and
flick velocity onto the sheet's axis rather than restating them
(`components/overlays/sheet-swipe.ts`). It has replaced the hand-rolled scrim,
literal z-index pair and CSS slide in five drawers: the mobile nav drawer
(`MobileNavDrawer`), the knowledge `AttachmentsDrawer`, the agent quick view
(`AgentDetailDrawer`), and the channel agent and user info drawers — each of
which now gets Escape, a focus trap and restore, `role="dialog"` and a Back
registration it did not have. Two edge cases stay outside it deliberately: the
thread reply panel's 900–1279 px overlay mode, whose three presentations are
one element switched by CSS breakpoints that no `single`/`split` branch can
express, and the design-assistant panel, which is docked in flow rather than
edge-anchored over a scrim.

**`Popover`** (`components/overlays/Popover.tsx`) is the anchored primitive on
the same hook: `anchorRef` (or an `anchorRect`, for a text caret), `placement`,
`label`, `role` (`menu | listbox | dialog | tooltip`), outside press on
`mousedown`/`touchstart`, Escape from the hook, and the popover layer — no CSS
transition of its own. It places itself through **one** `placePopover`
(`components/overlays/placePopover.ts`): given an anchor rect, the panel's
measured size, a preferred placement (`bottom-start | bottom-end | top-start |
top-end | right | left`) and the clipping bounds (`viewportBounds()`, or a
container rect), it flips to the opposite side when the preferred one does not
fit and clamps the panel inside the bounds, returning `{ left, top, placement,
maxHeight }`. It replaced the five private flip/clamp routines
(`WorkspaceMenu`, `UserMenuPopover`, `CreateMenuTrigger`, `ReactionPills`,
`WikilinkSuggestionMenu`, plus `ResponsivePageHeader`'s CSS anchoring), three of
which had no flip at all. Adopted by the account, workspace, create, header and
overflow menus, the alerts bell, the reaction "who reacted" popover, the status
and composer emoji pickers, the assignee picker, the model combobox and the
wikilink suggestion list. Rail tooltips stay as they are: `RailTooltip` is a
hover hint, not a dismissible anchored surface.

**`Card`** (`components/overlays/Card.tsx`) is the ambient kind, and one
**`CardViewport`** per shell (mounted by `ToastProvider`) is the region it lives
in: top-right on `split`, above the tab bar on `single`, decided from
`useNavigationLayout()` — which is what replaced the toast viewport's own
`max-width: 639.98px` media query. A card composes `runOverlayTransition({ kind:
'card' })` directly rather than `useOverlay`, because the three things it must
not do are the point: it never owns Back, never traps focus, and keeps
`role="status"`. A card arriving during a stack transition waits on
`whenStackSettled()` before it appears, so two motions never run at once; the
auto-dismiss timer and tap-to-open are unchanged, and dismissal marks the card
leaving so its motion plays before the owner drops the row. The toast stack is
its first adopter. The in-conversation call banner stays in flow in its
conversation and the incoming-call ring stays a dialog — it asks for a decision
and needs focus, which is exactly what a card refuses to take.

### The reply thread panel on `split`

The right-hand thread panel (`/channels/:id/threads/:threadId/replies/:rootId`)
pushes the conversation aside at ≥1280px, overlays it at 900–1279px and is a
full screen below that; its drag-resized width persists, and `T` opens the
focused message's thread. Its close is choreographed so the route never
outruns the motion:

- **The panel leaves before the route does.** `closeThread` sets `isClosing`,
  holds the navigation for `THREAD_PANEL_CLOSE_MS`, and only then goes to the
  channel — the panel's queries are keyed on the open root, so navigating
  first would blank it mid-animation. Reduced motion navigates at once.
- **What animates is the footprint, not the width.** The panel is the
  conversation column's flex sibling, so a negative `margin-inline-end` hands
  its space back (the conversation expands into it) while the panel rides out
  on a `translateX`. Animating its width would rewrap the whole thread every
  frame and read as the panel being crushed rather than pushed. The row clips
  only while that runs.
- **Tapping back into the conversation closes it** — the desktop equivalent
  of the scrim the overlay band already has — through one `onClickCapture` on
  the conversation surface. Capture phase means a reply control inside the
  column still runs afterwards, and `openThread` cancels the close the same
  click started rather than racing it. A click that ended a text selection is
  reading, not leaving, and is ignored.

Still planned: the centred-panel rendering of a Flow on `split`. The row
field exists (`flowPresentation`, §1) and every Flow today declares
`screen`, so nothing reads the other value yet.
Pinned by `admin/test/navigation-overlay.test.ts`,
`admin/test/dialog-shell.test.ts`, `admin/test/sheet.test.ts`,
`admin/test/place-popover.test.ts`, `admin/test/popover.test.ts` and
`admin/test/card-viewport.test.ts`.

