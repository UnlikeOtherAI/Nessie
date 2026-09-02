# Browserbase cloud browsers for agents

**Date:** 2026-09-02 · **Status:** proposal (not yet built)

Agents get their own browser that survives the run: a cloud Chromium session
from [Browserbase](https://www.browserbase.com) that an agent can open,
navigate, and act in — with the login state (cookies, localStorage) retained
per person per service, so the agent can come back tomorrow still signed in.

The decision that shapes everything else: **Nessie never holds a person's
service credentials.** There is no server-side password vault. What persists
is *sessions* (Browserbase Contexts, encrypted at rest on Browserbase's side,
referenced from Nessie only by an opaque context id), and the way a session
first gets authenticated is the person typing into the live browser view
themselves — credentials go keyboard → Browserbase, never through Nessie's
servers or the model. A later phase lets the desktop executor inject
credentials the person stored in *their own* device keychain (iCloud Keychain
on Apple platforms), so re-login can be automated without Nessie ever seeing a
password.

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
| Credentials | n/a | user's own password manager | human via Live View; later device-keychain injection |
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
- **Pricing** (2026-09): Free 1 browser-hour / Developer $20 → 100 h,
  $0.12/h over / Startup $99 → 500 h, $0.10/h over / Scale custom. Concurrency
  caps per plan (3 / 25 / 100 / 250+). Browser-hours are the metered unit, so
  sessions must be closed aggressively and their duration recorded.

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

### 4.1 Connection (owner-only, org-scoped)

- New shared package `packages/browser-cloud/` (`@nessie/browser-cloud`):
  Browserbase REST client, session/context lifecycle, live-view URL minting.
  Shared by API routes and worker, the `@nessie/mcp-manage` /
  `@nessie/workspace-admin` pattern.
- `CloudBrowserConnection` row per organization: `{ organizationId (unique),
  projectId, apiKeyRef, status, health fields }`. The API key is submitted
  once and stored through the existing encrypted secret store
  (`createPgSecretStore`, a server-minted `secret_browserbase_` ref) — never
  returned, never caller-chosen, exactly like MCP instance secrets
  (`packages/mcp-manage/src/instance-secret.ts` discipline).
- Enable is a probe-then-persist: create + immediately release a throwaway
  session; failure refuses the toggle loudly (`BROWSERBASE_UNREACHABLE`,
  `BROWSERBASE_AUTH_FAILED`) rather than persisting a dead connection — the
  DeepWater enable precedent.
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
- `BrowserProfile` `{ id, organizationId, userId, browserbaseContextId,
  label, serviceHint?, createdAt, lastUsedAt, status }` — one row per
  persistent login identity. `serviceHint` is display metadata ("Google —
  ondrej@…"), written from what the person confirms at login handoff, never
  parsed out of page content.
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
  when (a) the org's connection is healthy, (b) the agent's policy explicitly
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
  sessions are fine unattended.

### 4.6 Credentials stay on the person's devices (phase 3)

The end-state Ondrej wants: the executor pulls credentials from the user's own
stuff, so Nessie never holds them. Platform reality, stated honestly:

- **No OS will hand us the user's existing Safari/Chrome passwords.** iCloud
  Keychain website passwords are not readable by third-party apps by design;
  same for Chrome's store. "Pull their Google password from iCloud" is not
  buildable.
- What **is** buildable: Nessie's **own keychain items** in the user's
  keychain. The desktop app stores a service credential the person explicitly
  saves, as a `kSecClass genericPassword` item with `kSecAttrSynchronizable`
  — so it syncs across their Apple devices via **iCloud Keychain**, owned by
  them, invisible to our servers. Equivalents: Secret Service/libsecret
  (Linux), Credential Manager/DPAPI (Windows), Keystore-wrapped storage
  (Android companion). Today `desktop/src-tauri` has **no keychain
  integration at all** (state is a `0o600` JSON file) — this phase adds the
  first one (Tauri keyring plugin / `security-framework` on macOS).
- **Injection path**: when a cloud session hits a login wall for a service the
  person has saved, the run parks exactly as in §4.4, but instead of (or
  before) asking the human, the worker issues a new executor operation —
  `browser.cloud.authenticate { sessionId, service }` — through the existing
  encrypted `ExecutorCommand` channel. The **device** fetches the credential
  from the local keychain and types it into the Browserbase session over its
  own direct CDP connection. Plaintext flows device → Browserbase; the
  command result carries only `{ outcome }`. If the device is offline, the
  flow degrades to the §4.4 human handoff — stated in the card ("your Mac is
  offline, sign in here instead").
- The alternative that needs no new storage at all: advertise the existing
  `browser.connected.*` operations (the person's real Chrome, real password
  manager, real sessions) once their disclosure preconditions are done. That
  work is upstream of this plan and complementary — connected Chrome covers
  attended "act as me on my machine"; Browserbase covers unattended and
  cloud-persistent.

Recommendation inside this phase: sessions-first. With Contexts + one human
login per service, stored passwords are rarely needed; keychain injection is
for the "session expired while I'm away" case and should stay opt-in per
service.

### 4.7 Surfaces (Rule zero)

- **Home — org**: `/settings/organization` → "Cloud browsers" (owner-only):
  connect/replace key (write-only), health, plan/concurrency note, disable.
- **Home — person**: `/settings/connections` gains a "Browser profiles"
  section: each profile with label, service hint, last used, and **Sign out &
  delete** (deletes the Browserbase context + row — the revocation story).
- **Doorways**: the Agent Designer's existing explicit-grant switch surfaces
  the browser bundle; the login card and live-view dialog live in chat where
  the question arises; `/ops/usage` gains browser-hours per org/agent from
  `CloudBrowserSession` durations (owner-only, no currency figures to
  members, per the budget-copy rule).

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

**Phase 1 — connect + ephemeral cloud browsing.**
`@nessie/browser-cloud`, `CloudBrowserConnection` + secret-store key, probe on
enable, `CloudBrowserSession` lifecycle fused to run terminal + reaper sweep,
`buildCloudBrowserToolset` behind `requiresExplicitGrant`, shared logical
tools (`browser_open/goto/act/observe/screenshot/close`, ephemeral only),
screenshots via FileService, watch-only Live View dialog with cancel,
org settings surface, ops usage rows. *Done when:* a granted agent can be
asked "check what this page says" and a person can watch it happen and see
the hours on `/ops/usage`.

**Phase 2 — profiles + login handoff.**
`BrowserProfile` + context create/attach (`persist: true`), single-session
claim per profile, `browser_login_request` card + `waiting_input` park +
interactive Live View + observe-suppression during takeover, structural
prompt block listing the person's profiles, `user:<id>` disclosure basis on
profile-backed opens, `/settings/connections` profile management with delete,
unattended-run refusal. *Done when:* a person signs into a service once in
chat, and tomorrow's run reuses that login without asking — and deleting the
profile provably signs the agent out.

**Phase 3 — device-held credentials + connected Chrome.**
Desktop keychain integration (synchronizable items → iCloud Keychain; Linux/
Windows equivalents), `browser.cloud.authenticate` executor operation with
device-side CDP injection, offline degradation to human handoff; separately,
finish the disclosure preconditions and advertise `browser.connected.*`.
*Done when:* a session re-login happens with no human present, and the
password provably never appeared in any Nessie table, log, command payload,
or model context.

**Phase 4 — unattended profiles + polish.**
Per-profile per-trigger opt-in for scheduled runs, proxy/geo options,
Stagehand-style `browser_act` if observe/act proves too low-level.

## 6. Open questions

1. **Ledger or bring-your-own key?** This plan assumes the org supplies its
   own Browserbase key (self-hosted product, org's own bill). If Browserbase
   should instead be metered through Ledger like DeepWater/Serper, the
   connection layer swaps to a product-bound Ledger adapter and §4.1 changes;
   everything from §4.2 down survives as-is.
2. **Sensitive-action gating.** Should `browser_act` on a profile-backed
   session require an approval for irreversible-looking actions (submitting
   orders, sending messages)? The approval machinery is there; the question
   is whether "irreversible-looking" can be decided structurally (it cannot
   be string-matched — it would have to be model-judged, or scoped by domain
   allowlists the person sets per profile).
3. **Mobile companion.** The login handoff dialog should work from the mobile
   app's webview (it's an iframe + card press); worth verifying early, since
   "sign in from your phone" is the likely real-world moment.
