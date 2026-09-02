# Agent email — access to existing mailboxes, or a hosted mailbox of its own

**Date:** 2026-09-02 (reframed twice same day; supersedes
[2026-04-07-email-integration.md](2026-04-07-email-integration.md))
**Status:** Design

---

## 1. Two models, deliberately different in size

There are two ways an agent gets email, and they are **different products**:

| | **A. Mailbox access** | **B. Hosted mailbox** |
|---|---|---|
| Transports | Gmail API; generic SMTP/IMAP | Amazon SES, integrated directly, deployment-configured |
| Who stores the mail | The provider (Google, the IMAP server) | **Nessie** — it *is* the mailbox |
| Interface | **None.** Tools only — you ask the agent things and it operates the mailbox | A full mailbox surface: address, stored messages, inbox UI, inbound triggering the agent |
| Address identity | An existing human/shared mailbox | The agent's own `{name}@{deployment domain}` (`nessie.works` on the hosted deployment) |
| Configured by | A person or team connecting a mailbox (native connector) | The deployment operator, via environment variables |
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

### 2.2 SMTP/IMAP — a core native connector, scoped per user or per team

The same experience for any non-Google mailbox (or a Google one via app
password, dodging OAuth verification — the Google plan's §11 already blessed
this as an alternate transport). It ships as a **first-party native
connector** with the DeepWater posture — a built-in integration on the
Integrations surface, not a community catalog entry and not a bare settings
form — but unlike DeepWater it projects **builtin** tools, not MCP ones;
there is no MCP transport, no external product, no Ledger leg.

- **Two install scopes, following the established MCP scope rules** (owners
  manage all scopes, admins the shared scopes, members their own):
  - **User scope** — a person connects a personal mailbox. Its tools resolve
    only when the effective user of the run is that person (the Google
    plan's `resolveEffectiveUserId` discipline: interactive requester, or
    the PA's delegated owner) — the same reach as a user-scoped MCP install.
  - **Team scope** — an owner/admin connects a shared mailbox
    (`support@acme.com`) for a team. Any agent running in that team can
    reach it, **if** that agent holds the explicit tool grant. Installing is
    not granting, exactly as everywhere else.
- **Storage:** a `MailboxConnection` row —
  `{id, organizationId, scopeType user|team, scopeId, label, imapHost/Port,
  smtpHost/Port, username, secretCiphertext (sealSecret packing), status
  active|needs_reauthorization|disabled, statusReason, createdByUserId}` with
  `@@unique([organizationId, scopeType, scopeId, username, imapHost])`.
  Deliberately **not** a `CommsConnection` (those are strictly
  user-owned import connections; a team scope does not fit their unique
  key), and not an `McpServerInstance` (nothing here speaks MCP). A
  connection test (IMAP LOGIN + SMTP EHLO/AUTH) must pass before the row is
  written; later auth failures flip `needs_reauthorization` with a
  remedy-naming reason, never silent retry-forever.
- **One honest capability.** IMAP is all-or-nothing — whoever holds the
  password reads everything and sends as the mailbox. Modelled as a single
  `mailbox.full` capability, never a fake catalog; the UI says so.
- **Tools, not sync.** The agent tool surface is the *same* mailbox tool
  family the Google plan defines, differing only in credential/transport
  resolution at the chokepoint — search/list/read run **live against IMAP**
  (`UID SEARCH`/`FETCH` on demand); send goes out over SMTP. No import into
  `CommsEvent`, no local copies. When a run can reach more than one
  connection (a user-scoped one *and* the team's), the tools take an
  explicit connection handle and refuse ambiguity — the `AMBIGUOUS_ACCOUNT`
  discipline, never most-recently-updated wins.
- **Same permission story.** Tools are `requiresExplicitGrant: true`; sends
  ride the identical structural gate (approval bound to a content
  fingerprint; `requiredApproverUserId` = the connection's installer for
  user scope, the installer-or-org-owner rule for team scope; standing
  grants keyed on `(connectionId, agentId)` with the same duration menu).
  Reads may run unattended; sends never do without a standing grant.
- **Egress hygiene:** IMAP/SMTP are raw sockets, not HTTP, so `safeFetch`
  doesn't apply — but the same policy does: operator-supplied hosts resolve
  once and are checked against the private-range rules the MCP endpoint
  validation uses, and the connection pins the vetted addresses, so a member
  cannot point IMAP at an internal service.
- **Home and doorways (Rule zero):** the Integrations page hosts the
  connector card (connect, per-scope list, status, test, disconnect); the
  Tools page grant row names which connection an agent's grant acts
  through; `/settings/connections` links across for the user scope.

That is the whole of Model A: one native connector, one shared tool family,
zero new surfaces beyond the connector card.

## 3. Model B — the hosted mailbox (Nessie is the mailbox)

Here there is no provider holding state: if Nessie doesn't keep the mail,
nobody does. So Model B is a real mailbox — **stored messages, a mailbox UI,
and an agent wired to it** — on **Amazon SES, integrated directly** and
switched on per deployment by environment configuration. There is no
intermediary relay service; the deployment's own SES account sends and
receives, which also makes address uniqueness a plain per-deployment
database constraint. On the hosted deployment the operator is us and the
domain is `nessie.works` — that is the "default free email"; a self-hosted
operator configures their own domain the same way.

### 3.1 Deployment configuration — thorough, env-driven, fails loudly

The functionality is **off unless configured**, and partial configuration is
a startup-named error, not a degraded mode. Configuration reference (to land
in `docs/deployment.md` in the same change that builds P1):

| Variable | Meaning |
|---|---|
| `NESSIE_EMAIL_SES_REGION` | SES region. Presence of this + a credential source + the domain enables the feature. |
| `NESSIE_EMAIL_SES_ACCESS_KEY_ID` / `NESSIE_EMAIL_SES_SECRET_ACCESS_KEY` | Static credentials. Optional — an instance-profile/IRSA role is preferred where available; the SDK default chain is honoured when both vars are unset but a region is set. |
| `NESSIE_EMAIL_DOMAIN` | The deployment's default mail domain (e.g. `nessie.works`). Must be a verified SES identity; startup verifies via `GetEmailIdentity` and refuses to enable on an unverified identity. |
| `NESSIE_EMAIL_INBOUND_S3_BUCKET` / `NESSIE_EMAIL_INBOUND_S3_PREFIX` | Where the SES receipt rule writes raw inbound MIME. The worker fetches raw mail from here. |
| `NESSIE_EMAIL_SNS_TOPIC_ARN` | The SNS topic the receipt rule and the configuration set publish to; the inbound webhook accepts only messages whose `TopicArn` matches. |
| `NESSIE_EMAIL_CONFIGURATION_SET` | SES configuration set stamped on every send; its event destination (bounce, complaint, delivery) publishes to the same SNS topic. |
| `NESSIE_EMAIL_CUSTOM_DOMAINS` | `true` to let org owners verify additional domains through the deployment's SES account (§3.7). Default `false`. |
| `NESSIE_AGENT_MAIL_MAX_SENDS_PER_HOUR` | Per-mailbox outbound cap (default 30); overflow parks as approvals. |
| `NESSIE_AGENT_MAIL_MAX_INBOUND_BYTES` | Inbound size cap (default 25 MiB); oversize mail stores a stub naming the reason. |

Operational facts pinned now:

- **AWS-side setup is documented, not automated:** verify the domain (DKIM),
  publish MX to SES inbound, create the receipt rule (catch-all for the
  domain → S3 + SNS), create the configuration set with an SNS event
  destination. `docs/deployment.md` gets the exact click-path/CLI, the same
  way MinIO and VAPID setup are documented. Startup *checks* what it can
  (identity verified, bucket reachable) and names what it cannot.
- **Inbound endpoint:** `POST /api/integrations/email/inbound` — public,
  accepts SNS deliveries only after full **SNS signature verification**
  (certificate URL pinned to the `sns.<region>.amazonaws.com` host pattern,
  fetched via `safeFetch`, signature checked) *and* a `TopicArn` match;
  handles `SubscriptionConfirmation` automatically under the same checks.
  Ack fast, snapshot, enqueue `email.inbound.process` — the established
  webhook ingestion pattern. Bounce/complaint/delivery events from the
  configuration set arrive on the same route and queue.
- **Outbound:** the worker calls SES `SendRawEmail` (SDK, fixed AWS
  endpoints) with the configuration set stamped, and records the returned
  provider message id on the `EmailMessage`.
- **Suppression and reputation are the deployment's own:** hard bounces and
  complaints write to a local suppression table
  (`email_suppressions {address, reason, occurredAt}`, org-agnostic —
  reputation is per SES account, i.e. per deployment); `email_send` to a
  suppressed address refuses with `RECIPIENT_SUPPRESSED` and the reason.
- **Fail loudly, everywhere:** unconfigured ⇒ the claim flow refuses with
  `AGENT_MAIL_UNCONFIGURED` listing exactly which variables are missing, and
  the UI renders the same reason to owners (members see only that hosted
  email is unavailable). No dead mailbox rows, ever.

### 3.2 Addresses

`AgentMailbox.address` is `{localPart}@{NESSIE_EMAIL_DOMAIN}` (or a verified
custom domain, §3.7). The local part is claimed first-come **within the
deployment** — a plain DB unique, no external authority — lowercased, with a
reserved-word list (`admin`, `postmaster`, `abuse`, `noreply`, …) and
suggestions on conflict. Releasing an address quarantines the row
(`deleting` → retained) so a recycled name cannot silently inherit an old
correspondent's threads.

### 3.3 Data model — an email store, not chat messages

Emails are **not** `Message` rows. They are their own store, because a
mailbox's semantics (folders, read state, delivery state, MIME identity,
external participants) are not a chat thread's:

```
model AgentMailbox {                 // agent_mailboxes
  id, organizationId, agentId @unique        // one mailbox per agent
  address        String  @unique             // full, lowercased; unique per deployment
  domainId       String?                     // -> EmailDomain; null = NESSIE_EMAIL_DOMAIN
  channelId      String  @unique             // backing discussion channel (§3.5)
  status         active | needs_attention | suspended | deleting
  statusReason   String?
  sendPolicy     approval | auto_reply | auto   @default(approval)
  displayName    String?                     // From: display name; defaults to agent name
  createdByUserId, createdAt, updatedAt
}

model EmailDomain {                  // email_domains (P2, custom domains)
  id, organizationId, domain @unique
  status pending_dns | verified | failed | revoked
  sesIdentityArn?, dnsRecords Json, verifiedAt, lastCheckedAt, createdByUserId
}

model EmailConversation {            // email_conversations — one email thread
  id, organizationId, mailboxId
  subject, participants Json                 // denormalized for the list view
  threadId String @unique                    // backing Thread for runs/approvals (§3.5)
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
  sesMessageId?, sentByRunId?, approvalId?   // outbound provenance
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

### 3.4 The mailbox surface

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
Deleting releases the address (quarantined) and keeps the store read-only.

### 3.5 How inbound mail wakes the agent

The `email.inbound.process` worker job fetches the raw MIME from the inbound
S3 bucket, parses it (one parser in a new `packages/agent-mail`, shared by
ingest and send), stores attachments through `FileService`, resolves/creates
the conversation, writes the `EmailMessage` — then wakes the agent.

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
  (SES receipt verdicts in `authResults`) likewise stores flagged, run-less.
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

### 3.6 Sending — permission layered, default is a human approves

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
   the per-mailbox rate cap parks overflow as approvals rather than
   dropping; auto sends stamp `Auto-Submitted: auto-replied`; ≥ N
   auto-replies per conversation per hour (default 4) degrades that
   conversation to `approval` for the window; and a run whose reply basis is
   restricted (`runReplyIsRestricted`) cannot `email_send` at all — content
   with a limited audience inside Nessie is never mailed out of it.

### 3.7 Custom domains (P2, behind `NESSIE_EMAIL_CUSTOM_DOMAINS`)

Owner-only, in `/settings/organization` → **Email domains**. The deployment's
SES account hosts the identity; Nessie drives it over the SES API:

1. Owner adds `agents.acme.com` → `CreateEmailIdentity` → `EmailDomain` row
   `pending_dns` with the returned DKIM CNAMEs plus the MX/SPF/DMARC records
   rendered verbatim.
2. A worker sweep (and a "Check now" button) polls `GetEmailIdentity`;
   `verified` unlocks the domain in the mailbox claim flow (local parts on a
   custom domain are unique per domain). Verification failure follows the
   schedule-health discipline — persisted `status`/`statusReason`, one
   durable `UserAlert` to owners on the transition.
3. Inbound requires the domain's MX to point at SES inbound and a receipt
   rule covering it (documented; the sweep can verify MX via DNS lookup and
   name what is missing). Revoking a domain suspends its mailboxes
   (`needs_attention`, reason named) rather than deleting them.

DMARC alignment holds because the customer domain is DKIM-verified in the
sending SES account — `From: acme.com` mail is signed with `acme.com` keys,
never `nessie.works` spoofing a customer domain. The operator-level switch
exists because every custom domain shares the deployment's SES reputation;
the hosted deployment turns it on deliberately, a self-hoster may not want
tenant domains in their AWS account at all.

### 3.8 Metering, audit, limits

- `enum ConnectorType` gains `email`; every send and processed inbound
  writes `recordConnectorUsage` (`operation: 'send' | 'receive'`, full
  attribution, **no cost fields** — commercial rating is UOA's, per the
  standing rule). Model A's SMTP/IMAP tool calls meter through the same
  member.
- Every send writes an `AuditLog` entry (approval id when one existed);
  bounces and complaints audit too.
- Inbound attachments ride storage quota/accounting by construction
  (FileService); size caps per §3.1.

## 4. Phasing

**P1 — hosted mailbox core (Model B).** Env configuration + startup checks +
`docs/deployment.md` reference, schema (`AgentMailbox`, `EmailConversation`,
`EmailMessage`, suppressions, `agent_email` channel type),
`packages/agent-mail` (MIME parse/build, SES client, SNS verification),
inbound route + worker pipeline, the mailbox UI + agent-detail Email
section, backing channel/threads + run dispatch, `email_send` under
`approval` policy + `email_read`/`email_list`, ConnectorType + audit.
LocalStack-or-stub SES for tests; Playwright on the surfaces.

**P2 — domains + autonomy.** `EmailDomain` + SES identity driving +
settings surface + health alerts; `auto_reply`/`auto` with the structural
floors; outbound attachments; bounce/complaint rendering.

**P3 — SMTP/IMAP native connector (Model A).** `MailboxConnection` with
user/team scopes on the Integrations surface, connection test, sealed
credentials, live IMAP/SMTP tools joining the Google plan's mailbox tool
family and send-gate machinery (which is that plan's P1 — sequence
accordingly), egress hygiene.

**Later, deliberately unplanned:** human "send as the agent" from the
mailbox; multiple mailboxes per agent; opt-in IMAP import into `CommsEvent`
for Chief-of-Staff context; Gmail-as-agent-owned-transport (SMTP/IMAP with
an app password already covers it).

## 5. Superseded

[2026-04-07-email-integration.md](2026-04-07-email-integration.md) sketched
the SES model before the comms stack, trigger/delivery model, approval
machinery, `FileService`, and secret store existed; its address scheme,
BYO-SES AssumeRole path, `agents.email` column, and bespoke `integrations`
table are all replaced here. Two earlier same-day revisions of *this*
document are also dead: the first mapped hosted-mailbox email onto chat
messages (replaced by the stored mailbox + surface), the second interposed a
vendor-operated "Nessie Mail relay" between Nessie and SES (replaced by
direct, env-configured SES integration — the deployment owns its mail
infrastructure, and `nessie.works` is simply the hosted deployment's
configured domain).
