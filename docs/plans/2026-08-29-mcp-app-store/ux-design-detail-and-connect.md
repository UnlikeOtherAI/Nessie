# Apps page — detail, connect, and management (Part B of 2)

**Scope.** This document covers `/apps/:slug` (detail view), the Connect flow,
connection management, agent access, custom servers, trust treatment, and the
component reuse map. Part A covers the catalogue page, cards, categories,
search, and responsive catalogue layout — nothing here contradicts it; the two
share the card component and the app domain vocabulary.

**Product language, enforced everywhere in UI copy:**
MCP server → **App**; OAuth connection → **Connected account**; tools/list →
**Capabilities**. The strings "MCP", "OAuth", "PKCE", "token", "transport",
"instance", "credential", and "scope" never appear in member-facing copy. They
remain visible only inside a collapsed *Technical details* disclosure.

---

## 1. App detail view — page or drawer?

### Recommendation: **full page**, `/apps/:slug`, with inline tabs.

**Justification against the precedent.** Nessie already made this exact
decision for agents. `admin/src/pages/AgentDetailPage.tsx` documents it in its
header comment: "the same … tabs the old floating drawer showed, now rendered
inline as a full page inside the Agents section (no drawer)." The pattern that
won there is exactly the one an app detail needs:

- A back-to-list secondary button (`admin-button admin-button-secondary` with
  `faChevronLeft`, labelled with the section name — here "Apps"), plus
  `PhoneNavigationButton` on small viewports.
- A header row: avatar/icon, `h1` name in
  `text-2xl font-semibold text-[color:var(--tx)]`, status pill
  (`StatusPill` from `admin/src/components/primitives/StatusPill`), a
  secondary line in `text-sm text-[color:var(--tx2)]`, and a tertiary meta
  line in `text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]`.
- Body below `border-t border-[color:var(--sep)]`, tabs inline.
- A not-found/loading state that is a centered
  `text-sm text-[color:var(--tx3)]` message, not a toast.

**Justification against deep-linking.** A connected app is a durable object
with durable substates (accounts, agent access). It must be linkable:
`AgentConnectorSection.tsx` already deep-links from an agent's integrations
page into the catalogue via query params
(`/mcp-app-store?catalogEntryId=…&action=install`) — evidence that the product
needs URL-addressable app surfaces. A path segment `/apps/:slug` is better
than a drawer opened by query param: it survives refresh, works in browser
history, can be pasted into a chat to a teammate ("connect this:
`https://app.nessie.works/apps/github`"), and lets a *later* agent config page
link straight to `/apps/:slug#access`. A drawer owns none of those. Drawers
also fight the OAuth popup dance: the detail surface must be alive and polling
while the user is off in a provider window; a full page is the more robust
owner of that lifecycle.

**What about `CatalogDetailPanel`?** It stays on `/mcp-app-store` as the
owner/super-admin surface (publish, review, lock, deprecate). The `/apps`
detail page is the *member* surface: connect, accounts, capabilities, agents.
The two never fork each other — they share the capability-list and
accounts-list components (§7). The Connectors page gets a link out: "View as
App →" on published entries, so an owner can preview what members see.

### Layout — not yet connected

```
┌──────────────────────────────────────────────────────────────────┐
│ [← Apps]  (PhoneNavigationButton on <md)                         │
│                                                                  │
│ ┌─────────────────── HERO (bg-[var(--panel)], ─────────────────┐ │
│ │  rounded-[var(--radius-xl)], border-[var(--line)], p-6/p-8  │ │
│ │                                                              │ │
│ │  [64px icon]  GitHub                              [Verified] │ │
│ │  rounded-lg   by GitHub, Inc. · Developer tools              │ │
│ │               ─────────────────────────────────────────────  │ │
│ │               Read and act on repositories, issues, and pull │ │
│ │               requests — your agents can summarize PRs,      │ │
│ │               triage issues, and draft releases.             │ │
│ │                                                              │ │
│ │               [ ● Connect Nessie to GitHub ]  ← primary      │ │
│ │               42 capabilities · Free to connect              │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  TABS: [Overview] [Capabilities (42)] [Agents with access]       │
│  ───────────────────────── border-b border-[color:var(--sep)]    │
│                                                                  │
│  OVERVIEW TAB                                                    │
│   "What you can do" — 3–5 curated benefit bullets,              │
│    each: ToolCategoryIcon + one benefit sentence (tx2)           │
│   "Details" — 2-col dl: Provider, Website, Trust, First listed   │
│                                                                  │
│  CAPABILITIES TAB (preview, not connected)                       │
│   List of capability groups w/ ToolBadge rows — read-only,       │
│   tx3 note: "Connect to enable these for your agents."           │
│                                                                  │
│  AGENTS WITH ACCESS TAB                                          │
│   EmptyState: "No agents can use this yet" + body:               │
│   "Connect the app first, then choose which agents may use it."  │
└──────────────────────────────────────────────────────────────────┘
```

Hero specifics: the icon is the app icon in a
`h-16 w-16 rounded-[var(--radius-lg)] border border-[color:var(--line)] bg-[var(--panel-soft)]`
tile; fallback is `ToolCategoryIcon` at 28px in `text-[color:var(--tx3)]` when
the app has no icon. Name `text-2xl font-semibold text-[color:var(--tx)]`;
provider line `text-sm text-[color:var(--tx2)]` with the trust badge (§6)
inline after it. Description is curated and benefit-focused — written as what
the *person's agents can now do*, never protocol facts. Primary CTA is
`admin-button admin-button-primary`, label `Connect Nessie to {name}` (or
`Connect` at <sm widths). Meta under the CTA:
`text-xs text-[color:var(--tx3)]`.

### Layout — connected

```
┌──────────────────────────────────────────────────────────────────┐
│ [← Apps]                                                         │
│ ┌─ HERO (same shell) ─────────────────────────────────────────┐  │
│ │ [icon] GitHub                              [Verified]       │  │
│ │        by GitHub, Inc. · Developer tools                    │  │
│ │        ✓ Connected   ← StatusPill tone="success"            │  │
│ │                                                             │  │
│ │ [+ Connect another account] ← secondary button              │  │
│ │ [Manage access] ← secondary, jumps to Agents tab            │  │
│ └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ TABS: [Overview] [Capabilities (42)] [Connected accounts (2)]    │
│       [Agents with access (3)]                                   │
│                                                                  │
│ OVERVIEW TAB (connected)                                         │
│  Capability count strip (see below) + "Used by agents" chips:    │
│   [AgentAvatar · Research] [AgentAvatar · Release Notes] …       │
│   each chip is a Link to /agents/:id                             │
│                                                                  │
│ CONNECTED ACCOUNTS TAB                                           │
│  ┌ row: Avatar · Ada (ada@work.com) · Work  ────── [Manage ▸] ┐  │
│  │        StatusPill success "Connected"                      │  │
│  ├ row: Avatar · adacodes · Personal ──────────── [Manage ▸] ┤  │
│  └ [+ Connect another account]                                ┘  │
│                                                                  │
│ CAPABILITIES TAB (connected)                                     │
│  Header line: "42 tools · 3 resources · 3 prompts" (tx2) +       │
│  "Refreshed 2h ago" (tx3) + Refresh button (ghost)               │
│  Grouped ToolBadge list, each row expandable: name, one-line     │
│  description, ToolPermissionPill, ToolTransportPill              │
│                                                                  │
│ AGENTS WITH ACCESS TAB — see §4                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Capability count strip** (connected overview): three or four stat tiles,
reusing the visual grammar `AgentConnectorSection` already uses — `rounded
border border-[var(--sep)] px-3 py-2`, label `text-[11px] font-semibold
uppercase text-[var(--tx3)]`, value `mt-1 text-sm text-[var(--tx)]`. Tiles:
Capabilities (tools), Resources, Prompts, Accounts. These answer "what did I
get?" — the only telemetry a member needs. Failure counts and health probes
are owner-ops data and stay on the Connectors page (rule 3: no ops telemetry
on a member surface).

**Tab mechanics:** tabs render as a text tab row
(`border-b border-[color:var(--sep)]`, active tab
`text-[var(--tx)] border-b-2 border-[var(--accent)]`, inactive
`text-[color:var(--tx3)] hover:text-[color:var(--tx2)]`, transition
`duration-[var(--duration-fast)] var(--easing-standard)`). Deep-linkable via
`?tab=accounts`. Counts in parentheses use `text-[color:var(--tx3)]`. On <md
viewports the tab row scrolls horizontally; the tab content is never a
drawer-within-a-page.

Every color above is a token; nothing is a literal. All hover/fills use
`--main-hover`/`--overlay-weak` for ghost buttons exactly as
`CatalogDetailPanel`'s `ghostButton` class string does — reuse that class
composition verbatim.

---

## 2. Universal Connect flow — the user's experience

The flow is one state machine with three entry skins. The UI state is driven
by a small status enum the API already effectively has; the admin renders one
**ConnectProgress** inline panel (never a toast, never a blocking modal) in
the detail hero while a connect is in flight.

### (a) No-auth server

1. **Idle.** Primary button `Connect Nessie to {name}`.
2. **Clicked → "probing".** Button becomes
   `Connecting…` with the standard disabled treatment
   (`disabled:opacity-40`), and an inline progress panel appears directly
   under the hero CTA (`rounded-[var(--radius-md)] border
   border-[color:var(--sep)] bg-[var(--panel-soft)] px-4 py-3`), showing a
   step list with the current step in `text-[var(--tx)]` and completed steps
   with a `--success-text` check:
   - ✓ Checking the server…
   - · Loading capabilities…
3. **Connected.** Panel collapses, hero flips to the connected layout, a
   `StatusPill tone="success"` "Connected" appears, and the Accounts tab shows
   the implicit "Default" connection. Elapsed target < 3 s; if longer, the
   step list keeps the user oriented — no bare spinner is ever shown alone.

### (b) OAuth server — desktop/web

1. **Idle.** Same primary button.
2. **Clicked.** Inline panel step 1: "Opening {Provider} sign-in…". Nessie
   calls the start endpoint and immediately opens a **centered popup**:
   `window.open(url, 'nessie-connect', 'width=600,height=760,left=…,top=…')`,
   centered on the opener's screen. A sized, positioned `window.open` — never
   an iframe (provider `X-Frame-Options` would break it, and users must see
   the provider's real URL bar to trust the login), and never a full tab
   (loses the opener's context).
3. **Waiting state in the opener.** The detail page stays fully visible;
   inside the progress panel, the waiting state reads:
   > **Waiting for {Provider}…**
   > Finish signing in in the window we opened. You can keep working here.

   with a subtle `--executing-soft`-tinted pulse on the current step
   (`--executing` is the existing "something is actively working" token — the
   right semantic here). A small ghost link: "Didn't open? Open it again ↗"
   (re-issues `window.open` with the same URL).
4. **Popup lifecycle.** The popup lands on the provider login → approve
   screen. The callback URL is an admin route (`/apps/oauth/callback`) that
   completes the exchange server-side, then renders a minimal interstitial:
   > **You're connected.** You can close this window.

   styled on `--main`/`--tx` (this page is part of our product, themed like
   everything else), and attempts `window.close()`. If the browser refuses to
   close a script-opened window, the message stands as the manual instruction.
   The opener detects completion via the existing instance-status query
   (poll/refetch on window focus) — **not** `postMessage` coupling, so the
   same flow works when popup and opener end up in different processes.
5. **User closes the popup early (AUTH_CANCELLED).** Opener detects popup
   closure without completion and shows, inline in the panel:
   > **Connection cancelled.** Nothing was connected. You can start again
   > whenever you're ready.

   with a `Try again` primary-compact button. This is an **info** treatment
   (`--info-soft`/`--info-border`/`--info-text`), not danger — cancelling is
   a legitimate choice, not a failure.
6. **Popup blocked.** If `window.open` returns null, the panel switches to:
   > **Your browser blocked the sign-in window.** Allow popups for this site,
   > or open sign-in directly:

   with a normal `<a href target="_blank" rel="noopener">` button — this is
   the pattern `CredentialsDialog.connectViaOAuth` already uses
   (`window.open(flow.authorizationUrl, '_blank', 'noopener')`), extended with
   the blocked-detection branch. Same warning tone, never silent failure.
7. **"Still working…" copy.** After 20 s in the waiting state, append a `tx3`
   line: *"Still waiting — {Provider} can be slow to respond. You can close
   this and try again."* After 120 s, auto-transition to AUTH_EXPIRED copy
   (below) with a retry button.

### (c) Mobile

On viewports < md (and in the Tauri mobile shells), popups don't exist as
windows; the flow becomes:

1. Connect button performs the same start call, then hands the authorization
   URL to the **system browser**: `ASWebAuthenticationSession` on iOS, Chrome
   Custom Tabs on Android, plain `window.open(url, '_blank')` as the web/PWA
   fallback. In the Tauri shell this is the OS browser via the shell opener.
2. **In-page state while away:** the detail page persists a pending-connect
   marker (`sessionStorage`, keyed by app slug + flow id) before leaving, and
   renders the same waiting panel — so when the user task-switches back, the
   page says "Waiting for {Provider}…" rather than looking idle.
3. **Return.** The callback route redirects back to `/apps/:slug?connected=1`
   (or the app-scheme deep link in the native shell). On mount, the detail
   page consumes the marker + query param, refetches instance status, and
   either flips to Connected, shows the inline error for the returned error
   code, or — if neither param nor marker resolves (user just wandered back)
   — clears the marker and returns to Idle after one status refetch.
4. **App resumed from background** (`visibilitychange` → visible): trigger the
   same status refetch. This single hook covers every "came back later" path.

### Error surfaces — normalized copy

All errors render in the same inline panel: `--danger-soft` /
`--danger-border` / `--danger-text` (except AUTH_CANCELLED, info as above),
`role="alert"`, with the friendly sentence as the body and a collapsed
**Technical details** `<details>` disclosure in `text-xs
text-[color:var(--tx3)]` holding the raw code + server message for owners and
support. Raw strings like `invalid_grant` or a stack trace never render
outside that disclosure. Each error gets a retry affordance where retry is
meaningful.

| Code | User-facing sentence (exact) |
|---|---|
| AUTH_CANCELLED | "Connection cancelled. Nothing was connected — you can start again whenever you're ready." |
| AUTH_EXPIRED | "The sign-in session expired before it finished. Try again — it only takes a moment." |
| AUTH_FAILED | "{Provider} didn't accept the sign-in. Check that you approved the access request, then try again." |
| SERVER_UNREACHABLE | "We couldn't reach {name}'s server. Check your connection and try again — if it keeps happening, the service may be down." |
| SERVER_INVALID | "That address doesn't look like an app server. Check the link and try again." |
| MCP_INITIALIZATION_FAILED | "We reached {name}, but it didn't answer correctly. This is usually a problem on the app's side — try again later." |
| CAPABILITY_DISCOVERY_FAILED | "{name} connected, but we couldn't load what it can do. Try refreshing capabilities from the Manage menu." |
| OAUTH_DISCOVERY_FAILED | "We couldn't work out how to sign in to {name} automatically. If you run this server, check its sign-in configuration; otherwise try again later." |
| CLIENT_REGISTRATION_FAILED | "We couldn't register Nessie with {name} to sign you in. Try again — if it persists, ask the app's provider whether third-party sign-in is enabled." |
| CONNECTION_FAILED | "Something went wrong while connecting to {name}. Nothing was saved. Try again." |

Every sentence names the *user's next action* ("try again", "check the link",
"use the Manage menu") — an error that answers no question is cut (rule 3).

---

## 3. Connection management

The **Connected accounts** tab lists each connection as a row
(`rounded-[var(--radius-md)] border border-[color:var(--sep)]
bg-[var(--panel-soft)] px-4 py-3`, the same row grammar as
`CredentialsDialog`'s `OverrideRow`):

```
┌────────────────────────────────────────────────────────────────┐
│ [Avatar]  Work                                    [Manage ▾]  │
│           ada@work.com · StatusPill success "Connected"        │
│           Connected 3 days ago · tx3 meta                      │
└────────────────────────────────────────────────────────────────┘
```

- **Display name**: user-editable label, defaulting to the provider account
  name; rendered `text-sm font-medium text-[var(--tx)]`.
- **Connected identity**: `Avatar` (primitives) with the provider profile
  image when available, fallback initials; username/email in
  `text-sm text-[color:var(--tx2)]`. This identity is what disambiguates
  "GitHub Personal" from "GitHub Work" — it is mandatory, never optional.
- **Status**: `StatusPill` — `success` Connected, `warning` Needs reconnect,
  `danger` Error.
- **Manage** opens a menu (or, at <sm, a bottom sheet) with exactly five
  actions: **Rename**, **Reconnect**, **Refresh capabilities**, **Agent
  access**, **Disconnect**. Rename is an inline edit, not a dialog. Reconnect
  re-enters the §2 flow with the existing connection as target. Refresh
  capabilities re-probes and reports "42 tools · 3 resources · 3 prompts —
  refreshed just now" in the row's meta line. Agent access jumps to the
  Agents tab pre-filtered to this account.
- `+ Connect another account` is a secondary button below the list,
  permanently visible — multiple accounts are a first-class, day-one state,
  not an edge case. The §2 flow runs identically; the resulting row joins the
  list.

**Disconnect confirmation** — a small modal (not a browser `confirm`), built
on the standard scrim (`fixed inset-0 z-50 … bg-[var(--scrim-strong)]`),
`useModalA11y` + `useOverlayDismiss`, panel `max-w-md
rounded-[var(--radius-lg)] border border-[color:var(--sep)]
bg-[color:var(--main)] p-6`:

> **Disconnect "Work" from GitHub?**
>
> - **3 agents** that use this account will immediately lose access to
>   GitHub capabilities.
> - The sign-in is revoked — Nessie forgets the connection and can't use it
>   again until you reconnect.
> - **History is kept.** Past agent conversations and actions that used this
>   account are not deleted.
>
> [ Cancel ]  [ Disconnect ]  ← `dangerButton` class string from
>   CatalogDetailPanel, verbatim

The warning lists consequences in that order (agents impacted → revocation →
what survives), because "history is kept" is the reassurance that makes the
destructive button safe to click. If zero agents use the account, the first
bullet is omitted rather than shown as "0 agents" — no empty signal.

**Never shown, anywhere in this UI:** any token, secret, `credentialRef`,
secret id, or masked variant of one (`••••abcd` is still a tease of a secret —
cut it). The only credential fact a member ever sees is "Stored encrypted",
as `OverrideRow` already renders. Owner-level credential plumbing stays on the
Connectors page.

---

## 4. Agent access UX

**The invariant, stated in UI terms:** *Connect an account* (the workspace can
reach the app) and *let an agent use it* (a specific agent may call those
capabilities through that account) are two separate decisions with two
separate controls. Connecting never silently grants agents access; granting
access never silently connects. This mirrors — at product level — the split
already explicit in the backend between installation scope and per-agent tool
grants.

**The control: `AgentAccessList`.** On the app's **Agents with access** tab:

```
┌──────────────────────────────────────────────────────────────┐
│ Agents with access                          account: [Work ▾]│
│                                                              │
│  ☑ [AgentAvatar] Research Agent                              │
│      Can use all 42 capabilities          tx3                │
│  ☑ [AgentAvatar] Release Notes                               │
│      Can use all 42 capabilities                             │
│  ☐ [AgentAvatar] Support Triage                              │
│      No access                                               │
│                                                              │
│  ⓘ Agents you don't check can't see or call this app at all. │
└──────────────────────────────────────────────────────────────┘
```

- One row per agent the *viewer is entitled to manage* — entitlement-scoped,
  never ambient-context-scoped (rule 2): owners see all workspace agents;
  members see agents they administer. The list is not silently narrowed by
  the session's current team.
- Each row: checkbox, `AgentAvatar`, name, and a consequence line. The
  account selector at top right scopes the list when multiple accounts exist
  (an agent may be allowed on "Work" but not "Personal").
- **Architected for per-tool permissions without redesign:** the row's
  consequence line is a *summary slot*, not a literal string. Today it reads
  "Can use all 42 capabilities"; later, when per-capability grants ship, the
  same row gains a chevron that expands into a capability checklist and the
  summary becomes "Can use 12 of 42 capabilities". The checkbox remains the
  coarse on/off; expansion is progressive disclosure, so the shipped layout
  doesn't move when the feature lands.
- **Empty state** (`EmptyState` from shared): title **"No agents can use this
  yet"**, body **"This app is connected, but no agent has permission to use
  it. Check an agent above to let it call these capabilities."** — shown when
  zero agents are checked, because an un-used connection is the common
  "why doesn't my agent see the tool?" support case; the empty state pre-answers
  it.
- **Consequence copy** at the foot of the list (info treatment,
  `text-xs text-[color:var(--tx3)]`, icon `--info-text`): *"Agents you don't
  check can't see or call this app at all. Removing access takes effect
  immediately; running agents finish their current step."*

**Placement and reuse.** `AgentAccessList` lives on the app detail page, and —
per rule 4, one component parameterised by scope — the *same component* later
appears on the agent's own config page, parameterised by agent instead of by
app ("Apps this agent can use", rows are apps with per-app checkboxes). Do
**not** fork it.

**Relationship to `AgentConnectorSection`.** Read it: that component is a
product-integration status section (lifecycle pill, scope/status/tools/failures
stat tiles, deep-link into the store) for *first-party integrated products* on
an agent's integrations page. It is **extended, not reused wholesale and not
forked**: its stat-tile grammar and its `mcpConnectorLabel`/`lifecycleLabels`
patterns inform the app capability strip (§1), and its deep-link target
changes from `/mcp-app-store?catalogEntryId=…` to `/apps/:slug` so the
agent-side doorway lands on the new member surface. The future agent-config
"Apps" tab renders `AgentAccessList` directly beneath a slimmed
`AgentConnectorSection`-style header. One new list component, one amended
link helper, zero duplicated views.

---

## 5. Add custom MCP server

Entry point: a `+ Add custom app` secondary button at the top right of the
catalogue (part A owns placement) and an `EmptyState` action in search-no-
results ("Can't find it? Add any app by its server address."). It opens a
modal — `useModalA11y` + `useOverlayDismiss` on the standard scrim, panel
`max-w-md`, same shell as `InstallScopeDialog`.

**The minimal form — three elements only:**

```
┌──────────────────────────────────────────────────┐
│ Add a custom app                                 │
│ Connect any compatible app by its address.       │
│                                                  │
│ NAME (optional)                                  │
│ [ e.g. Acme Internal Tools            ]          │
│                                                  │
│ SERVER ADDRESS                                   │
│ [ https://…                               ]      │
│                                                  │
│ ▸ Advanced  (collapsed disclosure)               │
│                                                  │
│              [ Cancel ]  [ Connect ]             │
└──────────────────────────────────────────────────┘
```

Field labels reuse the `labelClass` / `inputClass` class strings from
`InstallScopeDialog` verbatim. Name is optional — if blank, the app's own
announced name is used after connect. The URL field accepts the address with
or without a path; placeholder `https://your-server.example.com/mcp`. Client
validation is exactly what `InstallScopeDialog.submit` already does: parse
with `new URL`, require `https:` (with `http:` permitted only for localhost
addresses — the existing `http: || https:` check, tightened in copy: "Use an
https:// address unless it's on your own machine").

**Advanced disclosure** (native `<details>`, summary in `text-sm
text-[color:var(--tx2)]`, chevron rotates with
`duration-[var(--duration-base)]`): custom headers (key/value rows), a manual
bearer token (password input, `autoComplete="new-password"`, the
CredentialsDialog plaintext-discipline: cleared from state before the
request, sent once, never read back), OAuth client id/secret overrides for
servers that can't do dynamic registration, and transport config
(streamable-HTTP vs SSE selection). Everything in Advanced is optional;
collapsing it must never lose entered values (state lives outside the
`<details>`).

**Progress feedback — a real step list, never a spinner alone.** On Connect,
the form swaps in place to the ConnectProgress panel (same component as §2,
larger), steps ticked as the probe pipeline reports them:

```
  Connecting to your server
  ✓ Reaching the server…
  ✓ Checking what sign-in it needs…
  ● Signing you in…            ← skipped silently for no-auth servers
  · Loading capabilities…
```

Current step pulses with `--executing-soft`; completed steps get
`--success-text` checks; the whole list is `text-sm`, steps in `tx3` until
active. Skipped steps (no auth needed) collapse out so the list always reads
as forward motion. On success the modal closes and the router navigates to
`/apps/:slug?connected=1`, where the connected hero renders.

**Failure states**, rendered in the same panel with the §2 error treatment:

- **Not an MCP server** (SERVER_INVALID / MCP_INITIALIZATION_FAILED): heading
  "That address doesn't answer as an app", body: "Check the address — it
  should be the app's connection link, not its website or docs page. If you
  got the link from the app's README, look for a URL ending in `/mcp`." Keep
  the entered URL editable (the form returns with values intact) — the most
  common cause is a wrong path, so correction must be one edit away.
- **Unreachable** (SERVER_UNREACHABLE): "We couldn't reach that server.
  Check the address and that the server is running, then try again. If it's
  on your company's private network, it may need to be reachable from
  Nessie — ask whoever runs it." Plus Technical details disclosure with the
  raw error.

Both keep the modal open; only success navigates away.

---

## 6. Trust, badges & the pre-connect warning

**Trust levels and treatment** (all are `StatusPill`-family chips, 11px,
uppercase tracking as in AgentDetailPage's meta line):

| Level | Meaning | Chip treatment | Icon |
|---|---|---|---|
| **Nessie** | First-party, built and reviewed by us | `bg-[var(--accent-soft)] text-[var(--accent-strong)]` | sparkle/shield |
| **Verified** | Third-party, reviewed and publisher-confirmed | `bg-[var(--success-soft)] text-[var(--success-text)]` | check-badge |
| **Community** | Published by a community member, unreviewed | `bg-[var(--warning-soft)] text-[var(--warning-text)]` | people |
| **Unknown** | Custom server added by URL; no provenance | `bg-[var(--overlay)] text-[var(--tx2)]` | question |
| **Blocked** | Disallowed by org policy or instance review | `bg-[var(--danger-soft)] text-[var(--danger-text)]` | slash |

**Placement.** On the card (part A): top-right of the card, inline with the
title row at <sm. In the detail hero: immediately after the provider line,
same chip at the same size — the hero's trust signal must match the card's so
the click-through never changes the story. Blocked apps render the card
disabled with the chip and cannot open a connect flow; the detail page shows
the reason in a `--danger` notice styled like CatalogDetailPanel's rejected/
locked notices (that `rounded-md border px-3 py-2 text-xs` notice pattern is
the house style for inline policy messages — reuse it verbatim, including for
the existing `locked` state, which maps to Blocked).

**Pre-connect warning for unreviewed community servers.** Shown when Connect
is clicked on a **Community** or **Unknown** app, *before* any network work:
a small interstitial modal (standard scrim, `max-w-md`, `useModalA11y`,
`useOverlayDismiss`), severity **warning**, not danger:

> **Review before connecting**
>
> **{name}** is published by the community and hasn't been reviewed by
> Nessie.
>
> Once connected, agents you allow can use everything this app offers —
> which may include reading or changing data in the connected account. Only
> connect apps from sources you trust, and start by giving access to one
> agent.
>
> ▸ Technical details — shows the server URL + publisher name
>
> [ Cancel ]  [ I understand — connect ]  ← primary, not danger

**It warns; it does not block.** Dismissing with the primary button proceeds
straight into the §2 flow. Honest without being alarmist: it states the real
consequence (agents can do what the app allows, on your account) and gives a
concrete safe behavior (start with one agent), instead of vague danger copy.
The warning shows **once per app per user** (remembered server-side on the
install record; a "Don't show for this app again" checkbox would train
click-through, so persistence is silent, not a checkbox). **Nessie** and
**Verified** apps never show it.

---

## 7. Component reuse map

| New piece | Reuse / extend | File path | Notes |
|---|---|---|---|
| Apps page header | **Reuse** `ResponsivePageHeader` | `admin/src/components/shared/ResponsivePageHeader.tsx` | Title "Apps", subtitle "Connect tools your agents can use", action slot holds `+ Add custom app`. Falls back to `AdminPageHeader` behavior at wide widths. |
| Catalogue filter bar | **Extend** existing Connectors-page filter row if present; otherwise new thin composition | `admin/src/components/features/mcp-app-store/` (page-level) | Category chips + trust filter; compose from `SegmentedControl` (categories) — no new visual language. |
| Search input | **New component — no existing equivalent** | `admin/src/components/features/apps/AppSearchInput.tsx` | No reusable search field exists in shared/. Styling from `inputClass` in `InstallScopeDialog` (lift that class string into a shared module — it's currently copy-pasted across three dialogs). Debounce via `useDebouncedValue`. |
| App card | **Extend** catalogue card from Part A | `admin/src/components/features/apps/AppCard.tsx` | Part A owns it; detail page and Part A must import the same file. |
| Card status chip | **Reuse** `StatusPill` | `admin/src/components/primitives/StatusPill.tsx` | Tones: success/connected, warning/needs-attention, danger/blocked, accent/featured. |
| Category section | **New component — trivial composition** | `admin/src/components/features/apps/AppCategorySection.tsx` | Heading `text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]` + grid of AppCard. Too thin to share an existing file. |
| Featured row | **Extend** `AppCard` with a `featured` variant | same as card | Wider tile, hero gradient from `--accent-soft` → `--panel`; no new tokens needed. |
| Detail hero | **New component — no existing equivalent** | `admin/src/components/features/apps/AppDetailHero.tsx` | Closest is AgentDetailPage's header block; apps need icon tile + trust badge + CTA + state pill, so compose from `StatusPill`, `ToolCategoryIcon`, `admin-button` classes rather than extracting the agent header. |
| Detail back-nav + not-found state | **Copy pattern verbatim** | `admin/src/pages/AgentDetailPage.tsx` (as source) | Same header grammar: `PhoneNavigationButton`, `faChevronLeft` secondary button, centered `tx3` loading/not-found line. |
| Tabs | **Reuse** `SegmentedControl` or the AgentDetailTabs inline-tab pattern | `admin/src/components/primitives/SegmentedControl.tsx`; `admin/src/components/features/agents/AgentDetailTabs.tsx` (pattern) | Prefer the AgentDetailTabs inline text-tab pattern for parity with agent detail; deep-link via `?tab=`. |
| Capability list | **Extend** existing tools list primitives | `ToolBadge`, `ToolCategoryIcon`, `ToolPermissionPill`, `ToolTransportPill` in `admin/src/components/shared/` | New grouping container `AppCapabilityList.tsx`; row internals are entirely existing badges/pills. Shared between `/apps` detail and (read-only) Connectors detail — one file, scope prop. |
| Capability count strip | **Extend pattern** from `AgentConnectorSection` stat tiles | `admin/src/components/features/integrations/AgentConnectorSection.tsx` (pattern) | Same tile classes; consider extracting the tile into `shared/StatTile.tsx` since this is the second use — that's the planned refactor, not a copy. |
| Accounts list | **Extend** `OverrideRow` row grammar | `admin/src/components/features/mcp-app-store/CredentialsDialog.tsx` (pattern) | New `AppAccountsList.tsx`; same row shell, identity via primitives `Avatar`. |
| Agent access checkbox list | **New component — no existing equivalent** | `admin/src/components/features/apps/AgentAccessList.tsx` | Rows: checkbox + `AgentAvatar` + summary slot (future per-tool expansion). Parameterised by app or agent scope — the single component for both doorways (rule 4). |
| Connect progress panel | **New component — no existing equivalent** | `admin/src/components/features/apps/ConnectProgress.tsx` | Step list with `--executing-soft` pulse + `--success-text` checks. Used by detail hero, custom-app modal, and reconnect. |
| Connect/warning/error dialogs | **Extend** dialog shell conventions | `InstallScopeDialog.tsx`, `CredentialsDialog.tsx` (patterns) | Same scrim + `admin-card` + `max-w-md` shell; every new dialog wires `useModalA11y` + `useOverlayDismiss` — the two existing dialogs predate the hooks and should be retrofitted in the same change (small, mechanical). |
| OAuth popup callback page | **New route — no existing equivalent** | `admin/src/pages/OAuthCallbackPage.tsx` | Themed interstitial ("You're connected…"), `window.close()` attempt. |
| Custom app modal | **Extend** `InstallScopeDialog` | `admin/src/components/features/mcp-app-store/InstallScopeDialog.tsx` | Reuse its form classes, URL validation, and secret-handling discipline. Strip scope picking (custom adds default to workspace scope per entitlement); Advanced disclosure replaces the exposed endpoint field. |
| Disconnect confirmation | **Extend** `dangerButton` + dialog shell | `CatalogDetailPanel.tsx` (`dangerButton` class string) | New `ConfirmDisconnectDialog.tsx`; if a generic confirm emerges from this + existing delete confirms, extract `shared/ConfirmDialog.tsx` — with two call sites the refactor rule is satisfied. |
| Empty states | **Reuse** `EmptyState` | `admin/src/components/shared/EmptyState.tsx` | Agents-with-access empty, search-no-results, category-empty, accounts-empty. |
| Skeletons | **New component — no existing equivalent** | `admin/src/components/features/apps/AppSkeletons.tsx` | No shared skeleton exists. Simple `--overlay-weak` pulse bars mirroring card/hero geometry; `animate-pulse` with `duration-[var(--duration-base)]` cadence. |
| Toasts / errors | **Inline panels, not toasts** | error notice pattern from `CatalogDetailPanel` / `InstallScopeDialog` | All §2 errors are inline `role="alert"` panels with `--danger`/`-soft`/`-border`/`-text` family. Transient success ("Capabilities refreshed") may use the app-shell toast if one exists; otherwise a self-dismissing inline `--success` notice. |
| Deep links from agent page | **Extend** link helpers | `mcpCatalogHref` / `mcpInstallHref` in `AgentConnectorSection.tsx` | Point at `/apps/:slug` for member journeys; owner journeys keep `/mcp-app-store`. |
| Viewport behavior | **Reuse** hooks | `admin/src/hooks/useViewport.ts`, `useDebouncedValue.ts` | Tab-row scroll, popup-vs-system-browser branch, search debounce. |
| Modal a11y + dismiss | **Reuse** hooks | `admin/src/components/shared/useModalA11y.ts`, `useOverlayDismiss.ts` | Non-negotiable on every dialog in this spec; retrofit to the two legacy mcp-app-store dialogs while touching them. |

**Token gaps to add to `admin/src/styles.css`:** effectively none for color —
the status families, overlays, scrims, accent, and executing/thinking tokens
cover every treatment specified. Two small additions are worth proposing:

1. A **`--focus-ring`** token (e.g. derived from `--accent` at low alpha) for
   consistent focus outlines on cards/tab rows; today focus styling is
   ad-hoc per component (`focus:border-[color:var(--accent)]` on inputs).
2. **Checkbox styling tokens** are not needed if the agent list uses native
   checkboxes with `accent-[var(--accent)]`; only add a custom checkbox
   component if design review rejects the native rendering.

No new radii, durations, or font tokens are introduced anywhere in this spec.

---

## 8. Open questions for the human

1. **Does `slug` come from the catalog entry (`entry.name`) or is it a new
   immutable field?** Deep links (`/apps/github`) must survive renames; if
   the slug is mutable we need redirects or id-based URLs (`/apps/:id`) with
   slug as decoration.
2. **Who sees `/apps` vs `/mcp-app-store` in nav?** Recommendation: members
   see only Apps; owners/admins see both (Connectors labelled "Connectors
   (admin)"). Confirm the nav and whether `/mcp-app-store` eventually becomes
   owner-only.
3. **Is "Connect another account" available to members, or owner-gated?** The
   backend scope rules (owners manage all install scopes, members user scope)
   suggest members' extra accounts are user-scoped — confirm the UI should
   label that ("Only you can use this account") on member-added rows.
4. **Per-account agent access, or per-app?** §4 architects per-account
   (account selector scoping the agent list). Confirm that matches the grant
   model, or simplify to per-app with all accounts implied.
5. **Popup completion detection:** poll-on-focus is specified for simplicity
   and cross-process safety. If we want sub-second flip-to-connected, is a
   `BroadcastChannel`/`postMessage` fast-path (with polling as fallback)
   acceptable, or is polling-only the deliberate choice?
6. **Trust level provenance:** does the backend already carry a
   verified/reviewed flag per catalog entry, or is the review-queue `status:
   published` the only signal? The five-level badge model needs at minimum a
   `trust` enum; mapping `pending_approval`/`published` onto it needs API
   confirmation.
7. **Custom servers from members:** may a member add a custom server
   (user-scope) at all, or is `+ Add custom app` owner/admin-only? The locked
   / install-time gate precedent suggests an org-level policy toggle — confirm
   default.
8. **"Don't show the community warning again"** — specified as silent
   per-app-per-user persistence. Confirm that's the desired product behavior
   vs. showing it on every connect (safer, more annoying).
