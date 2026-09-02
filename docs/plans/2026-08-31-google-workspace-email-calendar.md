# Google Workspace in chat — Gmail, Calendar, Meet, negotiated scopes

Date: 2026-08-31 (v2 — rewritten after cross-model review)
Status: **P0 built and merged; P1–P3 planned**

> **P0 shipped 2026-08-31.** Capability catalog, capability-aware OAuth start,
> incremental grant, bound OAuth state, all-of + local-block enforcement at the
> credential chokepoint, and the Permissions section on `/settings/connections`.
> It also closed the three live fail-open defects the review found (§4.4, §4.5,
> §4.6). `account_label` from §12 was cut as speculative — nothing read it.
> Verified against a clean database: full migration chain applied, 1,853 tests
> green (api 1056, worker 797), and the Permissions UI exercised end to end
> including a block round-tripping to the database and an audit row.

Goal: a person, their Personal Assistant, or a granted custom agent can — **from
a chat message** — search and read mail, draft and send email, read and write
the calendar, and create Google Meet meetings. OAuth scopes are chosen up
front, and any missing scope is requested and granted **in the same
conversation**. A composed email appears in chat as a card showing recipients,
CC, subject and body, with a Send button. A person may grant standing consent
so agents can send on their behalf **when asked** without approving each one.

> ## Review outcome (Fable + kimix + Codex Sol, 2026-08-31)
>
> v1 was reviewed by three models and **was not implementation-ready**. The
> direction held — first-party builtins, one Google credential store, live
> reads, disclosure provenance — but the send path was neither owner-bound nor
> content-bound, and four OAuth/Gmail assumptions were false. Every finding
> below was re-verified against the tree before acceptance; two reviewer claims
> were rejected as wrong (recorded in §14).
>
> **Blockers that changed the design:**
> 1. **The send gate failed open.** `evaluateToolInvokePolicy` uses
>    `defaultVerdict: 'allow'` ([policy.ts:136](worker/src/run/execute/policy.ts:136))
>    and default seeding writes no send rule with no backfill
>    ([policy.ts:266](api/src/services/policy.ts:266)) — so gating by seeded
>    `PolicyRule` rows leaves every existing org sending ungated. → §7.1 makes
>    the gate **structural in the tool definition**.
> 2. **Anyone who can see the channel could approve a send as you.**
>    `approvalVisibilityWhere` passes any member of a **public** channel
>    ([approvals.ts:85](api/src/services/approvals.ts:85)) and gates resolution
>    on the same predicate ([approvals.ts:170](api/src/services/approvals.ts:170)).
>    `requesterId` is the **agent** ([tool-authorization.ts:259](worker/src/run/execute/tool-authorization.ts:259)),
>    so the SELF_APPROVAL check never fires for a user, and `ApprovalRequest`
>    has `requiredApproverRole` but **no required user**. → §7.2 adds
>    `requiredApproverUserId`.
> 3. **`argsHash` binds the draft id, not the draft.**
>    `hashJsonValue(args)` ([policy.ts:123](worker/src/run/execute/policy.ts:123))
>    over `{draftId}` says nothing about recipients or body, and the draft stays
>    mutable. → §9 adds a durable draft projection with a content fingerprint.
> 4. **`grantedScopes` is not fail-closed.** `parseScopeString` returns the
>    **requested** scopes when the token response omits `scope`
>    ([connector.ts:29](packages/comms-google/src/connector.ts:29)), so a
>    connection can record authority Google never granted. → §4.4.
> 5. **`users.getProfile` blocks every non-Gmail capability set.** Connect calls
>    it unconditionally ([connector.ts:66](packages/comms-google/src/connector.ts:66));
>    it does not accept `gmail.send`, Calendar or Meet scopes, so a
>    Calendar-only or send-only connection fails at connect. → §4.5 takes
>    identity from the OIDC `id_token`.
> 6. **Every 403 is retried** ([http.ts:33](packages/comms-google/src/http.ts:33)),
>    so Gmail's `insufficientPermissions` would loop instead of raising the
>    scope card — breaking the "ask for a scope in chat" requirement outright.
>    → §4.6.
>
> **Corrections to v1's own claims:** explicit-grant builtins are **filtered out
> of Agent Designer** and granted from the Tools page, not via
> `/api/mcp/tools/:id/policy-targets` (that route is keyed by
> `toolRegistryEntryId`, an MCP row — [tools.ts:251](api/src/routes/mcp/tools.ts:251));
> `metadata.approvalGate` has **no admin renderer at all** (zero hits in
> `admin/src`), so the approval card is unbuilt work, not a re-skin; a withheld
> message carries **no metadata** ([messages.ts:129](api/src/services/messages.ts:129)),
> so the "generic draft chip for non-owners" is impossible and the standard
> restricted placeholder is what they get; the free/busy `organization:` carve-out
> was **unsafe** (a Nessie org is not a Google Workspace domain) and is
> withdrawn; `email_received` is an `event` **eventType**, not a new enum member
> ([trigger-events.ts:19](worker/src/control/trigger-events.ts:19)); and
> `api/src/routes/comms-connections.ts` is already **493 lines**, so P0 splits it
> before adding anything.
>
> **Out of scope by direction:** IP-pinning/`safeFetch` for the Google
> connector. Reviewers raised it; it is not part of this work.

---

## 1. What exists today (verified)

| Piece | Where | State |
|---|---|---|
| Google OAuth start | [oauth-config.ts:52-70](api/src/routes/comms/oauth-config.ts:52) | PKCE + `access_type=offline` + `include_granted_scopes=true`; **scope list is a hardcoded constant** |
| OAuth state | [comms-connections.ts:150](api/src/routes/comms-connections.ts:150) | Carries **only** `redirectUri` + PKCE verifier — no target connection, no expected identity, no capabilities |
| Per-user connection + encrypted tokens | Prisma `CommsConnection` / `CommsConnectionCredential` | Live; `grantedScopes` **fails open** (§4.4) |
| Credential chokepoint | [`loadUserGoogleCommsCredential`](packages/workspace-admin/src/comms-credential-coordinator.ts:196) | Live. Takes **one** `requiredScope`; picks the newest active connection holding it |
| Gmail adapter | [`packages/comms-google`](packages/comms-google/src) | **Read-only.** No send, no drafts, no modify |
| Meet | [`createGoogleMeetSpace`](packages/comms-google/src/meet.ts:34) | Live — standalone space only |
| Meet in chat | `meeting_link_create`, `call_start` | Live, [PA-only](packages/runtime/src/builtin-comms-tools.ts:44) |
| Approval suspend/resume | [approval-suspend.ts](worker/src/run/execute/approval-suspend.ts) + [approval-resume.ts](api/src/services/approval-resume.ts) | Landed 2026-08-31. **No admin renderer** |
| Standing-consent precedent | [`ScopeDisclosureGrant`](api/prisma/schema.prisma:1896) + duration menu [RestrictedMessageCard.tsx:16](admin/src/components/features/channels/RestrictedMessageCard.tsx:16) | Live — reused verbatim in §8 |
| Disclosure sink | [disclosure-basis.ts:27](worker/src/run/execute/disclosure-basis.ts:27) | Live. **Empty basis = unrestricted** |
| **Calendar** | — | **Does not exist** |
| **Gmail write** | — | **Does not exist** |

## 2. Decision: what "MCP-enabled" means here

Nessie is an MCP **client**; the JSON-RPC server was removed with the legacy
tree. Chosen: **first-party builtin tools** reusing the one Google credential
store, the disclosure sink, `FileService`, and the approval gate. A third-party
Google MCP connector would mint a *second* encrypted Google credential beside
`comms_connection_credentials` and could feed neither the provenance sink nor
`FileService` — the fork Rule zero forbids, on the most sensitive credential in
the product.

Honest caveat (Sol): builtins are **not** identical to MCP tools in grant and
catalog behaviour — separate registries and keyspaces, and explicit-grant
builtins are filtered out of Agent Designer (§10). The capability catalog plus
the Tools-page grant **is** the replacement governance story and must be built,
not assumed. Exposing these outward to an external MCP client is a separate
capability (option (c)); the functions live in `@nessie/comms-google` +
`@nessie/workspace-admin` so that stays open.

## 3. Scopes are a capability catalog

New `packages/schemas/src/google-capabilities.ts` — one source of truth for API,
worker and admin.

| id | Google scope(s) | Tier | Enables |
|---|---|---|---|
| `gmail.read` | `gmail.readonly` | restricted | search, read threads, labels, attachments |
| `gmail.compose` | `gmail.compose` | restricted | drafts **and** `drafts.send` |
| `gmail.send` | `gmail.send` | sensitive | `messages.send` **only** — cannot touch drafts |
| `gmail.modify` | `gmail.modify` | restricted | labels, archive, trash |
| `calendar.read` | `calendar.readonly` | sensitive | calendars, events |
| `calendar.freebusy` | `calendar.freebusy` | sensitive | availability only — **its own narrow scope** |
| `calendar.write` | `calendar.events` | sensitive | create/update/cancel, invite (**also grants event reads**) |
| `meet.create` | `meetings.space.created` | sensitive | standalone Meet space |
| `contacts.read` | `contacts.readonly`, `directory.readonly` | sensitive | resolve "email Jana" → an address |

Four facts the catalog states in its own copy:

- **`gmail.send` cannot create or send a draft.** `drafts.create`/`drafts.send`
  accept `gmail.compose` or `gmail.modify` only. So the draft-card flow needs
  `gmail.compose`; `gmail.send` backs a separate direct-send tool (§6.3).
- **Google has no "drafts but cannot send" scope** — `gmail.compose` grants
  both. The draft/send separation is enforced by **Nessie's structural gate**
  (§7), never by OAuth. The consent copy says this rather than implying Google
  enforces it.
- **The internal-use exception is narrow.** Restricted Gmail scopes skip the
  CASA assessment only when all users are in the **same** Workspace/Cloud
  Identity org, the Cloud project is owned by that org, **and** the consent
  screen is Internal — not merely because Nessie is self-hosted. Recorded in
  `docs/deployment.md`. Tiers must be re-confirmed against Google's current
  verification FAQ before P1; Google moves them.
- **Google cannot partially revoke.** `/revoke` kills the whole grant, so a
  per-capability "remove" is a **local block** (§4.7) and the UI says
  "blocked locally — Disconnect to revoke at Google", never "revoked".

## 4. Scope negotiation

### 4.1 Connect with a chosen set
`POST /api/comms/connections/google/start` takes `{ capabilities[] }`, validated
against the catalog. Omitted → today's exact list, byte-identical.

### 4.2 Add to a live connection
Same route with `{ capabilities, connectionId }`. Requests
`grantedScopes ∪ requested`; `include_granted_scopes=true` (already set) returns
the union. `prompt=consent` becomes **conditional**, not unconditional — it is
not required merely because a scope is new, and the design must not assume a new
refresh token comes back (Sol).

### 4.3 Ask from inside the chat ← the requirement
`requireGoogleCapability(context, capabilityId)` in the worker: resolve the
acting user, call the chokepoint with **all** the capability's scopes; on
failure post a server-authored
`metadata.card = { kind: 'google_scope_request', capabilityId, … }` and refuse
to the model in words. `GoogleScopeRequestCard` shows the label, the one-sentence
explanation and a **Grant** button running §4.2. The card is stamped with the
mailbox owner's basis (§6.4) so it cannot leak into a shared room.

### 4.4 `grantedScopes` must become fail-closed
[connector.ts:29](packages/comms-google/src/connector.ts:29) returns the
**requested** scopes when the token response omits `scope`, recording authority
Google never granted. Fix in P0: a missing/empty `scope` is an **error**, not a
fallback. This is the foundation every capability check stands on.

### 4.5 Identity comes from the `id_token`, not Gmail
Connect calls `users.getProfile` unconditionally
([connector.ts:66](packages/comms-google/src/connector.ts:66)), which requires a
Gmail read scope — so a Calendar-only, send-only or Meet-only connection **fails
at connect today**. That alone would sink capability selection. `openid email
profile` is already requested: take `externalUserId`/`externalTenantId` from the
validated OIDC `id_token`, and call `getProfile` only when a Gmail read scope is
actually present.

### 4.6 `insufficientPermissions` must fail closed
[http.ts:33](packages/comms-google/src/http.ts:33) treats **every** 403 as
retryable, so a scope error would be retried until the job dies and the scope
card would never appear. Classify Google's structured `reason`: only
quota/rate-limit reasons retry; `insufficientPermissions` returns a typed
scope-missing result that raises §4.3.

### 4.7 OAuth state must bind its target
The state row carries only `redirectUri` + PKCE
([comms-connections.ts:150](api/src/routes/comms-connections.ts:150)), and the
callback persists whichever Google account completed consent
([comms-connections.ts:237](api/src/routes/comms-connections.ts:237)). Add:
target `connectionId`, **expected Google subject**, the requested capability
set, and the originating card `messageId`. A different account → create a
separate connection or refuse; **never silently re-point an existing mailbox**.
The card id is what lets the callback publish the promised `message.updated`.

Local blocks live in `CommsConnection.disabledCapabilities` and are enforced
**at the chokepoint**, which gains `requiredScopes: string[]` (all-of) plus the
block filter — and are re-checked at click time in the send route, since a
blocked capability's Google scope is still live.

## 5. Provider layer

`api/src/routes/comms-connections.ts` is **493 lines** — P0 splits it (OAuth
start/callback vs connection management) *before* adding anything. `client.ts`
(266 lines) is split, not grown.

```
src/gmail/     drafts.ts  send.ts  mime-build.ts  threads.ts  attachments.ts
src/calendar/  calendars.ts  events.ts  freebusy.ts  conference.ts
src/contacts/  people.ts
```

Calendar conferencing needs more than `conferenceDataVersion=1`: a freshly
generated conference `requestId`, handling of the **`pending`** response with
polling to success/failure, explicit `sendUpdates`, and durable idempotency for
retried inserts (prefer a deterministic client-supplied event id).

Attachments go through `FileService` both ways — but `openStream` checks
**organization only** ([files/index.ts:105](packages/runtime/src/files/index.ts:105)),
so an outbound attachment id must be access-proved separately, as the existing
attachment tool does ([attachments.ts:159](worker/src/run/pa-tools/attachments.ts:159)).
Inbound attachments need an owning message, a retention rule and a doorway, or
they are unreachable rows (Rule zero). Byte/count caps, streaming MIME
construction, sanitised filenames and headers, and a disclosure stamp for any
attachment content entering the run.

Tools read Gmail/Calendar **live**; the `CommsEvent` store stays the async index.

## 6. The tools

All new tools are `requiresExplicitGrant: true` builtins.

### 6.1 Who the tool acts as
`resolveEffectiveUserId` — the interactive requester, or the PA's delegated
owner. Unattended runs use the trigger's launch-origin user. Reads may run
unattended; **writes and sends never do** (§7.1). Deactivated member → refuse,
via a membership-liveness check like `resolveActingMember`'s, not the sync
loop's warn-and-skip. More than one Google account → refuse with a
disambiguation naming the addresses; the chokepoint gains an optional
`connectionId` and a `listUserGoogleConnections` sibling scoped
`organizationId + ownerUserId`.

### 6.2 Read (safe: true)
`gmail_search`, `gmail_thread_read`, `gmail_message_read`,
`gmail_attachment_read`, `gmail_labels_list`, `calendar_list`,
`calendar_events_list`, `calendar_event_read`, `calendar_freebusy`,
`contacts_search`.

### 6.3 Write (safe: false)
`gmail_draft_create`, `gmail_draft_update`, `gmail_draft_send`, `gmail_send`
(direct, `messages.send`), `gmail_reply_draft`, `gmail_label_apply`,
`gmail_archive`, `calendar_event_create` (`addMeet`), `calendar_event_update`,
`calendar_event_respond`, `calendar_event_cancel`.

### 6.4 Invariants
- **Reads feed the sink**: `user:<mailbox owner>`, in the same change as the
  read. Consequence, and it is correct: an agent that read your mail and answers
  in `#general` produces a reply restricted to you, with the existing share
  affordance.
- **Cards carry their own basis.** A draft card, scope-request card or approval
  notice can be posted *before any read*, leaving the sink empty and the message
  **unrestricted** — leaking owner id, connection id, draft id and the fact of a
  send into a shared room. Every mailbox-associated card is inserted with an
  explicit `user:<connection owner>` basis independent of prior reads.
- **Free/busy stays `user:<owner>`.** v1's `organization:` carve-out is
  withdrawn: a Nessie organisation is not proof of a shared Google Workspace
  domain, so Google's own sharing defaults cannot be translated into a Nessie
  entitlement. Widening needs a separate explicit, validated sharing grant.
- **Output caps** wired per tool at the existing chokepoint (the 32,000 default
  is not a cap); plus a size cap on **outbound** MIME bodies.
- Unattended runs must target the owner's own thread — a trigger can target any
  thread ([schema.prisma:2460](api/prisma/schema.prisma:2460)), and a restricted
  summary posted to a shared channel is visible to nobody but the owner.

## 7. Sending is a structural, owner-bound gate

### 7.1 Structural, not seeded
`defaultVerdict: 'allow'` + no send rule in default seeding means a
`PolicyRule`-based gate is **absent** in every existing org. The send tools
therefore carry the requirement **in the tool definition** — the way
`requiresExplicitGrant` is code, not data — so an org with no rows still gates.
`PolicyRule` may *loosen* (auto-review) but never silently omit.

### 7.2 Only the mailbox owner may approve
`ApprovalRequest` gains **`requiredApproverUserId`**, set to the live connection
owner for send gates and enforced in `resolveApprovalRequest` beside the existing
role check. Without it, any member who can read a public channel can approve an
email sent as you. `requesterId` stays the agent; the owner is not the requester,
so self-approval is correctly permitted for the person whose mailbox it is.

### 7.3 Expiry
The 30-minute default ([tool-authorization.ts:215](worker/src/run/execute/tool-authorization.ts:215))
kills a 06:00 unattended send before anyone wakes, silently. Send approvals get
a longer configurable expiry **and** a durable `UserAlert` on both raise and
expiry, so a stopped send is discoverable — the "a capability that can stop
working owns the way a person finds out" rule.

## 8. Standing consent — "send on my behalf when I ask"

Modelled verbatim on [`ScopeDisclosureGrant`](api/prisma/schema.prisma:1896):
exact-key lookup, no wildcard, no inheritance, no fallback.

**`SendAuthorizationGrant`**, keyed exactly on `(connectionId, agentId)`, with
the existing duration menu (`10m | today | 30d | forever`), defaulting to 30
days. Consenting for the PA implies nothing about a custom agent; one mailbox
implies nothing about another.

Asked in three places, one component:
1. **After the Google grant returns** — "You've granted send. Would you like
   agents to send email on your behalf when you ask them to, without approving
   each one?" A Nessie policy question, so it cannot ride Google's consent screen.
2. **On the approval card** — a third action: *Approve, and don't ask again* with
   the duration dropdown. The `RestrictedMessageCard` idiom: settle this one, or
   stand up a rule, with a real email in front of you.
3. **`/settings/connections`** — grants listed with agent, expiry, Revoke. The
   home; the other two are doorways.

**What a grant never covers:** an unattended run (always suspends); a requester
who is not the mailbox owner; the content fingerprint check (§9); the Google
scope; the per-agent tool grant. Four independent keys. Every send under a grant
writes an audit entry naming the grant id.

**Undo.** Because the grant removes the pre-send gate, dispatch is held ~15s
(configurable) with **Undo** on the card. Gmail's Undo Send is a UI trick, not
an API feature — the API sends immediately — so holding it is the only way to
make an agent send recoverable.

## 9. The draft card

### 9.1 A durable draft projection
`GmailDraftAction`: `organizationId`, `ownerUserId`, `connectionId`, provider
`draftId`, `contentFingerprint` (sha256 over canonical to/cc/bcc/subject/body/
attachmentIds), `revision`, `state` (`draft | sending | sent | discarded`),
`sentAt`, `messageId`. This is where the conditional `draft → sending → sent`
claim lives — v1's "no new table" had nowhere authoritative to make it, and no
way to bind approval to content.

### 9.2 Approval binds content, not the id
The approval records the `contentFingerprint` **and** `revision` at creation.
Every send path — the agent tool **and** the human Send route — re-reads and
compares before dispatch, refusing on mismatch. That closes both races: the
model editing after approval, and the draft changing between render and click.
`gmail_draft_update` therefore stays ungated: an edit simply invalidates the
approval and the model must ask again.

### 9.3 One shared service, two callers
`sendDraftForUser` in `@nessie/workspace-admin` owns tenant + connection checks,
disabled-capability enforcement, fingerprint verification, the state claim,
idempotency, audit and the provider call. The API route and the worker tool both
call it — `api/src/services/*` is unreachable from the worker, so this is the
route-mirroring rule, not a preference.

### 9.4 What the card carries
Message metadata carries **identifiers only** — `draftId`, `connectionId`,
`ownerUserId`, `state`. Content is fetched from an owner-gated
`GET /api/comms/google/gmail/drafts/:draftId` that 404s indistinguishably for
everyone else. A non-owner sees the **standard restricted placeholder**, not a
draft-specific chip: a withheld message carries no metadata at all
([messages.ts:129](api/src/services/messages.ts:129)), so a custom chip is not
renderable.

Owner sees to/cc/bcc/subject/body/attachments, then **Send** (or **Undo** while
held) / **Edit** / **Discard** / **Open in Gmail** — the last treated as
best-effort, since `mail/u/0` can select the wrong account and the compose deep
link is an undocumented route.

### 9.5 The approval card must be built
`metadata.approvalGate` carries no draft id, `resumeState` is deliberately never
presented, and **no admin component renders it** — so an owner-only
approval→draft projection endpoint plus the card itself are new work in P1, not
a re-skin. It renders `GmailDraftCard` in `mode="approval"`.

## 10. Surfaces

- **Home** — `/settings/connections`: capability rows (granted / grant / blocked
  locally), standing send grants, connected accounts.
- **Doorway 1** — the in-chat `google_scope_request` card.
- **Doorway 2** — `comms_connect_card` gains a capability summary.
- **Doorway 3** — **the Tools page** ([ToolsPage.tsx:231](admin/src/pages/ToolsPage.tsx:231)),
  not Agent Designer: explicit-grant builtins are filtered out of the Designer
  catalog ([tool-catalog.ts:85](admin/src/facades/designer/tool-catalog.ts:85)),
  and the `policy-targets` route is keyed by `toolRegistryEntryId` (an MCP row).
  Granting an explicit-grant **builtin** writes its tool id into
  `Agent.toolPolicy` through a dedicated service, because generic agent PUT
  strips protected keys.
- **Doorway 4** — Google as a **managed integrated-product catalog row** whose
  `/apps` card directs to Connections, parameterising the existing presenter
  ([app-card-presentation.ts:135](admin/src/components/features/apps/app-card-presentation.ts:135)).
  A hard-coded standalone entry would fork the catalog.

## 11. Alternate transport — SMTP/IMAP (optional)

`gmail.send` is *sensitive*, so **sending does not need the CASA assessment**;
reading (`gmail.readonly`) and drafts (`gmail.compose`) do. SMTP-for-send alone
therefore solves a problem we do not have.

What *does* dodge verification is **SMTP + IMAP with a Google App Password** —
no OAuth scope for read or send. The cost is that it defeats this plan's centre:
an app password is **all-or-nothing full-mailbox access**, so there is no
capability catalog, no incremental grant, and no in-chat "grant me send". It also
needs 2-Step Verification, Workspace admins can disable it org-wide, there is no
Pub/Sub push (IMAP IDLE), no drafts API (IMAP `APPEND`), and **no Calendar or
Meet at all**.

Recommendation: OAuth stays primary; SMTP/IMAP is an explicit alternate
transport behind the same tools — same `gmail_*` surface, different credential
resolution at the chokepoint — modelled honestly as a single `mailbox.full`
capability. The credential lives in the existing encrypted
`CommsConnectionCredential` shape and is never returned to the browser. Distinct
from [the SES plan](docs/plans/2026-04-07-email-integration.md), which gives
*agents* their own addresses: send-as-you and send-as-the-agent are different
products and must not share a code path.

## 12. Data model

Additive migration:

```
comms_connections        + requested_capabilities jsonb default '[]'
                         + disabled_capabilities  jsonb default '[]'
                         + account_label          text null
approval_requests        + required_approver_user_id uuid null   (§7.2)
gmail_draft_actions      new table                               (§9.1)
send_authorization_grants new table                              (§8)
```

## 13. Phases

| Phase | Ships |
|---|---|
| **P0** ✅ | Split `comms-connections.ts`; **fail-closed `grantedScopes`**; identity from `id_token`; 403 reason classification; OAuth state binding; capability catalog; `/start` with capabilities; incremental add; `google_scope_request` card; Permissions section; `disabledCapabilities` enforcement; multi-scope chokepoint |
| **P1** | Gmail read tools + sink + caps; `gmail_draft_create/update`; `GmailDraftAction`; `sendDraftForUser`; `GmailDraftCard` + owner-gated route + human **Send**; `requiredApproverUserId`; structural send gate; the approval card |
| **P2** | Calendar read, free/busy, `calendar_event_create` with `addMeet` (requestId + pending polling + idempotency), update/respond/cancel; contacts; attachments both ways |
| **P3** | Standing `SendAuthorizationGrant` + undo window; `gmail_send` direct; `gmail.modify` tools; auto-review; `email_received` as an **`event` eventType** |

The "optional SMTP/IMAP transport" formerly listed in P3 is **ceded to
[2026-09-02-agent-email.md](2026-09-02-agent-email.md) Model A** (a
first-party native connector with user/team scopes). §11's analysis stands —
same tool family, transport resolved at the credential chokepoint — but the
build belongs to that plan, so the two are never implemented twice.

P0 is pure negotiation and correctness — it fixes three live fail-open defects
and makes today's connection self-service before any new Google surface lands.

## 14. Reviewer claims rejected

- **"The approval flow is uncompletable by the asker" (kimix).** False:
  `requesterId` is the agent ([tool-authorization.ts:259](worker/src/run/execute/tool-authorization.ts:259)),
  so SELF_APPROVAL never fires for a user, and in a DM the owner passes the
  channel-membership arm of `approvalVisibilityWhere`. The real defect is the
  **inverse** — the approver set is too broad (§7.2).
- **"`email_received` correctly extends the trigger enum" (kimix).** The `event`
  type already matches a configurable `eventType`
  ([trigger-events.ts:19](worker/src/control/trigger-events.ts:19)); a new enum
  member forks that dispatch.
- **safeFetch / IP pinning for the Google connector (kimix BLOCKER, Sol MAJOR).**
  Ruled out of scope by direction.

## 15. Verification

Coverage required before P1 merges: absent / malformed / partially-declined
scopes; all-of scope enforcement and local blocks; cross-user, cross-account and
cross-org draft access; non-owner approval attempts; draft modified after
approval; concurrent and double send; standing-grant boundaries (unattended,
non-owner, expired, revoked); restricted cards and SSE behaviour; custom agent
vs PA; Google 401/403 reason classification; Calendar retry/idempotency and the
conference `pending` state; and Playwright runs over connect, incremental scope
grant, draft, Send, Edit, approval, and the withheld view.

Intent fixtures must include non-English, slang and misspelled inputs.

## 16. Docs to update in the same turns

`docs/plans/2026-07-21-individual-communications-connector.md`,
`docs/plans/2026-08-11-disclosure-boundaries-build.md` (register the new read
paths in its sink inventory), `docs/external-tool-integration.md`,
`docs/deployment.md` (Google Cloud OAuth client + the exact internal-use
conditions), `CLAUDE.md` → "Individual Communications Connector", `AGENTS.md` →
the comms bullet (capability catalog + the structural send gate).
