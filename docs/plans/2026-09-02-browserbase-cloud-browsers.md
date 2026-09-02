# Browserbase cloud browsers for agents

**Date:** 2026-09-02 (rev 3) · **Status:** phases 1 and 2 built; phase 3 open.
As-built deltas in §5a (phase 1) and §5b (phase 2).

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
   considered and rejected as too dangerous for us to hold. Stated
   honestly per review: the API key + context id pair *is*
   session-equivalent material (whoever holds both can launch the context
   and act as the logged-in user), so the secret store and these rows are
   protected accordingly — the claim is "no passwords, no vault", never
   "nothing sensitive".
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
6. **Default OFF — and the cloud grant is its own key.** Browser tools are
   `requiresExplicitGrant` per agent, the DeepWater discipline:
   absent/inherited policy does not expose them. The cloud-browser bundle
   is a **distinct policy key from the executor browser bundle** (review
   finding): a grant made for an isolated local sandbox must not silently
   become third-party, credential-bearing cloud browsing the day an owner
   connects Browserbase — each agent is granted the cloud bundle
   explicitly.

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
  toolset. One connection per run — never mixed mid-run. Two review
  refinements: a **workspace agent's** `mode: 'mine'` requires the org
  connection — while it is degraded the tool refuses with the repair named,
  never silently falling back to an individual's key for workspace work
  (ephemeral may still resolve personally for the requester's own runs);
  and a **private agent's** durable browser prefers its owner's personal
  connection even when an org connection exists, because a private
  browsing session on the company account is replayable by the company's
  Browserbase admin — if the owner has no personal connection, the org
  one is used and the agent's Browser panel says exactly that, instead of
  claiming a privacy the account topology cannot deliver.
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
  per service, not a migration). **Remote resources are never "deleted in
  the same transaction"** (review finding — an external REST call cannot
  join a DB transaction, and either half can fail alone): agent deletion
  and Sign out & reset tombstone the `AgentBrowser` row transactionally,
  then a durable queue job deletes the Browserbase context with retries,
  and a reconciliation sweep reaps contexts whose rows are gone. Rows
  carry composite tenancy FKs (`(organizationId, agentId)`,
  `(organizationId, connectionId)`; login `userId` through the
  organization-member composite key, the `Agent.ownerUserId` precedent) so
  one tenant's context can never ride another tenant's key.
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
- `CloudBrowserSession` `{ id, organizationId, runId, connectionId,
  agentBrowserId?, browserbaseSessionId?, status, controlledByUserId?,
  controlClaimedAt?, startedAt, endedAt, releasedBy }`. `connectionId` is
  mandatory (review finding: an ephemeral session's reaper otherwise
  cannot know which API key owns it, and `/ops/usage` cannot attribute by
  connection scope). Status is a real remote-resource state machine —
  `allocating | active | releasing | released | failed | unknown` — not a
  boolean: a create timeout leaves a paid remote session with no local id
  (`allocating` + reconcile), a crash after claim must not hold a ghost
  lock forever, and `active` may only clear after Browserbase confirms
  termination. Two unique partial indexes: one live session per
  `agentBrowserId` (one agent running concurrently in two threads gets a
  clean "this agent's browser is in use" error and can go ephemeral or
  retry — Browserbase warns against two sessions on one context), and one
  live session per `runId` (so `goto`/`observe`/`close` always have an
  unambiguous current browser).
- **Release is fused to every terminal writer, not just the worker's.**
  The working-marker precedent covers `lifecycle.ts` `updateRunStatus`
  (completion, failure, budget stop, worker cancel) — but the review found
  the API also writes terminal `Run.status` directly (service-side cancel,
  and card resume paths), and the card-expiry sweep flips only the card
  row. Each of those writers releases the session (and the expiry sweep
  resumes-or-fails the parked run, §4.4.5). A sweep beside
  `sweepExpiredApprovals` reaps sessions whose run crashed before any
  transition — and reaping means **calling Browserbase to stop the remote
  session**, not just flipping the row; every create also sets the
  platform-side session `timeout` to the §4.8 TTL so a dead worker's
  session dies remotely too. Browser-hours are money — nothing may leak an
  open session.
- **Widening the agent's audience confronts the browser — today, not just
  at future publishing.** The review pointed out that `agent:<id>` widens
  whenever a workspace agent is bound into a public or newly-joined
  channel, and `bindAgentToChannel` performs no browser guard. Phase 2
  adds one shared guard at every audience-widening transition (channel
  bind now; visibility publish when it ships): a browser carrying
  `AgentBrowserLogin` rows refuses the widening with
  `BROWSER_LOGINS_PRESENT` until the owner either resets the browser or
  explicitly confirms, naming each signed-in service being handed to the
  wider audience. The future publish flow inherits this guard instead of
  being a documentation-only obligation.

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
- **One logical surface means one, mechanically** (review finding: the
  first draft named new `browser_*` tools while the executor already
  exposes `executor.browser.open/observe/act` registry ids — two parallel
  families is the fork Rule zero forbids). The operations below are
  defined by **extending the existing logical tool registry**
  (`packages/executor-manage/src/executor-logical-tools.ts`) with the new
  operation keys; registry ids, policy keys, and model-facing names are
  unified across transports in one migration, so the model sees one
  browser vocabulary whether the transport is the device or the cloud.
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

Reworked after the 2026-09-02 adversarial review, which broke the first
draft three independent ways: the card machinery is **one-shot** (every
action press conditionally resolves `open → resolved` and resumes the
waiting run — `api/src/routes/agent-cards.ts` — so an "Open browser" press
followed by a later "Done" press is a second lifecycle the claim-once
invariant forbids); Browserbase ends a session when its automation
connection closes unless paid-plan `keepAlive` is set, so a session the
parked worker abandoned would be a **dead iframe on the free tier**; and
context changes are only durably saved on session close, so resuming
against the same context immediately can read **stale, logged-out state**.

The corrected flow — the login session is **human-only** and never driven
by the worker at all:

1. `browser_login_request` posts an **agent card** addressed to the
   requesting user only, with the reason, a **link block** that opens the
   screen viewer (§4.9), and exactly one action: *Done*. The run exits
   through `pendingInput`, parks in `waiting_input`, and — critically —
   **releases its own browser session first**; the parked run holds no
   session, so nothing burns hours while a human dawdles.
2. Opening the viewer from the card's link mints a **fresh, human-only
   session** on the agent's context (`persist: true`): no worker CDP
   connection exists or is needed, so the keepAlive question never arises.
   The live-view URL is fetched per-open from the viewer-authorized detail
   route (§4.9's one authorization rule; during a login handoff it narrows
   to the card's addressee) — the URL itself is never written into a
   message, card row, or realtime payload.
3. The person signs in and completes 2FA — keystrokes go browser →
   Browserbase. Nessie relays nothing; the model sees nothing (no worker is
   even attached). Sessions are created with `solveCaptchas: false`,
   `recordSession: false`, and logging disabled (§6.2/§6.5), so the
   platform neither solves challenges for us nor records the person's
   keystrokes for the Browserbase account holder to replay.
4. The person presses *Done* — the card's single one-shot action,
   confirming the service label. The press transaction writes the
   `AgentBrowserLogin` row (**this user**, **this service**, **this
   browser** — audit and revocation), **releases the login session**, and
   resumes the run through the shared resume core. The continuation waits
   for Browserbase's context sync (bounded delay + a logged-in re-check)
   before reopening the context, because context persistence is
   asynchronous on session close.
5. Card expiry is **deployment-clamped** (default ~15 min, never
   model-chosen beyond the clamp) and swept beside the approval sweep; the
   sweep must do all three things the press does minus the login row —
   release any login session, resolve the card, and resume-or-fail the
   parked run — because a card row flipped to expired while the run stays
   `waiting_input` would hold the thread slot forever.

Consent is the §4.9 banner, not a per-login declaration: on a workspace
agent, signing in *is* sharing with everyone who can reach the agent, and
the viewer says so before the first keystroke. Watching without controlling
is the same viewer in watch mode (§4.9), with the cancel-run control beside
it.

### 4.5 Disclosure and unattended use

- **Logins are shared with the agent's audience — warned, not partitioned**
  (decided 2026-09-02). An authenticated browser registers the existing
  `agent:<agentId>` basis scope in `ConsumedSourceSink` — the vocabulary
  already defines it as *exactly the people who pass the shared live
  agent-visibility predicate*. Material read through a workspace agent's
  browser is readable by whoever can reach that agent; on a private agent
  the same scope resolves to its owner alone. The consent mechanism is the
  §4.9 banner; the copy still steers: **personal accounts belong in your
  private agent's browser**.
- **"Authenticated" is a monotone session fact, never derived from login
  rows alone** (review finding — the row-derived version failed open two
  ways: registration happened only at `browser_open`, so the sanctioned
  first-login handoff authenticated the browser *mid-run* with nothing in
  the sink; and a person signing in during generic Take-control — or a
  magic-link/SSO completion the agent itself clicks through — writes no
  row at all). The fact is set, and the scope registered, at the **first**
  of: session open on a context whose **CDP-enumerated cookies** are
  non-empty (the mechanical authenticated-origin set — `serviceHint` is
  display text, never the trigger); a login-handoff resume; or **any
  control claim** taken on the session. Hand-back of a control claim on a
  persistent session also writes an `AgentBrowserLogin` row (service
  "unlabeled" until the person names it), so ad-hoc sign-ins during
  control are recorded, and an ephemeral session that had a control claim
  is treated as authenticated for the rest of its run. Once set it never
  clears within the session — monotone, like `runReplyIsRestricted`. A
  session that never trips any trigger browses the public web like
  `web_fetch` and adds no basis.
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

- Browser-hours are bounded by the session TTL and the concurrency cap,
  not the run budget: the review showed the run wall-clock resets across
  `waiting_input` continuations, so the session's own hard TTL (default
  ~10 min, agent-extendable only up to a deployment ceiling enforced **at
  create**, and mirrored into Browserbase's platform-side session
  `timeout`) is the real spend bound; a hung CDP connection or dead worker
  cannot run a browser past it.
- Concurrency: org-level cap (`NESSIE_BROWSER_CLOUD_MAX_CONCURRENT`, default
  well under the Browserbase plan cap) taken as an **atomic claim** in the
  create transaction (counter row or advisory lock — a count-then-insert
  under fan-out admits N past the cap; the claim-once rule applies to caps
  too), with a clear tool error for the loser. Browserbase's own 429
  (concurrency or creation-rate) maps to the same clear error, and usage
  copy accounts for their one-minute minimum charge per created session —
  local durations under-report the billed allowance otherwise.
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
- **Watch vs control — and the URL, not CSS, is the boundary.** The review
  killed the first draft's framing: `pointer-events: none` is a styling
  choice any viewer flips in devtools, and the live-view URL Browserbase
  returns is interactive for whoever holds it. So the real access decision
  is **who may fetch the URL at all** — the viewer-authorized detail route
  — and every viewer it admits must be treated as *able to drive*, which
  is acceptable precisely because that set is the agent's audience, the
  same people the logins are declared shared with. Phase 1 verifies
  whether Browserbase offers a genuinely non-interactive live-view
  variant and per-URL expiry; until proven, the URL is handled as a
  live-session bearer capability: minted per-open, never persisted,
  never logged, and its unverified expiry is a phase-1 gate (§6.3).
- **The control claim is coordination and audit, not the security
  boundary** — but it does gate the *agent*. `CloudBrowserSession` carries
  `controlledByUserId` + `controlClaimedAt`, claimed by a conditional
  UPDATE (`controlledByUserId IS NULL` in the WHERE): one winner, every
  other viewer sees "«name» is at the controls". While any claim is held,
  **every** browser tool for that session is refused — `browser_act`,
  `browser_goto`, and `browser_close` included, not just observe and
  screenshot, because Nessie dispatches tool batches concurrently and an
  agent mid-navigation while a person types credentials is exactly the
  race the first draft claimed away — and the worker re-checks the claim
  per dispatch, with input enabled in the viewer only after the session's
  in-flight tool calls settle. Release is explicit ("Hand back") and
  structural (session end; a short keepalive timeout so a closed laptop
  lid never holds a team's browser hostage).
- **One authorization rule for the whole live surface, and it is the
  run's, not just the browser's.** The first draft contradicted itself
  (requester-only in §4.4, audience in §4.9) and checked only browser
  authentication, ignoring everything else the run consumed — but a run
  that read a private document and then typed it into a public web form
  is exactly what `runReplyIsRestricted` exists to cut. The rule: a
  session's live surface (live-view URL minting, `stream.browser.tabs`,
  `browser.session.*` events) is authorized against the **union of the
  session's basis and the owning run's current basis**, re-evaluated on
  the same monotone predicate the other live lanes use. Restricted tab
  events carry `restricted: true` with no titles/origins, and entitled
  viewers resolve through the authorized detail route — the
  document-stream pattern verbatim. During a login handoff the surface
  narrows further, to the card's addressee alone.
- **The shared-browser banner.** On a workspace agent's browser, the viewer
  renders a dismissible notice pinned above the iframe: *"Other people can
  use this agent's browser. Anything you sign in to here is shared with
  everyone who has access to this agent."* Dismissal persists per (user,
  agent) — but the banner **always returns, undismissed, in login-handoff
  control mode**, because that is the moment the sentence is load-bearing.
  Private agents' browsers render no banner; there is nobody else. This is
  the consent half of §4.5's warn-not-partition decision.
- An unauthorized session is shaped exactly like an absent one (the
  indistinguishable-404 discipline); authorization is the union rule above.
- **One right panel at a time**: opening the screen panel closes the reply
  panel and vice versa (v1) — two stacked right panels is the nested-frame
  shape the content system forbids.

## 5. Phasing

**Phase 1 — connect (both tiers) + ephemeral cloud browsing. — BUILT
2026-09-02**, with the deltas recorded in §5a below.
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
the company account makes the cloud bundle grantable org-wide (each agent
still granted explicitly, §3.6 — a prior executor grant never converts).

### 5a. What phase 1 actually shipped, and where it differs

Built 2026-09-02. Everything below is a deliberate change from the plan
above, kept here rather than silently rewriting the spec.

- **The tool surface is the executor's grammar, verbatim.** The plan named
  `browser_open/goto/act/observe/screenshot/close`; the executor already
  defines a closed grammar — `browser.open {url}`,
  `browser.observe {includeScreenshot?}`, and a `browser.act` discriminated
  union of navigate/click/type/press/scroll addressed only by an
  accessibility node id. Reusing those exact schemas is a stronger form of
  the same "one logical surface" rule than inventing parallel verbs, so the
  shipped set is `browser_open`, `browser_observe`, `browser_act`,
  `browser_close`, importing `ExecutorBrowser*ArgumentsSchema` from
  `@nessie/schemas`. `goto` and `screenshot` fold into `act:navigate` and
  `observe:includeScreenshot`.
- **Builtins, not a bindings-gated toolset.** `buildCloudBrowserToolset`
  was planned as a twin of `buildExecutorToolset`. The executor needs that
  shape because its tools are gated on live device *bindings*; a cloud
  browser is gated on a *grant*, which the builtin registry already
  enforces (`requiresExplicitGrant`, `tool-policy.ts`). So the tools are
  builtin definitions dispatched from `worker/src/run/tools.ts`, which also
  hands them `consumedSources` and the run context for free.
- **The dispatcher returns a result rather than a `wrapTool` thunk.**
  `wrapTool` converts every throw into `success: false`, which would have
  swallowed `CloudBrowserUnknownOutcomeError` — telling a model an action
  failed when it may well have completed. The browser tools follow
  `dispatchKbTool` instead and re-throw the fatal marker.
- **Release is fused through a hook, not a parameter.** `updateRunStatus`
  has eight call sites and no access to a secret resolver; a new argument
  would have put the obligation back on every caller. `setCloudBrowserReleaseHook`
  is registered once at worker startup.
- **Tabs come from the detail route, not `stream.browser.tabs`.** Phase 1
  polls `sessions.debug().pages` through the session detail endpoint. The
  worker-published SSE lane is worth building when the tab list needs to
  update between polls; it is not needed to render the strip.
- **The display joins the shared surfaces rather than re-implementing
  them** (corrected 2026-09-02, after the admin's architecture-lint suite
  caught all three). The tab strip resolves through `useTabParam` as
  `?browserTab=`, which also replaces a `useState` + reset effect: an id the
  session no longer has fails the hook's own validation and degrades to the
  first tab. The full-screen takeover composes `useOverlay` instead of
  hand-rolling an Escape listener, so it gets Back registration, the focus
  trap and the modal layer with it. And the session and thread-session reads
  carry `placeholderData: keepPreviousData`, so switching sessions keeps the
  previous browser on screen rather than flashing empty.
- **Deferred out of phase 1**, none of them load-bearing for the slice:
  the first-party `/apps` listing, `/ops/usage` rows, the thinking-bubble
  chip, and the info-drawer *thumbnail* (a live disclosure row shipped
  instead, and only while a browser is actually open).

Verified end to end against the real Browserbase API on 2026-09-02: a
rejected key returns `CLOUD_BROWSER_AUTH_FAILED`, the panel shows that
sentence, and **nothing is persisted** — zero connection rows, zero stored
secrets. Storage invariants (partial unique per scope, the scope/user
CHECK, the composite tenancy FK) were each proven to refuse against live
Postgres, and five DB-backed tests cover the lifecycle claims; neutralising
the provider-stop call fails exactly the two tests that assert it.

**Phase 2 — agent browsers + login handoff. — BUILT 2026-09-02**, deltas in §5b.
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

### 5b. What phase 2 actually shipped, and where it differs

Built 2026-09-02. Deliberate departures from the spec above, recorded rather
than silently rewritten:

- **The cross-origin write gate refuses rather than asks.** §6.1 specified a
  one-tap approval; the shipped gate returns a refusal naming the origin and
  telling the model to ask the person to take control. Stricter, and it
  needed no approval plumbing — but it *will* block a legitimate
  cross-origin hop (an OAuth redirect mid-task) that an approval would have
  let through. Converting it to an approval is a contained follow-up: the
  verdict is already computed in one place (`origin-gate.ts`).
- **The gate's trigger is CDP cookie domains**, read once at open, exactly as
  §6.1 required — never `serviceHint`, which is display text a person typed.
  Its stated limits live in the module: page scripts act below the tool
  layer, and material carried across runs in the model's own memory is the
  generic model-knows-a-secret problem, shared with `http_fetch`.
- **"Authenticated" is decided at open, not per read.** The session row's
  `authenticated` flag is set when the durable browser already carries login
  rows, and every later verb re-registers the `agent:<id>` basis from it.
  The plan also wanted a control claim to flip it; a claim on a session that
  was not already authenticated does not currently do so, which is a real
  (small) gap: somebody could sign in during an ad-hoc control claim on an
  unauthenticated browser and the run would not register a basis. Closing it
  means writing a login row (or setting the flag) on hand-back.
- **Sign-out is all-or-nothing**, as §6a said it would be: reset clears every
  signer's login together, and the copy says so. Per-service cookie deletion
  stays phase 3.
- **The publish-transition and channel-bind guards are not built.** §4.2 puts
  an obligation on any transition that widens an agent's audience; private →
  workspace publishing still does not exist, and the channel-bind guard
  (`BROWSER_LOGINS_PRESENT`) is not wired. A workspace agent bound into a
  wider channel therefore widens its browser's audience with no prompt —
  the highest-value thing left in this area.
- **The browser panel lives on the agent's Tools tab**, not a new tab: a
  browser is a tool, and an eighth tab is the drift Rule zero names.
- **`browser_download` runs our own fixed script in the page** (a `fetch`
  with the session's credentials), which the closed verb grammar otherwise
  excludes. The distinction is that the script is ours and the model
  supplies only a node id; bytes land through the one `FileService`.

Not verified against a live Browserbase account: no key was available, so
the durable-context path (create, attach with `persist`, delete) is covered
by unit and Postgres tests against a faked client, not an end-to-end run.

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
   domain allowlist — opt-in hardening, never the default (its home is the
   Agent Designer Browser panel, per Rule zero). The gate's trigger set is
   the §4.5 mechanical authenticated-origin fact (CDP cookie domains),
   never `serviceHint` text; "write" covers typed input, submitting
   clicks, and cross-origin navigation carrying data, and the review's
   honest limits are recorded: page-script requests (CSRF, redirects,
   popups) act below the tool layer and are not interceptable; the gate is
   per-run, so material carried across runs via memory can be egressed by
   a later clean session (the generic model-knows-secrets egress problem,
   shared with `http_fetch` — not new here); and same-origin exfiltration
   (a webmail draft to an attacker) stays open by the §7.1 decision, whose
   trade — a page's injected instruction can trigger a same-origin
   destructive action, and the person's ask is still treated as the
   consent — the review objected to and the decision-maker accepted. The
   opt-in pinning closes the navigation-URL channel for browsers that want
   it. Phase 1 (ephemeral-only) carries ordinary `web_fetch`-grade
   exposure.
2. **The Browserbase dashboard bypasses disclosure — mitigated by session
   flags** (upgraded by review: the flags are documented, not
   hypothetical). Recording and session logging are ON by default; every
   Nessie session is created with `recordSession: false` and logging
   disabled, so login handoffs and authenticated browsing are not
   replayable from the Browserbase dashboard. Residual: the account holder
   still sees session metadata and could change nothing we control at
   Browserbase's side; the connect UI says so, and §4.1's private-agent
   personal-connection preference exists for exactly this.
3. **Live-view URL semantics are unverified — phase-1 gate.** Browserbase
   documents neither expiry nor single-use for `debuggerFullscreenUrl`; if
   it is a long-lived bearer link, a leaked URL outlives membership
   revocation and sidesteps the control claim. §4.9 already treats every
   URL holder as a potential driver and admits only the session's
   authorized audience; the empirical expiry check is a gate on phase 1,
   not a to-do.
4. **Anti-bot lockouts hit the person's real account.** Handoff copy warns;
   and a structural steering block (toolset facts only, the research-routing
   precedent) points agents at first-party connectors where one exists —
   the browser is for services without a connector.
5. **CAPTCHA policy vs platform default — resolved.** Solving is ON by
   default and `browserSettings.solveCaptchas: false` is documented; every
   Nessie session create passes it, making §3.3's human-solves stance true
   by construction.
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
10. **A connection that stops working owns the way a person finds out.**
    Keys get revoked, projects deleted, accounts suspended, plans
    downgraded — Browserbase names project deletion and account
    suspension as context invalidators. `CloudBrowserConnection` gets the
    trigger-health treatment (AGENTS.md's transition-owns-the-alert rule):
    a runtime auth failure claims a classified `needs_attention` state by
    conditional UPDATE with a persisted reason, alerts the owner (or the
    personal connection's member) exactly once per transition, stops
    advertising the toolset, and recovery is an explicit re-key — never
    silent retry against a dead key, and never a stale toolset promising a
    browser that cannot open.
11. **Passkeys and remote browsers do not mix.** A service that mandates
    passkeys/WebAuthn cannot complete login in a cloud browser (the
    authenticator is on the person's device), and mobile live-view typing
    needs Browserbase's virtual-keyboard option. Named limitation: the
    handoff card says so when the person reports a passkey wall, and the
    mobile viewer passes the keyboard parameter — "sign in from your
    phone" is a phase-2 acceptance test, not an assumption.

## 6a. Adversarial-review addenda (2026-09-02, Kimix + Codex Sol)

Accepted findings that are requirements rather than section rewrites:

- **Non-idempotent actions get the executor's ambiguity protocol.** A click
  can place an order and then lose the CDP response; the device transport
  already handles this with a stable per-tool-call idempotency identity
  and a fatal unknown-outcome error (`executor-toolset.ts`) — the cloud
  dispatch mirrors it: never silently retry an action whose outcome is
  unknown, never report it failed when it may have happened.
- **A pinned WSS dial is new work, not a reused precedent.** The MCP SSE
  transport rides HTTP `safeFetch`, and the raw pinned connector returns a
  TCP socket without a TLS/WebSocket handshake — `@nessie/browser-cloud`
  builds the resolve-pin-then-TLS(SNI)-then-upgrade client as its own
  deliverable on the `url-safety.ts` primitives. `browser_goto` also
  refuses non-http(s) schemes, matching the executor's egress posture
  (navigation egresses from Browserbase's network, so the SSRF surface is
  theirs, but scheme hygiene is ours).
- **"Sign out & reset" is authorized and honest.** Reset is available to
  the agent's steward/owner and to any recorded signer (their own
  revocation right) — not to every member, or it is a one-click DoS on a
  team's logins. It first force-releases any active session through the
  ordinary claim, and the copy says both truths: it wipes *all* logins
  (per-service selective sign-out via CDP cookie deletion is phase-3
  polish), and it does not revoke the service's own server-side session —
  fully revoking means the service's own security page too.
- **Unattended opt-in granularity is the browser, not the login.** One
  context carries every service's cookies at once, so a per-login
  per-trigger opt-in would be audit metadata pretending to be a boundary;
  phase 3's opt-in is per-browser and the copy says which services ride
  along.
- **One context per agent is a recorded trade.** Browserbase recommends a
  context per site identity (large contexts slow sessions; one poisoned
  context takes every login down). v1 keeps one context per agent for the
  Grok-parity mental model and revisits if session startup degrades —
  the escape hatch is per-service contexts behind the same tools.

## 7. Open questions

1. **Same-origin sensitive actions — decided 2026-09-02: no gate.** If a
   person asks the agent to submit an order on a site, it submits the
   order; the ask is the consent, and the requester is one tap from
   watching the screen live. Cross-origin writes keep their §6.1 gate —
   that one exists for the page's instructions, not the person's.
2. **Mobile companion.** The login handoff dialog should work from the mobile
   app's webview (it's an iframe + card press); worth verifying early, since
   "sign in from your phone" is the likely real-world moment.
