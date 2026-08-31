# Google Workspace in chat — Gmail, Calendar, Meet, negotiated scopes

Date: 2026-08-31
Status: **plan — no code changed yet**

Goal: a person (or a custom agent, or the Personal Assistant) can, **from a
chat message**, read and search their mail, draft and send email, read and
write their calendar, and create Google Meet meetings — with the exact OAuth
scopes chosen up front, and any missing scope requested and granted **in the
same conversation**. A composed email appears in chat as a card showing
recipients, CC, subject and body, with a Send button.

Every claim about the current tree below carries a file citation.

---

## 1. What exists today (verified)

| Piece | Where | State |
|---|---|---|
| Google OAuth start (PKCE, `access_type=offline`, `include_granted_scopes=true`) | [oauth-config.ts:52-70](api/src/routes/comms/oauth-config.ts:52) | **Scope list is a hardcoded constant**: `gmail.readonly`, `meetings.space.created`, `openid`, `email`, `profile` |
| Per-user connection + encrypted tokens | Prisma `CommsConnection` / `CommsConnectionCredential`; `grantedScopes` persisted **from the token response** | Live |
| Credential chokepoint | [`loadUserGoogleCommsCredential`](packages/workspace-admin/src/comms-credential-coordinator.ts:196) — picks the newest active connection **holding `requiredScope`**, decrypts only that row, serialises refresh under a row lock, typed `SCOPE_MISSING` / `NEEDS_REAUTHORIZATION` | Live |
| Gmail adapter | [`packages/comms-google`](packages/comms-google/src) — OAuth exchange/refresh/revoke, profile, labels, messages list/get, history, `users.watch` + Pub/Sub, normalize → `CommsEvent` | **Read-only.** No send, no drafts, no threads-modify |
| Meet | [`createGoogleMeetSpace`](packages/comms-google/src/meet.ts:34) — standalone Meet space via `meetings.space.created`, through `safeFetch` | Live |
| Meet in chat | `meeting_link_create`, `call_start` — [PA-only builtins](packages/runtime/src/builtin-comms-tools.ts:44) calling `createCallLinkForTeamUser` | Live |
| Connect card in chat | `comms_connect_card` → [`CommsConnectCard`](admin/src/components/features/channels/CommsConnectCard.tsx) via `metadata.card = { kind: 'comms_connect' }` | Live |
| Approval **suspend/resume** | [`approval-suspend.ts`](worker/src/run/execute/approval-suspend.ts) + [`approval-resume.ts`](api/src/services/approval-resume.ts): gated tool → `RunCheckpoint(reason:'approval_required')` + `metadata.approvalGate` card + `Run.status = waiting_approval` → resolve → **verified, single-use, args-scoped** `approvalProof` → continuation run | **Landed 2026-08-31** |
| Disclosure sink | [`ConsumedSourceSink`](worker/src/run/execute/disclosure-basis.ts:27) + `computeReplyBasis`; empty basis = unrestricted | Live |
| **Calendar** | — | **Does not exist anywhere in the repo** |
| **Gmail write** | — | **Does not exist** |

Two structural facts that shape everything below:

1. **`include_granted_scopes=true` is already set**, so Google incremental
   authorization is half-wired — the missing half is a *catalog* and a
   *request* path, not new OAuth plumbing.
2. **`grantedScopes` is persisted from the token response, not from what we
   asked for** ([connector.ts:71-79](packages/comms-google/src/connector.ts:71)).
   A user who un-ticks a box on Google's consent screen ends up with fewer
   scopes than requested, and the chokepoint already fails closed on that.
   Everything new must keep asking the chokepoint, never a local wish-list.

---

## 2. Decision: how "MCP-enabled" is satisfied

**Nessie is an MCP *client*, not a server.** The JSON-RPC `/mcp` endpoint was
removed with the legacy `src/` tree (CLAUDE.md → "Legacy JSON-RPC MCP server
removed"); `packages/mcp-client` is a client and `@nessie/mcp-manage` manages
*outbound* connectors. So "100% MCP-enabled" cannot be satisfied literally
without building a new server. Three options were weighed:

| Option | Verdict |
|---|---|
| **(a) First-party builtin tools** in the worker, reusing `loadUserGoogleCommsCredential` | **Recommended.** Same tool surface to the model as any MCP tool (one `tools` array), per-agent `requiresExplicitGrant`, one credential store, disclosure sink and approval gate for free |
| (b) Install a third-party Google MCP server as an `McpServerInstance` | **Rejected.** It would create a *second* Google credential store (`mcp_server_credentials` beside `comms_connection_credentials`) and a second OAuth flow — exactly the fork Rule zero forbids, on the most sensitive credential in the product. It also cannot feed the disclosure sink or the `FileService` |
| (c) Build a Nessie MCP **server** exposing these functions outward | Separate, larger piece of work. Compatible later: (a)'s functions live in `@nessie/comms-google` + `@nessie/workspace-admin` and a server would call the same functions |

**Chosen: (a).** From the model's point of view the tools are indistinguishable
from MCP tools — same schema shape, same grant model, same `tool_spec` /
deferred-loading machinery. If you want (c) as well, say so and it becomes a
Phase 4; it does not change anything below.

> ⚠️ **Decision point for you.** If "100% MCP-enabled" specifically means
> "reachable by an external MCP client", that is option (c) and I should scope
> it separately.

---

## 3. Scopes are a capability catalog, not a constant

New `packages/schemas/src/google-capabilities.ts` — the single source of truth,
imported by API (authorize URL), worker (tool preflight) and admin (UI copy).

```ts
export type GoogleCapability = {
  id: GoogleCapabilityId
  scopes: readonly string[]      // the exact Google scope strings
  label: string                  // "Send email as you"
  explains: string               // one plain sentence for the consent card
  risk: 'read' | 'write' | 'send'
  googleTier: 'basic' | 'sensitive' | 'restricted'  // verification burden
}
```

| id | Google scope(s) | Tier | Enables |
|---|---|---|---|
| `gmail.read` | `gmail.readonly` | restricted | search, read threads/messages, labels, attachments |
| `gmail.compose` | `gmail.compose` | restricted | create/update/delete drafts **and send** (Google does not separate them — see below) |
| `gmail.send` | `gmail.send` | sensitive | send only, no read — for a send-only agent |
| `gmail.modify` | `gmail.modify` | restricted | labels, archive, trash, mark read |
| `calendar.read` | `calendar.readonly` | sensitive | list calendars, read events, free/busy |
| `calendar.write` | `calendar.events` | sensitive | create/update/cancel events, invite attendees |
| `meet.create` | `meetings.space.created` | sensitive | standalone Meet space (**already used** by `meeting_link_create`) |
| `contacts.read` | `contacts.readonly`, `directory.readonly` | sensitive | resolve "email Jana" → an address |

Three facts this catalog has to state honestly:

- **Google has no "drafts but cannot send" scope.** `gmail.compose` grants
  both. The product separation between *draft* and *send* is therefore
  enforced by **Nessie's tool policy + approval gate**, not by the OAuth
  scope. That is the single most important line in this plan: the safety
  property comes from `evaluateToolInvokePolicy`, not from Google.
- **Restricted scopes need Google's CASA assessment** for a *public* OAuth
  client. Nessie is self-hosted: each deployment registers its **own** Google
  Cloud OAuth client (`NESSIE_COMMS_GOOGLE_CLIENT_ID` already per-deployment),
  and an **Internal** Workspace app skips verification entirely. Hosted
  `nessie.works` would need the assessment for `gmail.read`/`compose`/`modify`.
  Document this in `docs/deployment.md`; it is an operational gate, not a code
  one, and it must not be discovered after the build.
- **Google cannot partially revoke.** `/revoke` kills the whole grant. So
  per-capability "remove" is a **local block** (§7) plus an explicit
  "Disconnect" for a true revoke. Saying "revoked" for a local block would be
  a lie to the user.

---

## 4. Scope negotiation — three flows, one route

### 4.1 Connect with a chosen set
`POST /api/comms/connections/google/start` gains an optional body
`{ capabilities: GoogleCapabilityId[] }`, validated against the catalog and
expanded to scope strings by `buildAuthorizeUrl`. **Omitted → today's exact
list**, so the existing flow is byte-identical.

### 4.2 Add a capability to a live connection (incremental auth)
Same route with `{ capabilities, connectionId }`. The authorize URL asks for
`existing grantedScopes ∪ requested`; `include_granted_scopes=true` (already
set) makes Google return a token covering the union, and the callback
re-persists `grantedScopes` from the token response — **already the behaviour**
([connector.ts:71](packages/comms-google/src/connector.ts:71)). `prompt=consent`
stays, because a new scope needs consent and re-issues the refresh token.

`CommsConnection` gains `requestedCapabilities Json @default("[]")` so the UI
can show *asked-for-but-declined* (the user un-ticked it) rather than silently
showing "not granted".

### 4.3 Ask for a capability **from inside the chat** ← the requirement
One shared helper in the worker, `requireGoogleCapability(context, capabilityId)`:

1. Resolve the acting user (§6.1) and call the credential chokepoint with the
   capability's scopes.
2. On `SCOPE_MISSING` / `CONNECTION_NOT_FOUND` / `NEEDS_REAUTHORIZATION`:
   post a **server-authored** card
   `metadata.card = { kind: 'google_scope_request', capabilityId, reason,
   connectionId? }` into the thread, and return a *refusal in words* to the
   model ("I need permission to send email as you — I've put a Grant button in
   the chat").
3. `GoogleScopeRequestCard` renders capability label + one-sentence
   explanation + **Grant** → `POST …/start` with that capability → new tab →
   on return, realtime `message.updated` flips the card to "Granted ✓".

This is the same shape as `CommsConnectCard` and the same "tool refuses in
words, never claims it has no such capability" rule the `connector_*` tools
already follow (AGENTS.md → PA-tool bullet). The card is **never** authored
from model output — the capability id comes from the tool that failed, exactly
as `metadata.runStop` is server-stamped.

---

## 5. Provider layer — extend `@nessie/comms-google`

New directories (the 500-line cap is real; `client.ts` is already 266):

```
src/gmail/
  drafts.ts      create / update / get / list / delete / send
  send.ts        messages.send (direct), threads.modify
  mime.ts        RFC 5322 + multipart build, base64url  (read-side mime.ts stays)
  threads.ts     threads.get with format=full, attachment fetch
src/calendar/
  calendars.ts   calendarList.list, calendars.get
  events.ts      events.list/get/insert/patch/delete, sendUpdates
  freebusy.ts    freeBusy.query
  conference.ts  conferenceData + conferenceDataVersion=1  ← Meet **on an event**
```

Notes:
- **Meet has two shapes and both are wanted.** `meetings.space.created` (a
  standalone room, already live) vs. `conferenceData` on a calendar event (a
  Meet link attached to a real invite). "Create a Google Meet meeting" in the
  user's sense is usually the second. Both ship.
- Every new call goes through **`safeFetch`**, matching `meet.ts` — fixed
  Google hosts, still DNS-pinned like every other credentialed outbound call
  (AGENTS.md → "Outbound egress is IP-pinned").
- **Attachments go through `FileService`** in both directions — inbound
  (email attachment → `Attachment` row, accounted, thumbnailed) and outbound
  (an `Attachment` the user already has → MIME part). Never `storage.*`
  directly (AGENTS.md → "File storage & accounting").
- **Tools read Gmail/Calendar live, not `CommsEvent`.** The sync store stays
  the async index for retrieval/embedding; a tool answering "what did Jana say
  yesterday" must not depend on whether a Pub/Sub push landed. Stating this
  explicitly so nobody builds a second read path.

---

## 6. The tools

All new tools are **`requiresExplicitGrant: true` builtins** (the DeepWater
precedent) so an owner grants the Google bundle per agent in the Agent
Designer; a custom agent and the PA reach them identically. The three existing
PA-only comms tools are untouched.

### 6.1 Who the tool acts as
`resolveEffectiveUserId(context)`
([access.ts:21](worker/src/run/pa-tools/access.ts:21)) — the interactive
requester, or the PA's delegated owner. For an **unattended** run (trigger /
schedule) the acting user is the trigger's **launch-origin user**, which
already carries a captured, verifiable UOA identity and an owner-revocation
gate (`AGENTS.md` → "A capability that can stop working owns the way a person
finds out"). Rules:

- **Read tools** may run unattended under the launch-origin user. This is what
  makes "every morning, summarise my inbox" work at all.
- **Write/send tools always suspend for approval** when unattended — no
  exception, no policy override. An unattended run cannot mail your customers
  because a model changed its mind at 06:00.
- A deactivated `OrganizationMember` → refuse, reusing the existing
  `isConnectionOwnerActive` gate ([comms-sync.ts](worker/src/control/comms-sync.ts)).
- **More than one Google account** on the connection set → refuse with a
  disambiguation question naming the addresses, unless the tool was given an
  explicit `account`. Today `loadUserGoogleCommsCredential` silently picks
  *the newest connection holding the scope*, which is wrong once someone links
  work + personal. The chokepoint gains an optional `connectionId` and a
  `listUserGoogleConnections` sibling.

### 6.2 Read (safe: true)
`gmail_search`, `gmail_thread_read`, `gmail_message_read`, `gmail_labels_list`,
`calendar_list`, `calendar_events_list`, `calendar_event_read`,
`calendar_freebusy`.

### 6.3 Write (safe: false)
`gmail_draft_create`, `gmail_draft_update`, `gmail_draft_send`,
`gmail_reply_draft`, `gmail_label_apply`, `gmail_archive`,
`calendar_event_create` (with `addMeet: boolean`), `calendar_event_update`,
`calendar_event_respond`, `calendar_event_cancel`.

Gating, by default `PolicyRule` seeds (`conditions.requiresApproval: true`):

| Action | Gate |
|---|---|
| draft create/update | **none** — a draft is reversible and lives in the person's own mailbox |
| `gmail_draft_send`, `gmail_send` | **approval** — suspends the run, §8 |
| `calendar_event_create` **with attendees** | **approval** — an invite is an outbound send |
| `calendar_event_create` solo / `calendar_event_respond` | none |
| `gmail_archive`, `gmail_label_apply` | none (reversible, own mailbox) |

### 6.4 Two invariants every tool obeys

- **Disclosure sink.** Every read calls
  `context.consumedSources.add({ scopeType: 'user', scopeId: <mailbox owner> })`
  *in the same change as the read* (AGENTS.md → "A read that enters a run's
  context feeds the disclosure sink"; an empty basis means unrestricted, so
  forgetting this publishes your inbox to the room). Consequence, and it is
  the correct one: an agent that read your mail and answers in `#general`
  produces a reply **restricted to you**, with `RestrictedMessageCard`'s
  existing one-click share affordance. See §11 for the free/busy carve-out.
- **Output truncation.** Per-tool caps at the existing chokepoint
  ([tool-util.ts](worker/src/run/tool-util.ts)) — `gmail_search` 4,000 chars
  like `web_search`; `gmail_thread_read` 12,000 like `http_fetch`. An
  unbounded inbox read would eat a context window in one call.

---

## 7. Admin surfaces (Rule zero check 1: a home **and** doorways)

- **Home** — `/settings/connections` → the Google connection gains a
  **Permissions** section: one row per capability, `Granted ✓` /
  `Grant` / `Blocked`, each with its one-sentence explanation. `Grant` runs
  §4.2. `Block` writes `CommsConnection.disabledCapabilities` (enforced at the
  credential chokepoint, so a block is real even though Google's token still
  carries the scope) and the row says **"blocked locally — Disconnect to
  revoke at Google"**, never "revoked".
- **Doorway 1** — the in-chat `google_scope_request` card (§4.3). This is the
  one that matters: the capability is requested where the person is standing.
- **Doorway 2** — `comms_connect_card` gains a capability summary so the first
  connect is not silently "whatever the constant said".
- **Doorway 3** — Agent Designer's tool-grant list shows the Google bundle
  (Gmail read / compose / calendar) as grantable per agent, reusing the
  `policy-targets` merge mutation the DeepWater bundle uses.
- **Doorway 4** — an `/apps` catalog entry "Google Workspace" whose Connect
  deep-links to `/settings/connections` (it is not a generic MCP install).

---

## 8. The draft card — recipients, CC, subject, body, Send

`metadata.card = { kind: 'gmail_draft', … }`, **server-authored** (the
`metadata.runStop` precedent), written by `gmail_draft_create` /
`gmail_draft_update` in the same transaction as the message.

### 8.1 Metadata carries identifiers only
```ts
{ kind: 'gmail_draft', draftId, connectionId, ownerUserId,
  status: 'draft' | 'sent' | 'discarded', sentAt? }
```
**No recipients, no subject, no body in message metadata.** Message metadata is
readable by everyone who can read the message; putting the subject line there
would leak the one thing the disclosure system exists to protect. The card
fetches its content from `GET /api/comms/google/gmail/drafts/:draftId`, which
resolves the caller's own connection and answers an **indistinguishable 404**
for anyone else — the App Store presenter rule, applied to a draft. A
non-owner sees a generic "Email draft" chip (and in practice the whole message
is already restricted by §6.4).

### 8.2 What the owner sees
Recipients / CC / BCC / Subject / body (rendered markdown, scrollable) /
attachment chips, then:

| Button | Does |
|---|---|
| **Send** | `POST /api/comms/google/gmail/drafts/:id/send` — the *person* clicking their own button, authenticated as themselves. Not an agent action; no approval machinery. Conditional `draft → sent` claim makes double-click idempotent |
| **Edit** | inline editor → `PATCH …/drafts/:id` → re-renders |
| **Discard** | `DELETE …/drafts/:id` → card flips to "Discarded" |
| **Open in Gmail** | `https://mail.google.com/mail/u/0/#drafts?compose=<id>` |

After send: the route patches the message metadata to `status:'sent'` and
publishes `message.updated` — the **watch-status precedent**, which refreshes
the open thread without adding a row or moving an unread badge.

### 8.3 The agent-initiated send is the *same component*
When the model calls `gmail_draft_send` and the policy gate fires, the run
suspends and posts `metadata.approvalGate = { approvalId, toolName:
'gmail_draft_send', … }`. The approval card renders **`GmailDraftCard` with
`mode="approval"`** — identical draft view, buttons wired to
`POST /api/approvals/:id/resolve`. Approve → the existing verified,
args-scoped, single-use `approvalProof` → continuation run re-issues the send.
One component, two action modes (Rule zero check 4). The `argsHash` binding
means the model cannot change the recipients between approval and send.

---

## 9. Data model

One additive migration (`api/prisma/migrations/…_google_capabilities`):

```
comms_connections
  + requested_capabilities  jsonb not null default '[]'
  + disabled_capabilities   jsonb not null default '[]'
  + account_label           text null           -- "work" / "personal"
```

No new table. `granted_scopes` already exists and is already authoritative.
Approval gating uses existing `PolicyRule.conditions.requiresApproval` — seeded
rows, no schema change.

---

## 10. Phases

| Phase | Ships | Why this order |
|---|---|---|
| **P0** | Capability catalog, `/start` accepting capabilities, incremental add, `google_scope_request` card, `/settings/connections` Permissions section, `disabledCapabilities` enforcement | Pure negotiation. Zero new Google API surface, and it makes *today's* Gmail-read + Meet connection self-service. Delivers the "specify the scope / add a scope" requirement on its own |
| **P1** | Gmail read tools + disclosure sink + truncation; `gmail_draft_create/update`; `GmailDraftCard` + owner-gated draft route + human **Send** | The headline UX: "prep this email" → card → Send |
| **P2** | Calendar read, free/busy, `calendar_event_create` with `addMeet`, invite gating, `calendar_event_update/respond/cancel` | Meet-on-an-event and scheduling |
| **P3** | Agent-initiated `gmail_draft_send` behind the approval gate; `gmail_modify` tools; model auto-review for routine sends; an `email_received` trigger (extends `AgentTriggerTypeSchema`, currently `manual\|scheduled\|webhook\|event\|interval`) | Everything that needs P1+P2 in place first |

Each phase merges to `main` on its own with docs updated in the same turn.

---

## 11. Open questions — flagged, with a recommendation

1. **Free/busy vs. the disclosure sink.** Restricting every calendar-derived
   reply to one person makes "find us a slot" useless in a channel.
   *Recommendation:* free/busy is scoped `organization:<id>` (not `user:<id>`)
   when the user opts in — Google Workspace already publishes free/busy
   org-wide by default. **Event details stay `user:<id>`.** The opt-in lives
   beside the capability rows.
2. **Multiple Google accounts.** §6.1 refuses ambiguity. Alternative: a
   per-agent default account. *Recommendation:* refuse first, add a default
   later if it actually annoys people.
3. **Restricted-scope verification.** Hosted `nessie.works` needs a CASA
   assessment for `gmail.readonly`/`compose`/`modify`. Self-hosted with an
   Internal Workspace app does not. *Needs your call on which one P1 targets.*
4. **MCP interpretation** — §2. Option (c) on request.
5. **`gmail.compose` grants send.** A person who grants "draft my emails" has
   technically granted send at the Google layer. The gate is Nessie's policy.
   *Recommendation:* say this in the consent card's own words rather than
   implying Google is enforcing it.

---

## 12. Documentation to update in the same turns

`docs/plans/2026-07-21-individual-communications-connector.md` (Google section),
`docs/external-tool-integration.md`, `docs/deployment.md` (the Google Cloud
OAuth client + verification tier), `CLAUDE.md` → "Individual Communications
Connector", `AGENTS.md` → the comms bullet (capability catalog + the
send-gating invariant).
