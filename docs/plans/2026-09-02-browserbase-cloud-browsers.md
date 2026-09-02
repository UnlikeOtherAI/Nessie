# Browserbase cloud browsers for agents

**Date:** 2026-09-02 (rev 2) · **Status:** proposal (not yet built)

Each agent gets **its own browser** that survives the run: a cloud Chromium
"machine" from [Browserbase](https://www.browserbase.com) the agent can open,
navigate, and act in — one durable browser per agent, so agents never clash
over shared state, and the login state (cookies, localStorage) is retained
per agent, so it can come back tomorrow still signed in.

Two decisions shape everything else (decided 2026-09-02):

1. **Nessie never holds a person's service credentials.** There is no
   server-side password vault, and no automated credential injection either —
   like every "here's a browser" product, signing in is the person's act.
   What persists is the *session* (Browserbase Contexts: cookies,
   localStorage — encrypted at rest on Browserbase's side, referenced from
   Nessie only by an opaque context id). Because the browser itself is
   cloud-side, that logged-in state is inherently portable: the person can
   sign in from their Mac today and the agent reuses the same session from a
   run kicked off on their phone tomorrow, with no browser process alive in
   between. Device-keychain credential injection was considered and
   deliberately dropped — re-login via the live view when a session expires
   is acceptable, and it keeps our credential exposure at zero.
2. **Two ways to connect, both bring-your-own Browserbase account.** An
   organisation subscription (owner connects the company account; every
   browser-granted agent can spin browsers for anyone) and a personal
   connection (an individual connects their own account — the free tier is
   enough to try it — powering only their own runs). No Ledger metering:
   the Browserbase bill is between the account holder and Browserbase.
3. **The browser belongs to the agent; the logins in it belong to people**
   (decided 2026-09-02, the Grok-bot model). Each agent has one durable
   browser — its own machine — which is what makes clashes structurally
   impossible: no two agents ever share browser state. Because Nessie is
   multi-user where Grok is not, a login into a shared agent's browser is
   **shared with everyone who can reach that agent** — said out loud by a
   banner in the browser viewer before the first keystroke, recorded
   per-person for audit and revocation, and enforced by stamping the
   agent's audience as the disclosure basis of everything read through the
   browser (§4.5).

## 1. What exists today — and why this is a transport, not a new tool family

Nessie already has agent browsing, running on the person's device:

- The **executor daemon** (`executor/`) implements `browser.open`,
  `browser.observe`, `browser.act` in a local sandboxed browser, plus
  `browser.connected.*` against the user's real Chrome via a
  native-messaging bridge (`executor/chrome-extension/`). The connected
  variants are implemented but deliberately not advertised by the control
  plane yet — they need the run proven private and an owner-only disclosure
  basis attached (`packages/schemas/src/executor.ts`, comment above those
  keys).
- Logical tool descriptors and their human labels live in
  `packages/executor-manage/src/executor-logical-tools.ts`; registry rows
  carry `transportConfig = { transport: 'executor', operationKey }`.
- Toolset assembly (`worker/src/run/executor-toolset.ts`
  `buildExecutorToolset`) emits descriptors only for live `ExecutorBinding`
  bundles and dispatches through encrypted `ExecutorCommand` rows the device
  long-polls.

Rule zero's fourth check applies directly: a `browserbase_*` tool family
beside `executor.browser.*` would be the eighth look-alike. **Browserbase is a
second transport behind the same logical browser surface.** The model sees one
set of browser tools; whether a call runs on the person's Mac or in a
Browserbase cloud session is a server-side transport decision, exactly as
`transportConfig` already frames it:

| | Device executor (exists) | Connected Chrome (exists, gated) | Browserbase cloud (this plan) |
|---|---|---|---|
| Availability | device online | device online + Chrome | always (org connected) |
| Login state | sandbox profile | the person's real sessions | the agent's own persistent Context |
| Credentials | n/a | user's own password manager | human signs in via Live View — never stored, never injected |
| Best for | local/dev work | acting as the person, attended | unattended + long-lived agent browsing |

What Browserbase adds that neither existing transport can do: a browser that
exists when the person's laptop is closed, with a durable per-service login
state an agent can reuse across runs and triggers.

## 2. Browserbase facts the design leans on

Verified against docs.browserbase.com on 2026-09-02:

- **Sessions**: created via API, driven over CDP (Playwright/CDP connect URL).
- **Contexts**: persistent browser user-data (cookies, localStorage,
  IndexedDB…, not HTTP cache), created via `POST /contexts`, attached at
  session create via `browserSettings.context.id` with `persist: true|false`.
  Encrypted at rest. **Do not run two sessions on one context concurrently**
  (sites force logouts) — Nessie must lock a context to one live session.
- **Live View**: `sessions.debug(sessionId)` returns an embeddable URL; a
  human in the iframe can click and type in real time (interactive), or the
  iframe is styled `pointer-events: none` for watch-only. This is the login
  handoff mechanism.
- **Pricing** (2026-09): Free 1 browser-hour (3 concurrent, ~15-min session
  cap, 7-day data retention) / Developer $20 → 100 h, $0.12/h over /
  Startup $99 → 500 h, $0.10/h over / Scale custom. Concurrency caps per plan
  (3 / 25 / 100 / 250+). Browser-hours are the metered unit, so sessions must
  be closed aggressively and their duration recorded. The free tier is the
  intended personal on-ramp — try it, upgrade when it bites; the connect UI
  copy should say so. Verified 2026-09-02: **contexts are exempt from the
  retention windows** — the docs state contexts "live indefinitely" until
  explicitly deleted (retention covers session artifacts like recordings and
  logs), so a free account's agent-browser logins do not expire on Browserbase's
  side; re-login cadence is set by each website's own session policy. The
  free plan's real bound is hours (1 h total, ~15-min sessions), which is
  the number the personal connections panel surfaces as the upgrade nudge.

## 3. Design principles

1. **One browser surface.** Shared logical tools, transport decided at
   toolset assembly. No `browserbase_*` names, no second schema set.
2. **Sessions, not passwords.** Nessie persists a context *id*; the cookies
   live encrypted at Browserbase; the password lives nowhere on our side.
   There is deliberately **no server-side credential vault** — that was
   considered and rejected as too dangerous for us to hold.
3. **Login is a human act.** First sign-in (and any re-auth, CAPTCHA, or 2FA
   challenge) is the person typing into the interactive Live View. The agent
   parks, the person acts, the agent resumes. We never automate CAPTCHA
   solving or type credentials on the model's behalf from server state.
4. **A browser belongs to an agent; its logins are shared with the agent's
   audience.** A Browserbase Context maps to one agent — its durable
   machine, one live session at a time, so runs never fight over shared
   state. Signing in is sharing with whoever can reach the agent — warned
   by the viewer banner, recorded per-person for audit and revocation
   (§4.5, §4.9).
5. **Reads feed the disclosure sink.** A page read through a
   human-authenticated browser enters the run context with the agent's
   `agent:<id>` audience basis (`ConsumedSourceSink`), same obligation as
   every other read path — a private agent's audience is its owner alone.
6. **Default OFF.** Browser tools are `requiresExplicitGrant` per agent, the
   DeepWater discipline: absent/inherited policy does not expose them.

## 4. Architecture

### 4.1 Connection — two tiers, both bring-your-own account

- New shared package `packages/browser-cloud/` (`@nessie/browser-cloud`):
  Browserbase REST client, session/context lifecycle, live-view URL minting.
  Shared by API routes and worker, the `@nessie/mcp-manage` /
  `@nessie/workspace-admin` pattern.
- `CloudBrowserConnection` `{ id, organizationId, scope:
  'organization'|'user', userId?, projectId, apiKeyRef, status, health
  fields }`, with partial unique indexes: one org-scoped row per
  organization, one user-scoped row per `(organizationId, userId)`, and a
  CHECK tying `userId` to the scope. The API key is submitted once and
  stored through the existing encrypted secret store (`createPgSecretStore`,
  a server-minted `secret_browserbase_` ref) — never returned, never
  caller-chosen, exactly like MCP instance secrets
  (`packages/mcp-manage/src/instance-secret.ts` discipline).
- **Org connection** (owner-only): the company subscription. Every
  browser-granted agent in the organisation can spin browsers, for any
  requester, attended or not (within §4.5's authenticated-browsing rules).
- **Personal connection** (any member): their own Browserbase account —
  free tier to start, upgrade if they turn out to be a power user. It powers
  **only runs that person requested**, the user-scoped MCP install
  discipline (user-scope installs surface only in the installing user's
  runs). Resolution at toolset assembly: the org connection when one is
  healthy, else the requester's personal connection, else no cloud browser
  toolset. One connection per run — never mixed mid-run.
- Verified 2026-09-02: Browserbase authenticates by **API key only**
  (`x-bb-api-key`, per project) — there is no OAuth flow a third party
  could use, so personal-vs-company cannot be inferred from the auth
  mechanism. Both tiers paste a key; the scope is decided by **which
  surface accepted it** (a member's own `/settings/connections` → user
  scope; the owner-only org settings → organization scope), never by the
  key's shape.
- Enable (either scope) is a probe-then-persist: create + immediately
  release a throwaway session; failure refuses the connect loudly
  (`BROWSERBASE_UNREACHABLE`, `BROWSERBASE_AUTH_FAILED`) rather than
  persisting a dead connection — the DeepWater enable precedent.

### 4.1a The `/apps` doorway — a first-party listing, the deep-water way

Verified 2026-09-02: the repo has no Browserbase integration, and the
official MCP registry carries Browserbase only as **Smithery-proxied**
remotes (`server.smithery.ai/...`, authenticated by a *Smithery* bearer) —
ingested rows are `community` trust by rule and route through the wrong
vendor. So the store surface is a **first-party listing added to
`api/src/db/seed-apps.ts`** beside `deep-water`/`deepsignal`
(`trustLevel: 'nessie'`, integration-owned, immune to generic catalog
mutation). Its Connect button routes to the cloud-browser connect flow of
§4.1 — org scope for owners, personal scope for members, mirroring how the
generic store already scopes installs — **not** to the generic
`createInstance → probe → startOAuth` machinery, because the capability is a
builtin transport, not projected MCP tools. The listing is the doorway; the
homes stay `/settings/organization` and `/settings/connections` (§4.7).
- **Egress**: all REST calls go through `@nessie/runtime` `safeFetch`. The
  CDP connect is a WebSocket to a Browserbase-issued `wss://` URL — `safeFetch`
  doesn't cover WS, so the connect URL is accepted only when its host matches
  the Browserbase origin allowlist and its IPs pass the same pin-and-recheck
  the SSE MCP transports use. No model- or caller-supplied URL ever reaches
  the CDP dial.
- Deployment fallback `NESSIE_BROWSERBASE_API_KEY`/`_PROJECT_ID` for
  single-org self-hosts, resolved once at startup like other env config; an
  org row always wins.

### 4.2 Data model

- `CloudBrowserConnection` — above.
- `AgentBrowser` `{ id, organizationId, agentId, connectionId,
  browserbaseContextId, status, createdAt, lastUsedAt }` — **one durable
  browser per agent per connection**, created lazily on the agent's first
  persistent `browser_open`. `connectionId` is load-bearing: a Browserbase
  context is scoped to the account that created it, so a browser is usable
  only through its own connection. If an org subscription arrives after
  personal connections were in use, personal-connection browsers cannot be
  transferred — the agent starts a fresh browser under the org connection
  and any logins are performed once more (the UI says so; it is one login
  per service, not a migration). Deleting the agent deletes its browser
  (context included) in the same transaction.
- **Which connection may hold an agent's durable browser** follows from who
  can reach the agent: a **workspace agent's** browser lives on the org
  connection only — on a personal connection its state would be reachable
  through runs the connection owner never requested. A **private agent**
  (owner-only home DM, owner-only runs by construction) may keep its
  durable browser on its owner's personal connection — which is exactly the
  free-tier on-ramp: your own private agent, your own Browserbase account.
  Ephemeral sessions work on either connection per §4.1's resolution.
- `AgentBrowserLogin` `{ id, agentBrowserId, userId, serviceHint,
  createdAt }` — one row per completed login handoff (§4.4), recording
  **who** signed the browser into **what**. `serviceHint` is display
  metadata ("Google — ondrej@…") confirmed by the person at handoff, never
  parsed out of page content. Any login row flips the browser to
  human-authenticated for §4.5's basis and feeds the sign-out surface
  (§4.7); "Sign out & reset" deletes the context, recreates the browser
  empty, and clears the login rows.
- **Publishing a private agent must confront its browser.** Verified
  2026-09-02: private → workspace publishing does not exist yet
  (`UpdateAgentBodySchema` carries no `visibility` field — only create
  accepts one; ownership transfer is likewise refused for private agents) —
  it is in the pipeline. This plan places an obligation on that future
  transition: because the `agent:<id>` audience is live-resolved, publishing
  instantly widens who can reach the browser and everything read through it,
  so the publish flow must list the browser's signed-in services and ask
  **"Reset the browser and purge its logins?"** — purge is the default;
  keeping them requires an explicit confirm that names each service being
  handed to the wider audience. Past browsing-derived messages stay bounded
  by the owner-only home DM they live in. The §4.9 shared-browser banner
  starts rendering the moment the agent is workspace-visible.
- `CloudBrowserSession` `{ id, organizationId, runId, agentBrowserId?,
  browserbaseSessionId, status (active|released|expired), startedAt, endedAt,
  releasedBy }` — the lifecycle row. **One live session per agent browser**:
  a persistent open is claimed with a conditional UPDATE (`status = 'active'`
  unique partial index per `agentBrowserId`), because one agent can run
  concurrently in different threads and Browserbase warns against two
  sessions on one context. The loser gets a clear "this agent's browser is
  in use by another run" tool error and can proceed ephemeral or retry.
  Different agents never contend at all — that is the point of
  browser-per-agent.
- **Release is fused to the run's terminal transition**, the working-marker
  precedent (`lifecycle.ts` `updateRunStatus`): completion, failure, budget
  stop, and cancellation all release the Browserbase session without anyone
  remembering to; a sweep beside `sweepExpiredApprovals` reaps sessions whose
  run crashed before the transition. Browser-hours are money — nothing may
  leak an open session.

### 4.3 Toolset assembly and dispatch

- `worker/src/run/browser-cloud-toolset.ts` `buildCloudBrowserToolset(...)`,
  the structural twin of `buildExecutorToolset`: emits the shared logical
  browser descriptors with `transportConfig = { transport: 'browserbase' }`
  when (a) a connection resolves for this run per §4.1 (org, else the
  requesting user's personal one), (b) the agent's policy explicitly
  grants the browser bundle, and (c) no live executor binding already claims
  the browser bundle for this run — an executor-bound run keeps the device
  transport, so the model still sees exactly one browser toolset.
- Same seam in `run-setup.ts` / `agent-loop.ts` (`handledNames` checked before
  the builtin/MCP path). Tool results pass the normal middle-out truncation
  chokepoint; screenshots go through `FileService` as attachments and ride the
  existing images-in-context path (`worker/src/run/message-attachments.ts`),
  never a second byte path.
- Model-facing tools (shared schemas, both transports):
  - `browser_open` `{ mode: 'mine' | 'ephemeral' }` — `'mine'` opens **the
    agent's own browser** (its `AgentBrowser` context attached,
    `persist: true`, created lazily on first use, subject to the §4.2
    single-session claim and connection rules); `'ephemeral'` opens a
    throwaway session with no context. No id to pass, so nothing to invent:
    the structural prompt block states whether the agent's browser exists,
    which services are signed in (`serviceHint`s), and whether it is
    currently in use — toolset facts only, never message content.
  - `browser_goto`, `browser_act`, `browser_observe`, `browser_screenshot`,
    `browser_close`; from phase 2, `browser_download` (the session's
    downloaded file lands through `FileService` and attaches to the reply —
    §6.8).
  - `browser_login_request` `{ service, reason }` — the handoff (§4.4) into
    the agent's own browser. Cloud transport only.
- If `browser_act` gains a natural-language action layer (Stagehand-style),
  its judging model routes through Nessie's own inference chokepoint
  (`NESSIE_UTILITY_MODEL` via the org provider), never a second LLM key baked
  into the browser layer.

### 4.4 Login handoff — the person types, the agent waits

When the agent hits a login wall in its own browser (or needs a service
signed in for the first time):

1. `browser_login_request` posts an **agent card** (`card_post` machinery, one
   card system) addressed to the requesting user only, with the reason and a
   single action: *Open browser*. The run exits through `pendingInput` and
   parks in `waiting_input` — the card/approval suspend-resume cores
   (`run-suspend.ts` / `run-resume-core.ts`), never a second copy.
2. Pressing the card opens the **screen viewer (§4.9) full-screen, in
   control mode** — the interactive Live View iframe. The live-view URL is
   fetched per-open from a viewer-authorized API route (`GET
   /api/browser-sessions/:id`, requester-only) — the URL itself is never
   written into a message, card row, or realtime payload.
3. The person signs in, completes 2FA, solves any CAPTCHA — keystrokes go
   browser → Browserbase. Nessie relays nothing; the model sees nothing.
   **While the dialog is open in interactive mode, `browser_observe` /
   `browser_screenshot` for that session are refused** ("a person is at the
   controls"), so the model cannot watch credentials being entered.
4. The person presses *Done* on the card, confirming the service label. The
   press is the ordinary `agentCardResponse` user turn; the run resumes;
   cookies are now in the agent's context (`persist: true`), and an
   `AgentBrowserLogin` row is written in the press transaction recording
   **this user** signed **this service** into **this agent's browser** —
   audit and revocation surface. Consent is handled by the §4.9 banner, not
   a per-login declaration: on a workspace agent, signing in *is* sharing
   with everyone who can reach the agent, and the viewer says so before the
   first keystroke.
5. Card expiry (agent-set, swept with the approval sweep) releases the parked
   session so an abandoned login doesn't burn browser-hours.

Watching without controlling is the same viewer in watch mode — the screen
panel of §4.9, with the existing cancel-run control beside it (the
document-stream dialog precedent).

### 4.5 Disclosure and unattended use

- **Logins are shared with the agent's audience — warned, not partitioned**
  (decided 2026-09-02). A human-authenticated agent browser registers the
  existing `agent:<agentId>` basis scope in `ConsumedSourceSink` at open —
  the vocabulary already defines it as *exactly the people who pass the
  shared live agent-visibility predicate*, which is precisely "the users
  who have access to the agent". So material read through a workspace
  agent's browser is readable by whoever can reach that agent, and on a
  private agent the same scope resolves to its owner alone — one uniform
  rule, no per-login declaration. The consent mechanism is the §4.9
  banner: a person who signs a service into a shared agent's browser does
  it knowing it is shared. The card and banner copy still steer:
  **personal accounts belong in your private agent's browser**; a
  workspace agent's browser is for service accounts the agent's audience
  may share. An agent browser with no recorded logins, and every ephemeral
  session, browses the public web like `web_fetch` and adds no basis.
- Web pages are untrusted content; nothing on a page is an instruction. The
  existing prompt-side framing for fetched content applies to `browser_observe`
  output verbatim.
- **Unattended runs (triggers/schedules) get no human-authenticated
  browsing in v1**: an agent browser carrying any `AgentBrowserLogin` is
  refused on unattended runs. An interval sweep silently acting inside a
  person's Google account is a different consent than "help me now"; that
  use arrives later as an explicit per-login, per-trigger opt-in. An agent
  browser with no recorded logins, and ephemeral sessions, are fine
  unattended — **on the org connection only**: a personal connection powers
  only runs its owner requested, and an unattended run has no requester, so
  it never spends an individual's browser-hours.

### 4.6 Credentials — decided: no injection, ever

Decision (2026-09-02): **there is no credential storage or automated
credential entry in this integration, in any phase.** The precedent is every
"here's a browser" agent product — you get a browser; when a session expires
you sign in again, in the browser, yourself. What matters is not avoiding
the login, it's that once the person *is* logged in, the session outlives
the browser process and follows them across devices — which Contexts give us
for free, because the browser and its state are cloud-side and any of the
person's devices can open the same live view and any run can attach the same
context.

**Session restore is server-side and involves no client storage.** Restarting
the browser is the worker attaching the stored context id at session create
(`browserSettings.context.id`) — Browserbase re-materializes the cookies/
localStorage itself. Nothing is ever read from or written to the person's
device, iCloud, or browser, which is why the web client has full parity with
desktop and mobile: every client only ever renders the Live View iframe and
the login card. The only thing no storage scheme can survive is the *site*
invalidating the session (forced re-auth, password change) — that is a
one-more-login via the §4.4 card, from any device.

Recorded for the future so it isn't re-litigated: a device-keychain
injection scheme (executor types a credential from the user's own
iCloud-Keychain-synced item into the session over CDP) was designed and
dropped. Also noted: no OS exposes the user's *existing* Safari/Chrome
passwords to third-party apps, so "pull their Google password from iCloud"
was never buildable — only Nessie-authored keychain items would have been.

The complementary track that does involve the person's real credentials —
the existing, unadvertised `browser.connected.*` executor operations (their
actual Chrome, their password manager, their live sessions) — proceeds on
its own disclosure preconditions, independent of this plan. Connected Chrome
covers attended "act as me on my machine"; Browserbase covers unattended and
cloud-persistent.

### 4.7 Surfaces (Rule zero)

- **Home — org**: `/settings/organization` → "Cloud browsers" (owner-only):
  connect/replace the company key (write-only), health, plan/concurrency
  note, disable.
- **Home — agent**: the agent's detail surface (Agent Designer) gains a
  **Browser** panel — whether its browser exists, which connection it lives
  on, the signed-in services with who signed each in
  (`AgentBrowserLogin`), last used, and **Sign out & reset** (deletes the
  context, recreates the browser empty, clears the login rows).
- **Home — person**: `/settings/connections` gains a "Browser" section with
  the **personal connection** (connect your own Browserbase account — free
  tier to start — replace key, disconnect) and **Your browser logins**: every
  `AgentBrowserLogin` this person performed, across agents, each with the
  agent, service, and a per-login path to the agent's reset — so revoking
  "I signed that agent into my Google" never requires hunting through
  agents.
- **Doorways**: the first-party `/apps` listing (§4.1a) whose Connect routes
  here by scope; the Agent Designer's existing explicit-grant switch
  surfaces the browser bundle; the login card and the §4.9 screen panel live
  in chat where the question arises; `/ops/usage` gains browser-hours per
  org/agent/connection-scope from `CloudBrowserSession` durations
  (owner-only, no currency figures to members, per the budget-copy rule).
  A member on a personal connection sees their **own** hours in the
  connections section — it is their bill, and that number names the
  "should I upgrade" decision.

### 4.8 Budgets and limits

- Session wall-clock counts against the run's existing time budget; a session
  also carries its own hard TTL (default ~10 min, agent-extendable to a
  deployment cap) independent of the run, so a hung CDP connection cannot run
  a browser for 45 minutes.
- Concurrency: org-level cap (`NESSIE_BROWSER_CLOUD_MAX_CONCURRENT`, default
  well under the Browserbase plan cap) enforced at session create with a
  clear tool error, so one agent fan-out cannot exhaust the org's plan.
- Every session writes a connector-usage-style event (duration, run, agent,
  requesting user) for `/ops/usage`; no cost fields — the org's Browserbase
  bill is Browserbase's, and we don't mirror commercial state.

### 4.9 Displaying the browser — the screen panel

The person watches the agent's browser the way they read a reply thread: a
right-hand panel beside the conversation, going full-screen on tap. (The
reference gesture is Grok's "Assistant's screen" — thumbnail in the rail,
tap → full-screen desktop. Grok shows Chrome + a filesystem + a terminal;
Nessie's screen shows **only the browser**, deliberately — command/coding
surfaces belong to the executor's own UI, not this panel.)

- **One viewer component, two containers.** `AgentScreenViewer` = the
  live-view iframe + our tab strip + a status row (agent name, run state,
  cancel). It mounts in (a) the **screen panel** — the same right-hand shell
  as the reply-thread panel: pushes ≥1280px, overlay 900–1279px, full-screen
  <900px, drag-resized width persisted. That shell is currently implemented
  *inside* the thread panel, so this work extracts it into a shared layout
  primitive both panels mount — never a second copy of the breakpoint/resize
  behaviour (Rule zero #4). And (b) a **full-screen takeover** on tap, which
  is the only container where control mode exists. The §4.4 login handoff
  opens this same viewer full-screen in control mode — there is exactly one
  browser viewer in the admin, parameterised by container and mode.
- **Tabs are our strip, not Chrome's.** The live view renders only the page
  viewport; `sessions.debug().pages[]` exposes one live-view URL per tab
  (verified 2026-09-02), and Browserbase reports no "active tab" — but the
  **worker** owns the CDP connection, so it knows both the tab list and
  which page the agent is acting on, and publishes them as ephemeral SSE
  events beside the existing `stream.*` lanes (`stream.browser.tabs`: page
  id, title, origin, agent-active flag; `pg_notify`-only, never durable —
  the `stream.delta` write-amplification lesson). The client renders the
  strip with `TabBar` (`role="tablist"` — the one tab bar, per the design
  system). Picking a tab is a **local view choice**; "follow the agent" is
  the default and re-engages when the agent switches tabs. Only tab
  *metadata* crosses Nessie's wire — pixels always come straight from
  Browserbase's iframe, so page content never transits our servers.
- **Discovery and bootstrap** follow the document-stream route pattern:
  `browser.session.started` / `.ended` ephemeral events on the thread
  stream, `GET /api/threads/:id/browser-sessions?active=1` for late-join
  bootstrap, `GET /api/browser-sessions/:id` for detail + the live-view URL
  (minted per-open, never persisted). Every per-session route re-checks
  `threadId` **and** `organizationId` — session ids are global, the thread
  gate alone would leak across orgs (the document-stream rule verbatim).
- **Doorways** (Rule zero #1): (1) a live **thumbnail** in the conversation
  info drawer — "Agent's screen", the scaled watch-only iframe
  (`pointer-events: none`, CSS-scaled), the Grok right-rail analog; (2) a
  chip on the **thinking bubble** while the run is browsing ("browsing —
  watch"), since the bubble is already where "what is it doing" gets asked;
  (3) a deep-linkable route,
  `/channels/:id/threads/:threadId/browser/:sessionId`, the reply-panel URL
  discipline. All three open the panel; the panel's expand control (and any
  tap under 900px) goes full-screen.
- **Watch vs control — and control is a claimed semaphore.** The thumbnail
  and the panel are watch-only (`pointer-events: none`). Full-screen shows
  **Take control**, and because a shared agent's session can render to many
  entitled viewers at once, control is serialized exactly like every other
  one-winner transition in the codebase: `CloudBrowserSession` carries
  `controlledByUserId` + `controlClaimedAt`, claimed by a conditional UPDATE
  (`controlledByUserId IS NULL` in the WHERE), so two simultaneous presses
  have one winner. While claimed: the claimant's iframe is interactive,
  every other viewer stays watch-only and sees "«name» is at the controls",
  and `browser_observe`/`browser_screenshot` are suppressed for the session
  (§4.4) — the agent, the claimant, and other viewers can never drive at
  once. Release is explicit ("Hand back", which lifts the suppression and
  resumes the agent) and also structural: session end releases it, and the
  claim expires after a short keepalive timeout so a closed laptop lid never
  holds a team's browser hostage. Eligibility to claim at all: the run's
  requester always, and any viewer the session's basis already admits (for
  a workspace agent, its audience). The login handoff card opens straight
  into the claimed state for the pressing user.
- **The shared-browser banner.** On a workspace agent's browser, the viewer
  renders a dismissible notice pinned above the iframe: *"Other people can
  use this agent's browser. Anything you sign in to here is shared with
  everyone who has access to this agent."* Dismissal persists per (user,
  agent) — but the banner **always returns, undismissed, in login-handoff
  control mode**, because that is the moment the sentence is load-bearing.
  Private agents' browsers render no banner; there is nobody else. This is
  the consent half of §4.5's warn-not-partition decision.
- **Who may watch is the session's disclosure basis, reused.** A session on
  a human-authenticated agent browser renders only for viewers who satisfy
  its `agent:<id>` scope (the agent's audience; a private agent's owner
  alone); an unauthenticated or ephemeral session renders for anyone who
  can see the thread — the same predicate the reply messages answer to, and
  an unauthorized session is shaped exactly like an absent one (the
  indistinguishable-404 discipline).
- **One right panel at a time**: opening the screen panel closes the reply
  panel and vice versa (v1) — two stacked right panels is the nested-frame
  shape the content system forbids.

## 5. Phasing

**Phase 1 — connect (both tiers) + ephemeral cloud browsing.**
`@nessie/browser-cloud`, `CloudBrowserConnection` at both scopes +
secret-store keys, probe on connect, the first-party `/apps` listing in
`seed-apps.ts` (§4.1a), org + personal settings surfaces,
`CloudBrowserSession` lifecycle fused to run terminal + reaper sweep,
`buildCloudBrowserToolset` behind `requiresExplicitGrant` with the §4.1
resolution order, shared logical tools
(`browser_open/goto/act/observe/screenshot/close`, ephemeral only),
screenshots via FileService, and the §4.9 display in watch-only form: the
shared right-panel shell extracted from the thread panel, the screen panel +
full-screen takeover, the tab strip fed by `stream.browser.tabs`, the info-
drawer thumbnail, the thinking-bubble chip, the deep-link route, cancel-run,
plus ops usage rows + the member's own-hours readout. *Done when:* a member on a free
personal account can grant an agent the browser and ask "check what this
page says", watch it happen, and see their hours — and an owner connecting
the company account flips every browser-granted agent to it without anyone
reconfiguring.

**Phase 2 — agent browsers + login handoff.**
`AgentBrowser` + `AgentBrowserLogin`, context create/attach
(`persist: true`), single-session claim per agent browser + the connection
rules (workspace agents on org connection only; private agents may use their
owner's personal one), `browser_open` `mode: 'mine'`, `browser_login_request`
card + `waiting_input` park + the §4.9 viewer's control mode (Take control /
Hand back, observe-suppression during takeover), structural prompt block
stating browser existence + signed-in services, the `agent:<id>` audience
disclosure basis + the shared-browser banner, the Agent Designer Browser
panel + the person's
browser-logins list, unattended-run refusal for authenticated browsers.
Phase 2 also ships the two decided hardenings: the **cross-origin write
gate** (§6.1 — approval-gated `browser_act` writes on foreign origins once
an authenticated origin was touched, opt-in per-browser domain pinning for
owners) and **`browser_download`** through `FileService` (§6.8).
*Done when:* a person signs a service into an agent's browser once in chat,
tomorrow's run reuses that login without asking, a concurrent run of the
same agent gets a clean "browser busy" instead of a corrupted session — and
Sign out & reset provably signs the agent out.

**Phase 3 — unattended logins + polish.**
Per-login per-trigger opt-in for scheduled runs (org connection only),
proxy/geo options, Stagehand-style `browser_act` if observe/act proves too
low-level. Separately tracked, not this plan: the disclosure preconditions
that let `browser.connected.*` be advertised.

## 6. Known risks — named, with owners in the phasing

1. **Injection → exfiltration through the browser itself.** A hostile page
   can steer the agent to read the signed-in tab and type what it finds
   into an attacker's form — leaving via Browserbase's egress, so the
   disclosure basis never fires. **Decided 2026-09-02 — mitigate
   structurally without narrowing what the agent can read**, because
   killing the open web kills the capability. Reads stay unrestricted. The
   gate sits on **cross-origin writes**: once a run's session has touched
   an authenticated origin, a `browser_act` that enters text or submits on
   any *other* origin requires a one-tap approval through the existing
   approval machinery. Origins are structural facts — no content judgment;
   same-origin writes (doing the task on the signed-in service) stay free,
   and unauthenticated/ephemeral sessions are entirely ungated, so the
   common cases feel nothing. Owners *may* additionally pin a browser to a
   domain allowlist — opt-in hardening, never the default. Residual risk
   accepted and named, not solved: same-origin exfiltration (a webmail
   draft to an attacker) and data smuggled through navigation URLs; the
   opt-in pinning closes the second for browsers that want it. Phase 1
   (ephemeral-only) carries ordinary `web_fetch`-grade exposure.
2. **The Browserbase dashboard bypasses disclosure.** Whoever holds the
   Browserbase account can replay every session in Browserbase's own UI —
   including a private agent's browsing on the org connection, and possibly
   login handoffs. Phase 1: verify whether recordings can be disabled per
   session and whether replays mask password fields; the connect UI states
   the fact either way. Private agents on personal connections avoid the
   org-admin case by construction.
3. **Live-view URL semantics are unverified.** If `debuggerFullscreenUrl`
   is a long-lived bearer link, a leaked URL sidesteps viewer authorization
   and the control semaphore. Phase 1 verifies expiry/auth empirically;
   until then it is minted per-open, never persisted, never logged.
4. **Anti-bot lockouts hit the person's real account.** Handoff copy warns;
   and a structural steering block (toolset facts only, the research-routing
   precedent) points agents at first-party connectors where one exists —
   the browser is for services without a connector.
5. **CAPTCHA policy vs platform default.** Paid Browserbase plans enable
   auto captcha solving; our stance is human-solves-via-Live-View. Phase 1:
   pass the session setting that disables it if the API offers one, else
   amend §3.3's claim to match reality.
6. **Handoff burn + free-tier session cap.** `waiting_input` keeps the
   session alive: default card expiry ~15 min, and the handoff UI must
   detect a platform-killed session (free tier caps at ~15 min) and offer a
   clean retry instead of a dead iframe.
7. **One browser per agent is a throughput ceiling** — deliberate: a busy
   team agent serializes authenticated browsing; ephemeral absorbs public
   work. If it bites, the escape hatch is multiple browsers per agent,
   never loosening the single-session claim.
8. **Downloads are committed, uploads deferred.** `browser_download` is a
   phase-2 tool (decided 2026-09-02): the session's downloaded file lands
   through the one `FileService` chokepoint — accounted, quota-gated,
   thumbnailed like any upload — and attaches to the reply. Uploads (a
   file *into* a web form) stay a later phase. No improvised second byte
   path either way.
9. **Data residency — resolved as informed consent** (2026-09-02). Cookies
   for corporate services live in Browserbase's cloud; connecting is the
   org's (or the member's) own explicit decision, and the connect UI says
   plainly where session state lives. No product mitigation needed; the
   transport abstraction remains the hedge for orgs that want browsers on
   their own infrastructure later.

## 7. Open questions

1. **Same-origin sensitive actions — decided 2026-09-02: no gate.** If a
   person asks the agent to submit an order on a site, it submits the
   order; the ask is the consent, and the requester is one tap from
   watching the screen live. Cross-origin writes keep their §6.1 gate —
   that one exists for the page's instructions, not the person's.
2. **Mobile companion.** The login handoff dialog should work from the mobile
   app's webview (it's an iframe + card press); worth verifying early, since
   "sign in from your phone" is the likely real-world moment.
