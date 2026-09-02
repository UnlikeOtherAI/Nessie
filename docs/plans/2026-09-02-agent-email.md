# Agent email — access to existing mailboxes, or a hosted mailbox of its own

**Date:** 2026-09-02 (reframed same day; supersedes
[2026-04-07-email-integration.md](2026-04-07-email-integration.md))
**Status:** Design

---

## 1. Two models, deliberately different in size

There are two ways an agent gets email, and they are **different products**:

| | **A. Mailbox access** | **B. Hosted mailbox** |
|---|---|---|
| Transports | Gmail API; generic SMTP/IMAP | Nessie Mail relay (SES underneath) |
| Who stores the mail | The provider (Google, the IMAP server) | **Nessie** — it *is* the mailbox |
| Interface | **None.** Tools only — you ask the agent things and it operates the mailbox | A full mailbox surface: address, stored messages, inbox UI, inbound triggering the agent |
| Address identity | An existing human/shared mailbox | The agent's own `{name}@nessie.works` (or custom domain) |
| What Nessie persists | Credentials, audit, metering — no message copies | Every message, both directions |

Model A is "the agent can reach into a mailbox": *"anything new from the
bank?"*, *"reply to Petra that Thursday works"* — asked in any conversation,
answered via tools, no email UI anywhere in Nessie. Model B is "the agent has
an email identity": people CC `research@nessie.works` into a thread, the mail
arrives *in Nessie*, wakes the agent, and an actual mailbox view shows the
correspondence. The mistake to avoid is building either one with the other's
machinery — A must not grow a message store, and B cannot lean on a provider
to hold state that only Nessie has.

## 2. Model A — mailbox access (no interface)

### 2.1 Gmail

Already planned end-to-end in
[2026-08-31-google-workspace-email-calendar.md](2026-08-31-google-workspace-email-calendar.md):
P0 (OAuth connect, fail-closed capability catalog, credential chokepoint) is
built and merged; the agent-facing `gmail_*` read/draft/send tools are its
P1–P3, with the structural send gate, `requiredApproverUserId`,
content-fingerprint draft approvals, and standing send grants. **This plan
adds nothing to the Gmail lane and restates none of it.** The behaviour the
user experiences — "the agent just has access; we can ask it questions and it
can send emails if we want to" — is exactly that plan's tool surface plus the
agent's system prompt; no new interface is required or wanted.

### 2.2 SMTP/IMAP

The same experience for any non-Google mailbox (or a Google one via app
password, dodging OAuth verification — the Google plan's §11 already blessed
this as an alternate transport). Fold it into the machinery that exists
rather than beside it:

- **A new comms provider `imap_smtp`** — added in lockstep to
  `packages/comms-connect/src/provider.ts`, the Prisma `CommsProvider` enum,
  and `packages/schemas` `CommsProviderSchema` (the three move together by
  standing rule). Connections are created from `/settings/connections` like
  Slack/Google, except the form takes IMAP host/port, SMTP host/port,
  username, password instead of an OAuth dance; a connection test (IMAP
  LOGIN + SMTP EHLO/AUTH) runs before the row is written. Credentials are
  sealed with the existing `sealSecret` packing into
  `CommsConnectionCredential`. The connection is **user-owned** like every
  comms connection — a shared mailbox (e.g. `support@acme.com`) is connected
  *by a person* who takes responsibility for it.
- **One honest capability.** IMAP is all-or-nothing — whoever holds the
  password reads everything and sends as the mailbox. Modelled as a single
  `mailbox.full` capability (the Google plan's wording), never a fake
  catalog; the UI says so.
- **Tools, not sync.** The agent tool surface is the *same* mailbox tool
  family the Google plan defines, differing only in credential/transport
  resolution at the chokepoint — search/list/read run **live against IMAP**
  (`UID SEARCH`/`FETCH` on demand); send goes out over SMTP. No import into
  `CommsEvent`, no local copies (the provider is the store; a later decision
  may add opt-in import for Chief-of-Staff context, but it is not part of
  this plan). Tool naming follows the Google plan's call when IMAP lands —
  either the `gmail_*` ids gain a transport dimension or they generalise to
  `mailbox_*`; that is a one-line decision inside that tool family, decided
  there, not forked here.
- **Same permission story.** Tools are `requiresExplicitGrant: true`; sends
  ride the identical structural gate (approval bound to a content
  fingerprint, `requiredApproverUserId` = the connection owner, standing
  grants with the same duration menu). Reads may run unattended; sends never
  do without a standing grant, exactly as the Google plan rules.
- **Egress hygiene:** IMAP/SMTP are raw sockets, not HTTP, so `safeFetch`
  doesn't apply — but the same policy does: operator-supplied hosts resolve
  once and are checked against the private-range rules the MCP endpoint
  validation uses, and the connection pins the vetted addresses, so a member
  cannot point IMAP at an internal service.
- Auth failures flip the connection to `needs_reauthorization` with a
  remedy-naming reason — the existing comms status discipline, no new state
  machine.

That is the whole of Model A: one new provider row in an existing system,
one shared tool family, zero new surfaces beyond the connection form.

## 3. Model B — the hosted mailbox (Nessie is the mailbox)

Here there is no provider holding state: if Nessie doesn't keep the mail,
nobody does. So Model B is a real mailbox — **stored messages, a mailbox UI,
and an agent wired to it** — fed by a first-party relay.

### 3.1 Addresses and the Nessie Mail relay

`nessie.works` is one global namespace across every org and every self-hosted
instance, so addresses are minted by a vendor-operated **Nessie Mail relay**
(SES underneath; same product posture as Ledger). Instance configuration is
Ledger-style — `NESSIE_MAIL_RELAY_URL` + `NESSIE_MAIL_RELAY_KEY` (one
deployment-wide product-bound app key, distinct from every other configured
key, checked at startup) — and fails loudly: unset ⇒ the claim flow refuses
with `MAIL_RELAY_UNCONFIGURED` and the UI names the reason, never a dead
mailbox row.

Relay contract (the relay service lives outside this repo):

| Call | Purpose |
|---|---|
| `POST /v1/addresses` | Claim `{localPart, orgId, agentId, webhookUrl}`. First-come across the flat namespace, reserved-word list (`admin`, `postmaster`, `abuse`, …); returns full address + per-address webhook HMAC secret, or `ADDRESS_TAKEN` with suggestions. |
| `DELETE /v1/addresses/:id` | Release (quarantined, not instantly reusable). |
| `POST /v1/domains`, `GET /v1/domains/:id` | Custom-domain verification: returns DKIM CNAMEs + MX + recommended SPF/DMARC, and live status. |
| `POST /v1/send` | Outbound `{from, to, cc, bcc, subject, text, html?, inReplyTo?, references?, attachments}`; relay DKIM-signs and sends via SES, returns the provider message id. |
| Webhooks → instance | `email.inbound` (raw MIME + parsed envelope + SPF/DKIM/DMARC/spam verdicts), `email.bounce`, `email.complaint` — HMAC-signed per address. |

No AWS credentials ever enter Nessie; the relay is the only SES touchpoint.
Relay-side abuse control shapes the contract: per-instance/org outbound rate
limits, mandatory suppression handling (`RECIPIENT_SUPPRESSED` on
hard-bounced/complained recipients), spam verdicts delivered with inbound.

Custom domains (P2) are owner-only in `/settings/organization` → **Email
domains**: add `agents.acme.com`, render the relay's DNS records verbatim, a
worker sweep + "Check now" polls status, verification failure follows the
schedule-health discipline (persisted `status`/`statusReason`, one durable
`UserAlert` to owners on the transition). DMARC alignment is why customer
domains still relay through us — the relay holds DKIM keys issued at
verification, so `From: acme.com` is signed by `acme.com` keys.

### 3.2 Data model — an email store, not chat messages

Emails are **not** `Message` rows. They are their own store, because a
mailbox's semantics (folders, read state, delivery state, MIME identity,
external participants) are not a chat thread's:

```
model AgentMailbox {                 // agent_mailboxes
  id, organizationId, agentId @unique        // one mailbox per agent
  address        String  @unique             // full, lowercased; relay is the uniqueness authority
  domainId       String?                     // -> EmailDomain; null = nessie.works
  channelId      String  @unique             // backing discussion channel (§3.4)
  status         active | needs_attention | suspended | deleting
  statusReason   String?
  sendPolicy     approval | auto_reply | auto   @default(approval)
  displayName    String?                     // From: display name; defaults to agent name
  relayAddressId String
  createdByUserId, createdAt, updatedAt
}

model EmailDomain {                  // email_domains (P2)
  id, organizationId, domain @unique
  status pending_dns | verified | failed | revoked
  relayDomainId, dnsRecords Json, verifiedAt, lastCheckedAt, createdByUserId
}

model EmailConversation {            // email_conversations — one email thread
  id, organizationId, mailboxId
  subject, participants Json                 // denormalized for the list view
  threadId String @unique                    // backing Thread for runs/approvals (§3.4)
  lastMessageAt, messageCount, unreadCount
  state  open | needs_approval | muted
  @@index([mailboxId, lastMessageAt])
}

model EmailMessage {                 // email_messages
  id, organizationId, mailboxId, conversationId
  direction      inbound | outbound
  rfcMessageId   String                      // normalized; outbound = generated
  inReplyTo?, referencesIds Json
  fromAddress, fromName?, toAddresses Json, ccAddresses Json, bccAddresses Json?
  subject, textBody, htmlBody?               // html stored sanitized at ingest
  snippet        String                      // list-view preview
  authResults    Json?                       // SPF/DKIM/DMARC/spam verdicts (inbound)
  classification normal | bulk | dsn         // structural header classification
  deliveryState  queued | sent | bounced | complained | null   // outbound only
  sentByRunId?, approvalId?                  // outbound provenance
  attachment rows via the existing Attachment linking (FileService-stored)
  occurredAt, createdAt
  @@unique([mailboxId, rfcMessageId, direction])
  @@index([conversationId, occurredAt])
}
```

Pinned facts: `Agent` gets **no** email column (the presenter joins
`AgentMailbox`); one mailbox per agent (a second agent is cheap); this store
is **not** `CommsConnection`/`CommsEvent` (those are a *person's* imported
correspondence — different owner, lifecycle, and semantics); inbound
threading resolves `In-Reply-To` then `References` against
`(mailboxId, rfcMessageId)`, no hit ⇒ new conversation titled from the
subject; outbound records its generated `Message-ID` and sets threading
headers from the conversation's newest inbound message so external clients
thread correctly.

### 3.3 The mailbox surface

This is the "entire email mailbox, displayed" part — the capability's home
(Rule zero):

- **Home:** `/agents/:id/mailbox` — a two-pane mailbox: conversation list
  (subject, participants, snippet, unread, state chips like *awaiting
  approval* / *bounced*) and a reading pane rendering the messages of a
  conversation newest-last. HTML mail renders sanitized (allowlist,
  remote images blocked by default with a per-message "load images" reveal —
  tracking pixels are the default leak). Outbound messages show delivery
  state as it changes; a bounce renders on the message, not in a log.
  It reuses the content-system primitives (`QueryState`, pagination
  contract, `TabBar` for Inbox/Sent/All filters) — no bespoke kit.
- **Doorways:** the agent detail page gets an **Email** section (address or
  claim flow, status + reason, send policy, link to the mailbox); the
  sidebar lists the mailbox beside the agent's channels; the Tools page
  grant row for `email_send` names the address it acts through.
- **Composing as a human is not in scope.** The mailbox view is read +
  supervise; mail is sent by the agent through its tools. (A human "send as
  the agent" affordance is listed as later, deliberately.)

Lifecycle is owner-gated (it mints an externally visible identity):
`POST/GET/PATCH/DELETE /api/agents/:agentId/mailbox`, one service in
`@nessie/workspace-admin` so a future PA builtin mirrors the route exactly.
Deleting releases the relay address and keeps the store read-only.

### 3.4 How inbound mail wakes the agent

Inbound pipeline: public `POST /api/integrations/email/inbound` — HMAC
verified against the per-address secret (stored encrypted,
`ProductWebhookSecret` precedent), ack-fast, snapshot raw, enqueue
`email.inbound.process`. The worker job parses MIME (one parser in a new
`packages/agent-mail`, shared by ingest and send), stores attachments through
`FileService`, resolves/creates the conversation, writes the `EmailMessage` —
then wakes the agent.

Runs need a thread, and approvals/reports need somewhere to live, so each
mailbox keeps **one backing channel** (`systemChannelType: 'agent_email'`,
visibility following the agent — team-visible for workspace agents,
owner-only for private ones) with **one `Thread` per `EmailConversation`**
(the `threadId @unique` link above). The thread is the conversation's
*operations room*, not the mail itself:

- A new inbound `normal`-classified email posts a compact server-authored
  reference message into its thread (sender, subject, link into the mailbox
  view) and dispatches a run through the existing claim-or-pend discipline —
  per-conversation serialization for free. Email addressed to the agent is
  **structural engagement**; the model decides *what to do*, never whether
  string-matching says it was spoken to.
- `bulk`/`dsn`-classified mail (from `Auto-Submitted`, `Precedence:
  bulk/list`, `List-Id`, null return-path — structural header facts, not
  content heuristics) is stored and shown in the mailbox but starts **no
  run**: registered, no spend, no reply loops. Spam-verdict-failed mail
  likewise stores flagged, run-less.
- The run's context carries the conversation's emails (rendered from the
  store, inventory-line style for attachments); its reply to the outside
  world is an `email_send` tool call, and its final chat text lands in the
  thread as the work report. Humans discuss with the agent in that thread;
  approval gate messages appear there; nothing a human types becomes
  outgoing mail.
- Inbound email content is untrusted third-party content and is framed as
  such in the prompt; instructions inside mail are data.

If a *different* agent should react to incoming mail, that is the existing
event-trigger machinery (`POST /api/events` with an `email_received`
eventType — the shape the Google plan reserved), not a second wake path.

### 3.5 Sending — permission layered, default is a human approves

The tools live beside the existing comms builtins
(`packages/runtime/src/builtin-comms-tools.ts`; handlers
`worker/src/run/pa-tools/agent-email.ts`), **not** `personalAssistantOnly` —
any agent with a mailbox and the grant:

- `email_send` (`requiresExplicitGrant: true`, `safe: false`) —
  `{to[], cc?, bcc?, subject?, text, attachmentIds?}`. Called from an email
  conversation's backing thread it defaults to replying there (recipients
  and `Re:` subject prefilled, threading headers set); called elsewhere with
  explicit recipients it starts a new conversation (which appears in the
  mailbox as Sent). Attachments must already be reachable to the run.
- `email_read` / `email_list` (`safe: true`, no grant) — the agent reading
  **its own** mailbox store, so *"what's in your inbox?"* works from any
  conversation the agent is in, not only the backing channel. Scoped to the
  run's agent's mailbox, nothing else's; reads feed the disclosure sink like
  every other read.

Permission layers, all reusing existing mechanisms:

1. **Explicit tool grant** per agent from the Tools page
   (`toolPolicy['email_send'] === true`; Agent Designer already filters
   explicit-grant keys).
2. **`AgentMailbox.sendPolicy`**:
   - `approval` (default) — every send suspends via the existing
     `waiting_approval` machinery, gate message in the conversation's
     thread, approval bound to a **content fingerprint** (sha256 over
     canonical recipients/subject/body/attachment ids — the Google plan's §9
     discipline, shared not forked), `requiredApproverUserId` pinned to the
     agent's steward (fallback `requiredApproverRole: owner`).
   - `auto_reply` — replies within an existing conversation send
     immediately; new outbound conversations still park an approval. The
     support-bot mode.
   - `auto` — everything sends. Owner-set only, risk stated in the UI.
3. **Structural floors no policy relaxes:** unattended runs may send only
   under `auto_reply`/`auto` and only as replies (an unattended new
   conversation always parks an approval); suppressed recipients refuse;
   per-mailbox rate cap (`NESSIE_AGENT_MAIL_MAX_SENDS_PER_HOUR`, default 30)
   parks overflow as approvals rather than dropping; auto sends stamp
   `Auto-Submitted: auto-replied`; ≥ N auto-replies per conversation per
   hour (default 4) degrades that conversation to `approval` for the window;
   and a run whose reply basis is restricted (`runReplyIsRestricted`) cannot
   `email_send` at all — content with a limited audience inside Nessie is
   never mailed out of it.

### 3.6 Metering, audit, limits

- `enum ConnectorType` gains `email`; every send and processed inbound
  writes `recordConnectorUsage` (`operation: 'send' | 'receive'`, full
  attribution, **no cost fields** — commercial rating of relay usage is
  UOA's, per the standing rule). Model A's SMTP/IMAP tool calls meter
  through the same member.
- Every send writes an `AuditLog` entry (approval id when one existed);
  bounces and complaints audit too.
- Inbound attachments ride storage quota/accounting by construction
  (FileService). `NESSIE_AGENT_MAIL_MAX_INBOUND_BYTES` (default 25 MiB) —
  oversize mail stores a stub naming the reason.

## 4. Phasing

**P1 — hosted mailbox core (Model B).** Schema (`AgentMailbox`,
`EmailConversation`, `EmailMessage`, `agent_email` channel type),
`packages/agent-mail`, relay claim + inbound route + worker pipeline, the
mailbox UI + agent-detail Email section, backing channel/threads + run
dispatch, `email_send` under `approval` policy + `email_read`/`email_list`,
ConnectorType + audit. Mock relay for tests; Playwright on the surfaces.

**P2 — domains + autonomy.** `EmailDomain` + relay verification + settings
surface + health alerts; `auto_reply`/`auto` with the structural floors;
outbound attachments; bounce/complaint rendering.

**P3 — SMTP/IMAP access (Model A).** `imap_smtp` comms provider + connection
form + test + sealed credentials, live IMAP/SMTP tools joining the Google
plan's mailbox tool family and send-gate machinery (which is that plan's
P1 — sequence accordingly), egress hygiene.

**Later, deliberately unplanned:** human "send as the agent" from the
mailbox; multiple mailboxes per agent; opt-in IMAP import into `CommsEvent`
for Chief-of-Staff context; Gmail-as-agent-owned-transport (SMTP/IMAP with
an app password already covers it).

## 5. Superseded

[2026-04-07-email-integration.md](2026-04-07-email-integration.md) sketched
the SES model before the comms stack, trigger/delivery model, approval
machinery, `FileService`, and secret store existed; its address scheme,
BYO-SES AssumeRole path, `agents.email` column, and bespoke `integrations`
table are all replaced here. An earlier same-day revision of *this* document
mapped hosted-mailbox email conversations directly onto chat messages; that
is replaced by the split above — access = tools with no interface, hosted =
a real stored mailbox with its own surface.
