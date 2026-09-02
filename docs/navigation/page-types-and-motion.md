# Page types, containers and motion

Chapter of [Navigation — how it is done](overview.md). §1–§3: the closed set of
page types every screen belongs to, why a stack container never scrolls, and
the one motion spec every push and pop runs.

## 1. Page types

Every screen is exactly one of six types, and the type decides its container,
its motion and its Back rule. The type is **declared**, not inferred: every
route names its own in the surface registry (§4). **Built** (step 3) for the
five route types; Overlay, and the state-driven stages that register as Nested
details, arrive with steps 6 and 8.

| type | what it is | motion | Back |
| --- | --- | --- | --- |
| Root | a section's home (Channels, Projects, Knowledge, Admin, Search) | none | none; shows the menu |
| Detail | a screen with one parent | push / pop | to its parent |
| Nested detail | a push from a Detail (info → members → add; folder → document) | push / pop | to the previous stage |
| Tab host | a Detail whose sections swap in place | none (pill only) | leaves the host |
| Flow | a full-screen form or wizard; a screen on phones, a panel on split layouts | push / pop or open / close | closes the flow |
| Overlay | modal, sheet, popover, card | open / close | closes the overlay only |

A sibling swap (channel A → B) is a Detail whose identity key is unchanged and
never animates. A tab is never a history entry. A route that only forwards to
another one is not a screen at all: it carries `type: 'redirect'`, so it is
listed (the totality gate needs it, and the tab bar stays lit for the frame it
exists) but never classifies, never animates and never owns a Back.

### Tab hosts — **built** (step 7)

Fifteen in-page strips used three state models: component state, a URL search
param, and the project's seven route entries. They are now one model —
`admin/src/navigation/useTabParam.ts`:

```ts
const [tab, selectTab] = useTabParam('tab', CHANNEL_TABS, 'messages')
```

It reads the param, validates it against the strip's own values (an unknown or
absent value reads as the fallback, so an old bookmark degrades to the tab the
host opens on rather than a blank panel), and writes with
`setSearchParams(…, { replace: true })`. So a tab is **linkable and
refresh-safe but never a history entry**, and Back leaves the host. Every
other search param and the entry's `state` are carried over, so two strips on
one page cannot overwrite each other. Selecting the fallback deletes the param
rather than spelling out the default. No page keeps a tab in `useState` any
more, and nothing new may.

`fallback` is also the seam for a remembered preference: a host that stores its
last choice passes the stored value as the fallback and writes its store beside
`selectTab`, so the URL wins when it names a tab and the preference decides when
it does not. Three hosts do that — the knowledge view-mode cookie, the apps
filter (`localStorage`) and the agents scope (the session ledger). Each reads
its store **once per mount**: a fallback that moved after every write would
chase the param-deletion rule.

| host | param | values |
| --- | --- | --- |
| a conversation (`useChannelTab`) | `tab` | `messages` · `files` · `agent` · `to-dos` · `triggers` · `automations` · `agents` (as the conversation offers) |
| an app (`AppDetailPage`) | `tab` | `overview` · `capabilities` · `accounts` · `agents` (as the app offers) |
| an executor (`ExecutorDetailPanels`) | `tab` | `overview` · `access` · `operations` · `sessions` · `attention` |
| Appearance (`/settings/appearance`) | `tab` | `colours` · `type` |
| an agent (`AgentDetailTabs`) | `agentTab` | `edit` · `to-dos` · `activity` · `sub-agents` · `tools` · `messages` · `documents` |
| the apps catalogue (`AppsPage`) | `filter` | `all` · `installed` (default: this device's last view) |
| the agents list (`AgentsList`) | `scope` | `personal` · `team` · `global` (default: the session ledger) |
| the tool registry (`ToolsPage`) | `source` | `all` · `builtin` · `custom` · `mcp-remote` · `interactive-session` |
| the trigger list (`useTriggersPageState`) | `status` | `all` · `active` · `paused` · `error` |
| full-page search (`SearchPage`) | `mode` | `text` · `semantic` (default: this device's last mode) |
| a knowledge space (`KnowledgeWorkspace`) | `view` | `full` · `column` · `tree` (default: the `knowledgeViewMode` cookie) |
| Deep Water (`DeepWaterResearchPanel`) | `research` | `run` · `runs` · `settings` |

A conversation offers a different half of that list depending on what it is.
Messaging one agent is a conversation with a subject, so it carries that
agent's own sections — **Agent** (identity, tools, the way in to edit),
**To-dos** and **Triggers** — each rendered by the very component
`/agents/:id` renders. A channel carries the room's sections instead —
**Automations**, and an **Agents** roster whose rows open `/agents/:id`. The
two sets are deliberately exclusive: an agent-shaped section on a channel has
no single subject, and a roster of one on a DM is the shared-tab mistake that
put a "create an agent" card in a private conversation. `useChannelTab`
decides both from one `resolveConversationAgent`, and holds `?tab=` unchanged
until the channel, agent and Personal-Assistant reads have landed — otherwise
a deep link to a conversation's To-dos is rewritten to Messages before the
facts that justify it arrive.

A named param is used wherever `tab` would collide: `agentTab` because the
agent strip also renders inside the quick-view sheet over a conversation that
owns `?tab=`, and `research` because that panel sits inside a product detail on
the Integrations page. A strip that narrows a list (`role="radiogroup"`) uses
the same hook — `filter`, `scope`, `source`, `status` are filters, not panel
switches.

**Projects keep seven routes.** `/projects/:id` and its `/board`, `/backlog`,
`/insights`, `/docs`, `/executors`, `/settings` siblings stay real routes so
each is linkable, but the header's section menu navigates with `replace: true`,
so Back leaves the project instead of walking the sections a reader passed
through. The registry folds all seven into one `tabHost` identity and they
render the same element, so React reconciles one `ProjectView` across them: the
switch swaps the section without remounting the page or animating a layer.

**Three deliberate non-hosts**, each recorded where it stands: the scope choice
in `AppConnectDialog` and the key scope in `AppSecretDialog` are fields of a
form inside a modal — answered once and submitted, so a URL param would outlive
the dialog and collide with the tab of the page it was opened over; and the
top-bar search overlay's mode stays a device preference, because that overlay
floats over whatever route the reader is on.

Pinned by `admin/test/tab-param.test.ts`: the hook's three promises under a
`MemoryRouter`, the project switch's `replace` and single mount, the host/param
table above, and a source gate over `git ls-files` that fails when any file
rendering a `<TabBar` keeps its value in `useState` (allowlist: the two dialog
form fields, and it only ever shrinks).

## 2. Stack containers never scroll — **built** (step 1)

The navigation stack's containers are `overflow: clip`, never `hidden`:
`.phone-navigation-viewport`, `.phone-navigation-screen`, the shell's `main`,
and the column-browser wrapper. A hidden-overflow box is still a scroll
container, so any `scrollIntoView()` or `focus()` inside a screen that is
parked off to the right during a push scrolls it sideways; the transform
animation then runs on the compositor with that stale offset and the screen
lands short of its resting place until the next layout clamps it. That was
the bounce. The page scroller itself stays `overflow-x: hidden; overflow-y:
auto` (a `clip` axis computes to `hidden` beside a scrolling axis).

Consequences for page code:

- `TabBar` scrolls its own track (`track.scrollLeft`) and never calls
  `scrollIntoView`. Nothing else in a screen may call `scrollIntoView` from a
  layout effect either.
- A focus call that runs on mount uses `focus({ preventScroll: true })`.
- Pinned by `admin/test/phone-navigation-transition.test.ts` ("stack
  containers clip rather than hide"). Reproduction of the defect:
  `done/2026-09-01-navigation-motion-system/repro.mjs`.

## 3. Motion — **built** (step 2)

One spec, `admin/src/navigation/motion.ts`:

- `NAV_MOTION`: 300 ms, `cubic-bezier(0.22, 1, 0.36, 1)` (control points
  inside [0, 1], so it cannot overshoot), parallax 0.28, a 120 ms floor for a
  settle. `OVERLAY_MOTION`: modal 150, popover 120, drawer 250, card 200 ms
  (declared; the overlay primitives adopt them in step 8).
- `runStackTransition({ top, bottom, direction, progress, reducedMotion })`
  is the **only** thing that moves a navigation layer. It animates the two
  layers on the Web Animations API from exactly their current transform to
  the end poses, scaled to the travel that remains, and resolves `finished`
  when the top layer arrives. A route push, a route pop and a released edge
  swipe all call it; nothing else may animate a `.phone-navigation-screen`.
- Reduced motion is 0 ms through the same path: the transition still runs,
  settles and commits.
- `styles.css` declares only the **static poses** (`--forward-ready`,
  `--underlay`, `--current`, …) and mirrors the numbers as `--nav-duration`,
  `--nav-easing`, `--nav-parallax`, `--nav-shadow`. There are no
  `@keyframes phone-navigation-*`; `admin/test/navigation-motion.test.ts`
  pins the tokens equal to `NAV_MOTION` and
  `admin/test/phone-navigation-transition.test.ts` pins the keyframe count at
  zero.
- Tests: the JSDOM harness (`admin/test/support/phone-navigation-viewport-harness.ts`)
  supplies a fake `Element.prototype.animate` timeline on real timers, so a
  transition is driven to completion by the animation's finish, not by the
  viewport's fallback timer.
- The blanket `prefers-reduced-motion` CSS rule stays as the baseline for
  non-navigation CSS motion; navigation reads the query in JS.

