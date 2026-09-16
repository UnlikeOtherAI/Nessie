# iPad experience — a keyboard-first native shell

Status: **in progress.** Slice 1 (the command model) has landed with tests;
slice 2 (the native `UIKeyCommand` registrar and the shell wiring) is in this
same change. Later slices are scoped below and not yet built.

Scope: the **iPad native shell only** (`mobile/` running on iPadOS, gated on the
existing `formFactor === 'ipad'` / `IS_IPAD` probe). iPhone, Android, mobile
Safari and desktop keep exactly today's behaviour — no shared code path changes
its answer off that gate, mirroring how the shipped iPhone nav-bar plan was
scoped ([2026-09-05-ios-native-navigation-bar.md](2026-09-05-ios-native-navigation-bar.md)).

## What the iPad app is today, and what it is missing

The iPad app is one full-screen `react-native-webview` rendering the admin SPA,
with native chrome floated over the top edge: a glass tab bar (Channels,
Projects, Knowledge, Admin, Search), a back/forward/recent toolbar, a team
switcher, a focus-mode toggle, an account button, and a creation lane over the
web-drawn list column. The admin already renders its own responsive rail +
resizable secondary sidebar + detail *inside* that WebView on a wide screen, and
already knows it is inside the native iPad shell (`useNativeIPadApp()`), hiding
its own top bar and rail so the native chrome takes over. Every native control
drives the single WebView through the `runScript` bridge
(`mobile/src/lib/native-webview-actions.ts`).

That is a competent shell, but it is **touch-only**. An iPad is used on a Magic
Keyboard, and Nessie has **no hardware-keyboard support at all** — no
`UIKeyCommand`, so holding ⌘ raises nothing, and none of the muscle-memory chords
(⌘K to search, ⌘1–⌘4 to switch section, ⌘[ / ⌘] to go back and forward) do
anything. That is the single largest gap between this and a first-class iPadOS
app, and it is what this plan closes first.

**Deliberately not in scope:** a native split view or a second WebView. The
codebase warns against both — `react-native-bottom-tabs` is already kept off iPad
because its empty tab scenes can paint a black surface over the sibling
WKWebView, and the two visible columns on a wide iPad are the admin's *own* CSS
layout, not native panes. Re-drawing that split natively would fork a surface the
web already owns, which Rule zero forbids. The larger screen is served by making
the existing shell keyboard- and pointer-first, not by rearchitecting it.

## Slice 1 — the command model (landed)

`mobile/src/lib/ipad-key-commands.ts` is the single source of truth for the
command set. It is pure and fully unit-tested
(`ipad-key-commands.test.ts`), and it keeps every semantic — which chord means
what, the wrap arithmetic for cycling sections, the `UIKeyModifierFlags`
bitmask — in TypeScript so none of it has to be reasoned about in Swift.

- `IPAD_KEY_COMMANDS` — the table, ordered as the ⌘ overlay should read it.
- `serializeIpadKeyCommandsForNative()` — a flat `{ id, input, modifierFlags,
  title }[]` for the native registrar; no action semantics cross the bridge.
- `resolveIpadKeyCommandAction(id)` — id → action, `null` for an id from a
  future table (an installed shell must ignore, never crash).
- `applyIpadKeyCommandAction(action, handlers, { activeIndex })` — performs an
  action against the shell's existing entry points (tab select, search overlay,
  creation menu, toolbar back/forward, reload).

The command set:

| Chord | Action |
|---|---|
| ⌘1 / ⌘2 / ⌘3 / ⌘4 | Channels / Projects / Knowledge / Admin |
| ⌘K | Search overlay |
| ⌘N | New… (creation menu) |
| ⌘[ / ⌘] | Back / Forward |
| ⌃⇥ / ⌃⇧⇥ | Next / previous section (never lands on Search) |
| ⌘R | Reload |

## Slice 2 — the native registrar and shell wiring (this change)

- `modules/nessie-key-commands` — a small Expo module mirroring
  `nessie-app-icon`. `isSupported()` reports iPad; `register(commands)` takes the
  serialized table and installs the `UIKeyCommand`s so the hold-⌘ overlay lists
  them; it emits `onKeyCommand({ id })` when one fires. It is a **dumb
  registrar** — it holds no knowledge of what a command does.
- `mobile/App.tsx` — on iPad, register the commands once past the auth gate and
  route `onKeyCommand` through `resolveIpadKeyCommandAction` +
  `applyIpadKeyCommandAction` into the handlers the tab bar and toolbar already
  use (`onIndexChange`, `nativeActions.openSearchOverlay`,
  `nativeActions.runToolbarAction`, the creation menu, the boot recovery
  reload). No web change: every target already exists on the bridge.

Because the JS side uses `requireOptionalNativeModule`, a build that predates the
native module — or any non-iPad target — simply reports the feature unavailable
and no shortcuts register, exactly as the app-icon switch degrades.

## Later slices (scoped, not built)

1. **Pointer/trackpad polish** — hover and right-click affordances on the native
   chrome; most content hover is already the web's.
2. **A discoverability affordance** — a small "⌘" hint in the account menu that
   opens the shortcut list, for people without an attached keyboard to learn it.
3. **Menu-key parity** — surface the same commands in a hardware menu where
   iPadOS shows one (e.g. an external display / Stage Manager menu bar).

## Verification

- Slice 1: unit tests in CI (`turbo run test --filter=@nessie/mobile`).
- Slice 2 native: the shortcut chords cannot be injected by the automated
  simulator tooling, so the runtime behaviour is verified by a manual checklist
  on an iPad (or the simulator with a hardware keyboard): hold ⌘ shows the
  overlay; each chord performs its action; typing a message with a text field
  focused is unaffected except by the ⌘ chords. The build itself is verified to
  compile and launch. The JS wiring and the whole command model are covered by
  the unit tests above.
