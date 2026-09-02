# Browserbase cloud browsers for agents

**Date:** 2026-09-02 (rev 2) · **Status:** proposal (not yet built)

Agents get their own browser that survives the run: a cloud Chromium session
from [Browserbase](https://www.browserbase.com) that an agent can open,
navigate, and act in — with the login state (cookies, localStorage) retained
per person per service, so the agent can come back tomorrow still signed in.

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
| Login state | sandbox profile | the person's real sessions | per-user Browserbase Context |
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
  logs), so a free account's login profiles do not expire on Browserbase's
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
4. **A profile belongs to a person.** A Browserbase Context maps to one
   `(organization, user)` — the requesting user's own login state. An agent
   uses it only for that person's runs, under an explicit per-agent grant.
5. **Reads feed the disclosure sink.** A page read through a person's
   authenticated profile is that person's private material; it enters the run
   context with a `user:<id>` basis (`ConsumedSourceSink`), same obligation as
   every other read path.
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
  requester, attended or not (within §4.5's profile rules).
- **Personal connection** (any member): their own Browserbase account —
  free tier to start, upgrade if they turn out to be a power user. It powers
  **only runs that person requested**, the user-scoped MCP install
  discipline (user-scope installs surface only in the installing user's
  runs). Resolution at toolset assembly: the org connection when one is
  healthy, else the requester's personal connection, else no cloud browser
  toolset. One connection per run — never mixed mid-run.
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
- `BrowserProfile` `{ id, organizationId, userId, connectionId,
  browserbaseContextId, label, serviceHint?, createdAt, lastUsedAt,
  status }` — one row per persistent login identity. `connectionId` is
  load-bearing: a Browserbase context is scoped to the account that created
  it, so a profile is usable only through its own connection. If an org
  subscription arrives after people used personal connections, their
  personal profiles cannot be transferred — the person signs in once more
  under the org connection (the UI says so; it is one login, not a
  migration). `serviceHint` is display metadata ("Google — ondrej@…"),
  written from what the person confirms at login handoff, never parsed out
  of page content.
- `CloudBrowserSession` `{ id, organizationId, runId, profileId?,
  browserbaseSessionId, status (active|released|expired), startedAt, endedAt,
  releasedBy }` — the lifecycle row. A profile-backed session is claimed with
  a conditional UPDATE (`status = 'active'` unique partial index per
  `profileId`), so two runs cannot ride one context concurrently; the loser
  gets a clear "profile is in use by another run" tool error.
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
  - `browser_open` `{ profileId? }` — ephemeral session when no profile;
    profile-backed (context attached, `persist: true`) when given. The
    structural prompt block lists the person's own profiles by id + label when
    the toolset is granted, so the model never invents a profile id (the
    agent-docs `spaceId` precedent).
  - `browser_goto`, `browser_act`, `browser_observe`, `browser_screenshot`,
    `browser_close`.
  - `browser_login_request` `{ profileId | newProfile: {label}, reason }` —
    the handoff (§4.4). Cloud transport only.
- If `browser_act` gains a natural-language action layer (Stagehand-style),
  its judging model routes through Nessie's own inference chokepoint
  (`NESSIE_UTILITY_MODEL` via the org provider), never a second LLM key baked
  into the browser layer.

### 4.4 Login handoff — the person types, the agent waits

When the agent hits a login wall (or wants to establish a new profile):

1. `browser_login_request` posts an **agent card** (`card_post` machinery, one
   card system) addressed to the requesting user only, with the reason and a
   single action: *Open browser*. The run exits through `pendingInput` and
   parks in `waiting_input` — the card/approval suspend-resume cores
   (`run-suspend.ts` / `run-resume-core.ts`), never a second copy.
2. Pressing the card opens a centered dialog (the `Dialog` shell) embedding
   the **interactive Live View** iframe. The live-view URL is fetched
   per-open from a viewer-authorized API route (`GET
   /api/browser-sessions/:id/live-view`, requester-only) — the URL itself is
   never written into a message, card row, or realtime payload.
3. The person signs in, completes 2FA, solves any CAPTCHA — keystrokes go
   browser → Browserbase. Nessie relays nothing; the model sees nothing.
   **While the dialog is open in interactive mode, `browser_observe` /
   `browser_screenshot` for that session are refused** ("a person is at the
   controls"), so the model cannot watch credentials being entered.
4. The person presses *Done* on the card. The press is the ordinary
   `agentCardResponse` user turn; the run resumes; cookies are now in the
   context (`persist: true`), and the `BrowserProfile` row is created/touched.
5. Card expiry (agent-set, swept with the approval sweep) releases the parked
   session so an abandoned login doesn't burn browser-hours.

The same dialog in `pointer-events: none` mode is the **watch affordance**: a
person can open "what is the agent doing" on any live cloud session of their
own run — with the existing cancel-run control beside it (the document-stream
dialog precedent).

### 4.5 Disclosure and unattended use

- Opening a session with `profileId` registers a `user:<ownerId>` scope in
  `ConsumedSourceSink` for the run — one registration at open, because
  everything read through an authenticated profile is that person's material.
  Ephemeral no-profile sessions browse the public web like `web_fetch` and
  add no basis.
- Web pages are untrusted content; nothing on a page is an instruction. The
  existing prompt-side framing for fetched content applies to `browser_observe`
  output verbatim.
- **Unattended runs (triggers/schedules) get no profile-backed browsing in
  v1.** An interval sweep silently acting inside a person's Google account is
  a different consent than "help me now"; profile use on unattended runs
  arrives later as an explicit per-profile, per-trigger opt-in. Ephemeral
  sessions are fine unattended — **on the org connection only**: a personal
  connection powers only runs its owner requested, and an unattended run has
  no requester, so it never spends an individual's browser-hours.

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
- **Home — person**: `/settings/connections` gains a "Browser" section with
  two things: the **personal connection** (connect your own Browserbase
  account — free tier to start — replace key, disconnect) and **Browser
  profiles**: each profile with label, service hint, last used, which
  connection it lives on, and **Sign out & delete** (deletes the Browserbase
  context + row — the revocation story).
- **Doorways**: the first-party `/apps` listing (§4.1a) whose Connect routes
  here by scope; the Agent Designer's existing explicit-grant switch
  surfaces the browser bundle; the login card and live-view dialog live in
  chat where the question arises; `/ops/usage` gains browser-hours per
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

## 5. Phasing

**Phase 1 — connect (both tiers) + ephemeral cloud browsing.**
`@nessie/browser-cloud`, `CloudBrowserConnection` at both scopes +
secret-store keys, probe on connect, the first-party `/apps` listing in
`seed-apps.ts` (§4.1a), org + personal settings surfaces,
`CloudBrowserSession` lifecycle fused to run terminal + reaper sweep,
`buildCloudBrowserToolset` behind `requiresExplicitGrant` with the §4.1
resolution order, shared logical tools
(`browser_open/goto/act/observe/screenshot/close`, ephemeral only),
screenshots via FileService, watch-only Live View dialog with cancel, ops
usage rows + the member's own-hours readout. *Done when:* a member on a free
personal account can grant an agent the browser and ask "check what this
page says", watch it happen, and see their hours — and an owner connecting
the company account flips every browser-granted agent to it without anyone
reconfiguring.

**Phase 2 — profiles + login handoff.**
`BrowserProfile` + context create/attach (`persist: true`), single-session
claim per profile, `browser_login_request` card + `waiting_input` park +
interactive Live View + observe-suppression during takeover, structural
prompt block listing the person's profiles, `user:<id>` disclosure basis on
profile-backed opens, `/settings/connections` profile management with delete,
unattended-run refusal. *Done when:* a person signs into a service once in
chat, and tomorrow's run reuses that login without asking — and deleting the
profile provably signs the agent out.

**Phase 3 — unattended profiles + polish.**
Per-profile per-trigger opt-in for scheduled runs (org connection only),
proxy/geo options, Stagehand-style `browser_act` if observe/act proves too
low-level. Separately tracked, not this plan: the disclosure preconditions
that let `browser.connected.*` be advertised.

## 6. Open questions

1. **Sensitive-action gating.** Should `browser_act` on a profile-backed
   session require an approval for irreversible-looking actions (submitting
   orders, sending messages)? The approval machinery is there; the question
   is whether "irreversible-looking" can be decided structurally (it cannot
   be string-matched — it would have to be model-judged, or scoped by domain
   allowlists the person sets per profile).
2. **Mobile companion.** The login handoff dialog should work from the mobile
   app's webview (it's an iframe + card press); worth verifying early, since
   "sign in from your phone" is the likely real-world moment.
