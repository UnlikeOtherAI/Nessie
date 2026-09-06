# Agent email — access to existing mailboxes, or a hosted mailbox of its own

**Date:** 2026-09-02 (reframed twice, then hardened by two independent
reviews the same day — §6; supersedes
[2026-04-07-email-integration.md](2026-04-07-email-integration.md))
**Status:** P1 built and merged (Model B — hosted mailbox); P3 built (Model A —
SMTP/IMAP connected mailboxes, §2.2 and §2.3); P2 planned.

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
| Tool ids | The Google plan's mailbox tool family | `email_read` / `email_list` / `email_send`, bound to the agent's own hosted mailbox **only** |
| What Nessie persists | Credentials, audit, metering — no message copies | Every message, both directions |

Model A is "the agent can reach into a mailbox": *"anything new from the
bank?"*, *"reply to Petra that Thursday works"* — asked in any conversation,
answered via tools, no email UI anywhere in Nessie. Model B is "the agent has
an email identity": people CC `research@nessie.works` into a thread, the mail
arrives *in Nessie*, wakes the agent, and an actual mailbox view shows the
correspondence. The two tool surfaces are deliberately disjoint — the
`email_*` tools never resolve a Model A connection, so an agent holding both
never has an ambiguous send path; a run that can reach a hosted mailbox *and*
external connections is addressing two different resources by two different
names.

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

**What is still missing on the Gmail lane** (verified against `main`,
2026-09-02 — `packages/comms-google` has no send/draft calls and no `gmail_*`
builtin exists): everything agent-facing, i.e. that plan's P1–P3 in full —
Gmail read tools + disclosure sink wiring, `gmail_draft_create/update`,
`GmailDraftAction`, `sendDraftForUser`, the draft card + owner-gated route +
human Send, `ApprovalRequest.requiredApproverUserId`, the structural send
gate, standing `SendAuthorizationGrant`s + the undo window, `gmail_send`
direct, `gmail.modify` tools, and `email_received` as an `event` eventType.
Three of those are **shared dependencies of this plan** and are built once,
in whichever lane lands first, with the other consuming it:
`requiredApproverUserId` + the longer send-approval expiry treatment (§3.6),
the standing-grant table, and the mailbox tool family Model A's SMTP/IMAP
joins. (The Google plan's *content fingerprint* is **not** a shared
dependency — it exists for mutable provider-side drafts; Model B binds
approvals to server-frozen tool args instead, §3.6.) Conversely, the Gmail
plan's former P3 item "optional SMTP/IMAP transport" is ceded to **this**
plan (§2.2) so it is never built twice.

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
    the PA's delegated owner).
  - **Team scope** — an owner/admin connects a shared mailbox
    (`support@acme.com`) for a team.
- **A grant names the connection, not just the tool.** `toolPolicy` is
  `Record<toolId, boolean>`, so a bare `requiresExplicitGrant` on the tool id
  cannot say *which* mailbox an agent may touch — installing a second team
  mailbox would silently widen every agent already granted the tool. Access
  is therefore per-pair: a `MailboxConnectionAgentAccess` row
  `(connectionId, agentId)`, managed from the connector card (the
  DeepWater/app-access precedent of a targeted, locked policy mutation —
  never a full-policy replacement). The builtin tools stay
  `requiresExplicitGrant: true` (the tool-level switch) **and** resolve only
  connections the agent holds an access row for; with more than one
  reachable connection the tools take an explicit `connectionId` and refuse
  ambiguity (`AMBIGUOUS_ACCOUNT` discipline). Cross-lane ambiguity — the
  same mailbox connected via Gmail OAuth *and* an app password — is handled
  the same way: distinct tool families, explicit handles, and the connector
  card warns when a Model A connection's address matches an existing Google
  connection's account.
- **Storage — connection row and credential row are separate**, mirroring
  `CommsConnection`/`CommsConnectionCredential` so list/status reads never
  touch secret-bearing rows: `MailboxConnection`
  `{id, organizationId, scopeType user|team, scopeId, label, address,
  imapHost/Port, smtpHost/Port, username, status active|needs_reauthorization|disabled,
  statusReason, createdByUserId}` +
  `MailboxConnectionCredential {connectionId @unique, secretCiphertext
  (sealSecret packing), keyVersion}`. A connection test must pass before the
  rows are written; later auth failures flip `needs_reauthorization` with a
  remedy-naming reason, never silent retry-forever.
- **Raw-socket egress: pin the validation, not the addresses.** `safeFetch`
  is HTTP-only, so the IMAP/SMTP dialer gets its own discipline with the
  same policy: vet the host at install/test time against the shared
  private-range/special-use rules, then **re-resolve and re-vet on every
  dial** with a custom lookup that connects only to a just-vetted address —
  never cache IPs on the row (mail providers rotate; stale pins become
  reliability bugs). TLS is mandatory: implicit TLS or STARTTLS that refuses
  downgrade, certificate + SNI verified against the *configured hostname*
  (the by-IP-dial gotcha), and credentials never sent before TLS is
  established. The connection test enforces all of it.
- **One honest capability.** IMAP is all-or-nothing — whoever holds the
  password reads everything and sends as the mailbox. Modelled as a single
  `mailbox.full` capability, never a fake catalog; the UI says so.
- **Tools, not sync.** Search/list/read run **live against IMAP**
  (`UID SEARCH`/`FETCH` on demand); send goes out over SMTP. No import into
  `CommsEvent`, no local copies. Reads feed the disclosure sink with the
  connection's scope in the same change (the read-side obligation). Sends
  ride the shared structural gate: approval bound to the server-frozen args
  (§3.6's mechanism), `requiredApproverUserId` = the connection's installer
  (user scope) or installer-else-org-owner (team scope), standing grants
  keyed `(connectionId, agentId)`. Reads may run unattended; sends never do
  without a standing grant.
- **Home and doorways (Rule zero):** one panel, parameterised by scope, on the
  two surfaces that already own connections of that kind — a person's own
  mailboxes beside their Slack/Gmail accounts on `/settings/connections`, and a
  team's shared ones beside the other workspace connections on
  `/settings/organization`. The Agent Designer's tool list shows the tool-level
  switch. (The earlier plan put the card on the Integrations page; that page is
  a column browser over registered *products*, and a mailbox connection is not
  one — `CloudBrowserPanel` already established the two-homes-one-panel shape
  for exactly this.)

### 2.3 As built (2026-09-02)

Deltas from the design above, each with its reason:

- **Scope is which owner column is set**, not a `scopeType`/`scopeId` pair:
  `MailboxConnection.ownerUserId` and `.teamId`, exactly one non-null under a
  CHECK. A polymorphic `scopeId` could carry no foreign key; the split columns
  carry real ones, including the composite
  `(organization_id, owner_user_id) → organization_members` that puts tenancy in
  the database the way `Agent.ownerUserId` does. `scope` is derived by the
  presenter, so there is no second statement of the fact to drift.
- **The protocol clients are ours** (`packages/agent-mail`: `dial.ts`, `wire.ts`,
  `smtp.ts`, `imap.ts`, `mailbox-client.ts`), not a mail library. The dial has to
  open to a just-vetted literal address with SNI pinned to the configured
  hostname, and a client that owns its own socket cannot be given that. They live
  beside the SES transport because MIME building, address normalisation, parsing
  and sanitising are transport-neutral and already there — `buildOutboundMime`
  serves both models, and two message builders would drift.
- **Vetting is shared, not restated.** `resolveVettedAddresses` was factored out
  of `url-safety.ts` so the private-range and special-use rules have one home;
  `resolveAndValidate` (HTTP) and the mail dialer both call it. Resolving once
  and dialling the returned address is stronger than a custom lookup: there is no
  second resolution to rebind.
- **Every untrusted value is a counted IMAP literal** — folder names, search
  terms, the credential. IMAP has no escaping that survives a hostile string,
  and these values come from a model reading somebody's mail. Length-prefixing
  makes injection structurally impossible rather than a validation to remember.
- **Search is structured, not a query string.** `from`/`subject`/`text`/`since`/
  `unseenOnly` map to IMAP SEARCH keys; the model never writes IMAP syntax.
- **Three tool families stay disjoint**: `gmail_*` (a person's Google account),
  `mailbox_*` (a connected SMTP/IMAP mailbox), `email_*` (the agent's own hosted
  mailbox). An agent holding two must never have an ambiguous send path.
- **Standing send grants are deliberately not built.** Every `mailbox_send` is
  approved. `SendAuthorizationGrant` is keyed to `CommsConnection` and its
  exact-key discipline rests on a grant being the mailbox *owner's* to give
  about their own account; a shared team mailbox has no such owner, and one
  grant table meaning two things is how that property is lost. What the gate
  does add is *who* is asked — the personal owner, or a shared mailbox's
  installer, live-checked — and *why*, naming any source the recipient cannot
  reach. Reads still run unattended.
- **`STRUCTURALLY_APPROVAL_GATED_TOOL_IDS` moved** out of `builtin-google-tools.ts`
  into `builtin-approval-gates.ts`: it spans families, and each new mail family
  made the Google file's name less true.
- **The structural gate is composed**, not extended: `composeStructuralGates`
  takes the hosted-mailbox hook and the connected-mailbox hook, each returning
  null for tools it does not own.
- **Discovery carries the long tail from a snapshot, not a live lookup**
  (`mailbox-ispdb.ts`, added 2026-09-04). Thirty reviewed entries cover ~110
  domains, each recording the published source it was read from. Querying a
  third-party configuration service at connect time was rejected outright: that
  service would be deciding where somebody's mail password is sent. The snapshot
  is a *candidate*, never a short circuit — candidates are selected by evidence
  strength (autoconfig 90, mail SRV 85, snapshot 75), so what a domain publishes
  today beats what we verified once. Only the exact-domain reviewed registry
  stays network-free. Custom-domain hosting providers are deliberately absent: a
  domain-keyed lookup can only match their vanity domain, never a customer's.
- **A configuration is confirmed before it is offered a password**
  (`mailbox-probe.ts`). A reviewed hostname is evidence a server *should* be
  there, not that one *is* — most obviously for snapshot entries, verified from
  a document rather than observed. The probe is structurally credential-free:
  no username or password parameter exists in the module, which is why its
  three-command conversation is written there rather than through
  `ImapSession.open`/`openSmtpSession`, whose job is to log in. It dials only
  through the shared vetting, opens only the registered mail ports so a
  discovered document cannot aim a port scan through us, and treats a refused
  STARTTLS or an unverifiable certificate as `insecure` — configuration
  withheld, person sent to manual settings. Unreachable changes nothing; a
  transient failure is the connect step's error to report.
- **`mailbox-discovery.ts` split at its 500-line cap** into what touches the
  network under one deadline, how findings are weighed, and the shapes an answer
  may take, leaving a 303-line orchestrator. Every answer still leaves through
  one `MailboxDiscoveryResultSchema.parse`.
- **Discovery counts its own outcome** (`api/src/services/mailbox-discovery-telemetry.ts`).
  Counting completed connections hides the failure this design exists to remove,
  so each attempt logs duplicate/provider-sign-in/password/confirmation/manual
  beside its evidence sources. A mailbox address is a person: the payload is
  built by a function that can only emit the domain and banded confidences.
- **Not built here**: outbound attachments, folder listing, marking mail read,
  and any import into `CommsEvent`. Also still absent: Apple Account
  authorisation (`appleAuthorization` is hard-coded false — Nessie is not a
  registered relying party), a JMAP connector (discovery classifies JMAP but
  `capabilities.jmap` is false, so it falls back to IMAP/SMTP), and HTTPS
  Exchange Autodiscover for on-premises servers (only the Exchange Online SRV
  fingerprint is read). Operator guide:
  [../connected-mailboxes.md](../connected-mailboxes.md).

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

**Eligibility (P1):** a mailbox attaches only to a non-system,
`inference`-mode, org-bound, **workspace-visible** agent. Private agents are
deliberately unsupported for now — the private-agent placement guard permits
runs only in the exact home DM or the agent's own trigger thread, and the
owner-only stewardship rules conflict with an owner-gated mailbox lifecycle;
extending both is its own decision, not a side effect. PA and subtask
children are excluded (the PA acts as people, not as an address; children
are transient).

### 3.1 Deployment configuration — thorough, env-driven, fails loudly

The functionality is **off unless configured**, and partial configuration is
a startup-named error, not a degraded mode. Configuration reference (to land
in `docs/deployment.md` in the same change that builds P1):

| Variable | Meaning |
|---|---|
| `NESSIE_EMAIL_SES_REGION` | SES region. Presence of this + a credential source + the domain enables the feature. |
| `NESSIE_EMAIL_SES_ACCESS_KEY_ID` / `NESSIE_EMAIL_SES_SECRET_ACCESS_KEY` | Static credentials. Optional — an instance-profile/IRSA role is preferred where available; the SDK default chain is honoured when both vars are unset but a region is set. |
| `NESSIE_EMAIL_DOMAIN` | The deployment's default mail domain (e.g. `nessie.works`). Must be a verified SES identity; startup verifies via the SESv2 API and refuses to enable on an unverified identity. |
| `NESSIE_EMAIL_INBOUND_S3_BUCKET` / `NESSIE_EMAIL_INBOUND_S3_PREFIX` | Where the SES receipt rule writes raw inbound MIME. The worker fetches raw mail from here. |
| `NESSIE_EMAIL_SNS_TOPIC_ARN` | The SNS topic the receipt rule and the configuration set publish to. At startup the API **subscribes itself** to this topic via the SNS API; the public webhook **rejects** `SubscriptionConfirmation` messages outright (no confirmation oracle) and accepts only signature-verified notifications whose `TopicArn` equals this value. |
| `NESSIE_EMAIL_CONFIGURATION_SET` | SES configuration set stamped on every send; its event destination (bounce, complaint, delivery) publishes to the same SNS topic. |
| `NESSIE_EMAIL_INBOUND_RETENTION_DAYS` | How long raw MIME objects stay in the inbound bucket after successful processing (default 30; the worker deletes on schedule). |
| `NESSIE_EMAIL_CUSTOM_DOMAINS` | `true` to let org owners verify additional domains through the deployment's SES account (§3.7). Default `false`. |
| `NESSIE_AGENT_MAIL_MAX_SENDS_PER_HOUR` | Per-mailbox outbound cap (default 30); overflow parks as approvals. |
| `NESSIE_AGENT_MAIL_MAX_INBOUND_BYTES` | Inbound size cap (default 25 MiB), enforced with `HeadObject` **before** streaming; oversize mail stores a stub naming the reason. |

Operational facts pinned now:

- **One SES client surface:** the SESv2 SDK (`SendEmail` raw mode,
  `GetEmailIdentity`/`CreateEmailIdentity`) behind one thin wrapper in
  `packages/agent-mail` — not two client stacks.
- **AWS-side setup is documented, not automated:** verify the domain (DKIM),
  publish MX to SES inbound, create the receipt rule (catch-all for the
  domain → S3 + SNS), create the configuration set with an SNS event
  destination, and restrict the SNS topic policy to the SES account plus the
  bucket policy to SES writes. `docs/deployment.md` gets the exact
  click-path/CLI, the way MinIO and VAPID setup are documented. Startup
  *checks* what it can (identity verified, bucket reachable, subscription
  present) and names what it cannot.
- **Inbound endpoint:** `POST /api/integrations/email/inbound` — public,
  accepts SNS deliveries only after full **SNS signature verification**
  (certificate URL host-pinned to the `sns.<region>.amazonaws.com` pattern,
  fetched via `safeFetch` with a response size cap, signature checked) *and*
  the `TopicArn` match. The handler discriminates the payload schema
  strictly — SES *receipt* notifications vs configuration-set *bounce /
  complaint / delivery* events — and rejects anything else. Ack fast,
  snapshot, enqueue `email.inbound.process`.
- **Raw S3 access is a named, narrow exception** to the one-`FileService`
  blob chokepoint: the worker reads (and later deletes) raw MIME from the
  inbound bucket as *transport staging only*. Every durable byte — parsed
  attachments, anything a user can reach — goes through `FileService`
  exclusively.
- **Suppression and reputation are the deployment's own:** hard bounces and
  complaints write a local suppression table
  (`email_suppressions {address, reason, occurredAt}`, org-agnostic —
  reputation is per SES account); `email_send` to a suppressed address
  refuses with `RECIPIENT_SUPPRESSED` and the reason. The bounce/complaint
  consumer that populates it is **P1**, not P2 — without it the refusal
  floor is inert.
- **Fail loudly, everywhere:** unconfigured ⇒ the claim flow refuses with
  `AGENT_MAIL_UNCONFIGURED` listing exactly which variables are missing, and
  the UI renders the same reason to owners (members see only that hosted
  email is unavailable). No dead mailbox rows, ever.

### 3.2 Addresses

`AgentMailbox.address` is `{localPart}@{NESSIE_EMAIL_DOMAIN}` (or a verified
custom domain, §3.7). The local part is claimed first-come **within the
deployment** — a plain DB unique, no external authority — lowercased, with a
reserved-word list (`admin`, `postmaster`, `abuse`, `noreply`, …) and
suggestions on conflict. Deleting a mailbox **retires its address
permanently**: the row is kept read-only, the unique constraint keeps the
name off the market, and no recycled address can inherit an old
correspondent's trust. (No quarantine state machine — retirement is one
timestamp.)

### 3.3 Data model — an email store, not chat messages

Emails are **not** `Message` rows. They are their own store, because a
mailbox's semantics (delivery state, MIME identity, external participants)
are not a chat thread's:

```
model AgentMailbox {                 // agent_mailboxes
  id, organizationId, agentId @unique        // one mailbox per agent
  address        String  @unique             // full, lowercased; unique per deployment
  domainId       String?                     // -> EmailDomain; null = NESSIE_EMAIL_DOMAIN
  channelId      String  @unique             // backing discussion channel (§3.5)
  status         active | suspended          // suspended carries statusReason (remedy-naming)
  statusReason   String?
  retiredAt      DateTime?                   // set on delete; row kept read-only
  sendPolicy     approval | auto_reply | auto   @default(approval)   // P1 ships the column, PATCH + UI; P2 unlocks the non-default values
  displayName    String?                     // From: display name; defaults to agent name
  createdByUserId, createdAt, updatedAt
}

model EmailDomain {                  // email_domains (P2, custom domains)
  id, organizationId, domain @unique
  status pending_dns | verified | failed | revoked
  sesIdentityArn?, dkimTokens Json           // SES-returned facts; MX/SPF/DMARC guidance rendered at read, never stored
  verifiedAt, lastCheckedAt, createdByUserId
}

model EmailConversation {            // email_conversations — one email thread
  id, organizationId, mailboxId
  subject, participants Json                 // denormalized for the list view
  threadId String @unique                    // backing Thread for runs/approvals (§3.5)
  lastMessageAt, messageCount
  @@index([mailboxId, lastMessageAt])
}
// Deliberately NO unreadCount, NO muted, NO needs_approval state: per-viewer
// read state would need the existing ThreadReadState pattern (add only if a
// real need appears), and approval/bounce chips are DERIVED from the live
// ApprovalRequest / EmailMessage rows — never a second mutable copy.

model EmailMessage {                 // email_messages
  id, organizationId, mailboxId, conversationId
  direction      inbound | outbound
  receiptId      String? @unique            // inbound: SES receipt/SNS message id — the idempotency key
  s3ObjectKey    String?                    // inbound: raw MIME staging reference
  rfcMessageId   String                     // normalized; outbound = generated; inbound may be absent/forged — never an idempotency key
  inReplyTo?, referencesIds Json
  fromAddress, fromName?, replyToAddress?
  toAddresses Json, ccAddresses Json, bccAddresses Json @default("[]")
  envelopeRecipients Json                   // inbound: SES receipt envelope — the routing truth
  subject, textBody, htmlBody?              // html stored sanitized at ingest
  snippet        String                     // list-view preview
  authResults    Json?                      // SPF/DKIM/DMARC/spam/virus verdicts (inbound)
  classification normal | bulk | dsn        // structural header classification
  deliveryState  queued | sending | sent | delivery_unknown | bounced | complained | null   // outbound only
  sesMessageId?, sentByRunId?, approvalId?  // projections of run/approval rows for list rendering — the ApprovalRequest stays authoritative
  occurredAt, createdAt
  @@index([conversationId, occurredAt])
  @@index([mailboxId, rfcMessageId])        // threading lookup — an index, not a uniqueness claim
}
```

**Attachments get a real link, in the same change.** `Attachment` today
links only `messageId`/`knowledgePageId`, and `FileService` accepts only
those destinations — so P1 adds a nullable `emailMessageId` FK, the
`FileService` destination, the attachment-ACL arm (readable to whoever can
read the mailbox, §3.4), the presenter rule, and the Prisma-fake coverage,
together — the exact defect class AGENTS.md records for project avatars.
Inbound attachments hang off the `EmailMessage`, never off the compact chat
reference message (chat visibility must not become the attachment's
authority).

Other pinned facts: `Agent` gets **no** email column (the presenter joins
`AgentMailbox`); one mailbox per agent; this store is **not**
`CommsConnection`/`CommsEvent`; inbound threading resolves `In-Reply-To`
then `References` against the mailbox's known ids — absent, duplicate, or
forged `Message-ID`s degrade to a new conversation, never to a dropped or
mis-merged message; outbound generates its own `Message-ID` and sets
threading headers from the conversation's newest inbound message.

### 3.4 The mailbox surface

This is the "entire email mailbox, displayed" part — the capability's home
(Rule zero):

- **Home:** `/agents/:id/mailbox` — a two-pane mailbox: conversation list
  (subject, participants, snippet, chips *derived* from live rows — a
  pending `ApprovalRequest` renders *awaiting approval*, a `bounced`
  outbound renders *bounced*) and a reading pane rendering the messages of a
  conversation newest-last. HTML mail renders sanitized (allowlist, remote
  images blocked by default with a per-message "load images" reveal —
  tracking pixels are the default leak). Outbound messages show delivery
  state as it changes. It reuses the content-system primitives
  (`QueryState`, the pagination contract, `TabBar` for Inbox/Sent/All) — no
  bespoke kit.
- **Read APIs, named:** `GET /api/agents/:agentId/mailbox/conversations`
  (paginated per the standard contract), `GET …/conversations/:id/messages`,
  and attachment fetch through the ordinary attachment routes once the ACL
  arm exists. Authorization composes the shared live agent-visibility
  predicate (`buildVisibleAgentWhere`) — whoever may see the agent may read
  its mailbox; never ambient session scope.
- **Doorways:** the agent detail page gets an **Email** section (address or
  claim flow, status + reason, send policy control, link to the mailbox);
  the sidebar lists the mailbox beside the agent's channels; the Tools page
  grant row for `email_send` names the address it acts through.
- **Composing as a human is not in scope.** The mailbox view is read +
  supervise; mail is sent by the agent through its tools.

Lifecycle is owner-gated (it mints an externally visible identity):
`POST/GET/PATCH/DELETE /api/agents/:agentId/mailbox`, one service in
`@nessie/workspace-admin` so a future PA builtin mirrors the route exactly.

### 3.5 How inbound mail wakes the agent

The `email.inbound.process` worker job:

1. **Claims the delivery once.** Idempotency is the SES receipt / SNS
   message id (+ the S3 object key), claimed by a conditional insert of the
   `EmailMessage` row (`receiptId @unique`) — never the forgeable RFC
   `Message-ID`. SNS retries and replays converge on the one row; the wake
   happens in the same transaction, so "persist and wake once" is one
   atomic decision, not two.
2. **Routes on the envelope, never the headers.** The target `AgentMailbox`
   is resolved from the SES **receipt envelope recipients** — MIME
   `To:`/`Cc:` are attacker-controlled, omit Bcc, and can name another
   tenant. A catch-all delivery naming several claimed addresses fans out
   one `EmailMessage` per mailbox, deterministically; unknown local parts
   are dropped (bounded logging, no bounce generation — backscatter).
3. Verifies size (`HeadObject` first), fetches raw MIME from the staging
   bucket, parses it (one parser in `packages/agent-mail`, shared by ingest
   and send), sanitizes HTML, stores attachments through `FileService`
   against the `EmailMessage`, resolves/creates the conversation, and
   schedules staged-object deletion per the retention setting.

Runs need a thread, and approvals/reports need somewhere to live, so each
mailbox keeps **one backing channel** (`systemChannelType: 'agent_email'`,
`visibility: 'public'` — matching the workspace-visible agents mailboxes are
restricted to; there is no "team-visible" channel entitlement to invent)
with **one `Thread` per `EmailConversation`**. The thread is the
conversation's *operations room*, not the mail itself. The wake is **not**
the existing `AgentMailboxMessage` dispatcher (that path is agent-to-agent
delivery with its own semantics) — it is a new intake that reuses the same
primitives: post the compact server-authored reference message (sender,
subject, link into the mailbox view), then `claimThreadRunOrPend` → run +
enqueue, all inside the claim transaction of step 1, under a
**service-actor context** — the external sender maps to *no* local user's
authority, ever.

- Email addressed to the agent is **structural engagement**; the model
  decides *what to do*, never whether string-matching says it was spoken to.
  The run's context loader renders the conversation's `EmailMessage` rows
  (inventory-line style for attachments) and **feeds the disclosure sink**
  with the mailbox scope (§3.6) — chat `Message` history loading alone does
  not cover the email store, so this loader is named P1 work.
- `bulk`/`dsn`-classified mail (from `Auto-Submitted`, `Precedence:
  bulk/list`, `List-Id`, null return-path — structural header facts, not
  content heuristics) stores and displays but starts **no run**. The same
  applies to mail whose receipt verdicts fail — spam, **virus, SPF/DKIM/
  DMARC failure** — stored flagged, run-less; a person can still read it in
  the mailbox and engage the agent deliberately.
- **The cold-inbound posture, assembled in one place:** a run woken by a
  stranger's email is *unattended* and *service-actor*. It may read its own
  mailbox and the thread it runs in; it may draft a reply, which under the
  default policy parks an approval; it sends autonomously only under
  `auto_reply`/`auto` and only as a reply (§3.6). Nothing in the email's
  content can widen that envelope — sender identity never becomes local
  authority, and the untrusted-content framing in the prompt is *in
  addition to* these structural floors, not the defense itself.
- If a *different* agent should react to incoming mail, that is the existing
  event-trigger machinery (`POST /api/events` with an `email_received`
  eventType — the shape the Google plan reserved). Such a trigger fires into
  **its own configured target channel/thread** (existing `AgentTrigger`
  behaviour), not into the mailbox's backing thread — the mailbox agent's
  structural wake is the only path that lands there.

### 3.6 Sending — permission layered, default is a human approves

The tools live beside the existing comms builtins
(`packages/runtime/src/builtin-comms-tools.ts`; handlers
`worker/src/run/pa-tools/agent-email.ts`), **not** `personalAssistantOnly` —
any eligible agent with a mailbox and the grant:

- `email_send` (`requiresExplicitGrant: true`, `safe: false`) —
  `{to[], cc?, bcc?, subject?, text}`. Called from an email conversation's
  backing thread it defaults to replying there (recipients from the latest
  inbound message — honouring `Reply-To` over `From` — `Re:` subject,
  threading headers set); called elsewhere with explicit recipients it
  starts a new conversation. **P1 has no attachment parameter at all**;
  P2 adds `attachmentIds` together with its disclosure rule (below) — a
  parameter that exists but errors is a trap.
- `email_read` / `email_list` (`safe: true`, no grant) — the agent reading
  **its own** mailbox store, so *"what's in your inbox?"* works from any
  conversation the agent is in. Scoped to the run's agent's mailbox,
  nothing else's; reads feed the disclosure sink.

**The approval binds the frozen args — no second fingerprint.** The
existing tool gate already hashes the exact args (`argsHash`), freezes them
server-side in `resumeState`, and replays them verbatim on resume; for a
direct tool call there is no mutable draft to re-verify, so Model B reuses
that machinery as-is. (The Google plan's content fingerprint remains
correct *there* — it defends a provider-side draft that can be edited
between approval and send.) What **is** new work:

- **The approver sees the whole email, not a 200-char redacted summary.**
  The gate message links an owner-gated
  `GET …/mailbox/approvals/:approvalId/draft` that renders the full frozen
  draft (recipients incl. Bcc, subject, body) from `resumeState` — informed
  consent is the point of the gate.
- **`ApprovalRequest.requiredApproverUserId`** — shared dependency with the
  Google plan; built once by whichever lane lands first (§2.1). Pinned to
  the agent's steward (`ownerUserId`); if the steward's membership is
  deactivated before resolution, the request falls back to
  `requiredApproverRole: 'owner'` rather than dying unanswerable.
- **Send approvals outlive the 30-minute default.** Email is asynchronous —
  an overnight approval that expires silently strands the conversation. Send
  approvals get a longer configurable expiry plus a durable `UserAlert` on
  raise **and** on expiry (the Google plan §7.3 treatment, shared).
- **The send itself is crash-safe:** approval (or auto-policy pass) writes
  the outbound `EmailMessage` as `queued`; dispatch claims it with a
  conditional `queued → sending` update, calls SES, then records
  `sesMessageId` + `sent`. A worker death between SES accept and the DB
  write leaves `sending`, which resolves to `delivery_unknown` — surfaced
  on the message, **never auto-retried** (a retry is a duplicate email).

Permission layers, all reusing existing mechanisms:

1. **Explicit tool grant** per agent from the Tools page. (Model B needs no
   per-connection access rows — the tool reaches exactly the agent's own
   mailbox, an unambiguous resource.)
2. **`AgentMailbox.sendPolicy`** — `approval` (default, every send parks the
   gate above), `auto_reply` (replies within an existing conversation send
   immediately; new outbound conversations still park — the support-bot
   mode), `auto` (owner-set only, risk stated in the UI). Column, PATCH and
   UI ship in P1; the two non-default values unlock in P2.
3. **Structural floors no policy relaxes:** unattended runs may send only
   under `auto_reply`/`auto` and only as replies; suppressed recipients
   refuse; the per-mailbox rate cap parks overflow as approvals rather than
   dropping; auto sends stamp `Auto-Submitted: auto-replied`; ≥ N
   auto-replies per conversation per hour (default 4) degrades that
   conversation to `approval` for the window.

**Disclosure for external recipients is its own decision — the chat
predicate is the wrong test.** `runReplyIsRestricted` measures restriction
*relative to the current chat destination*: team- or org-scoped material can
look unrestricted to the backing thread while being wholly unauthorized for
an outside recipient — and conversely, a naive "restricted ⇒ no send" would
deadlock every reply (the mailbox's own content is privileged relative to
somewhere). So:

- Reading the mailbox store stamps a dedicated basis scope,
  `email:{mailboxId}`, which the backing thread's destination **implies** —
  so a run that read only the conversation it is answering is clean and can
  reply under any policy. A test pins this non-deadlock property.
- `email_send` inspects the run's full consumed-source set directly: if the
  run consumed **any** privileged source beyond its own mailbox scope and
  the thread it runs in (a private KB space, another channel's messages,
  memory with narrower audience), the send **requires approval regardless
  of `sendPolicy`**, and the gate names those sources — a human decides
  whether that material may leave the building. Never a silent refusal, and
  never auto-sent.
- The P2 `attachmentIds` parameter applies the same rule per attachment: an
  attachment whose provenance is not the mailbox/thread itself forces the
  naming approval.

### 3.7 Custom domains (P2, behind `NESSIE_EMAIL_CUSTOM_DOMAINS`)

Owner-only, in `/settings/organization` → **Email domains**. The deployment's
SES account hosts the identity; Nessie drives it over the SESv2 API:

1. Owner adds `agents.acme.com` → `CreateEmailIdentity` → `EmailDomain` row
   `pending_dns` storing the SES-returned DKIM tokens (facts); the DNS
   records people paste — DKIM CNAMEs, MX, recommended SPF/DMARC — are
   rendered from those facts at read time, never stored rendered.
2. A worker sweep (and a "Check now" button) polls `GetEmailIdentity`;
   `verified` unlocks the domain in the mailbox claim flow (local parts on a
   custom domain are unique per domain). Verification failure follows the
   schedule-health discipline — persisted `status`/`statusReason`, one
   durable `UserAlert` to owners on the transition.
3. Inbound requires the domain's MX at SES inbound and a receipt rule
   covering it (documented; the sweep verifies MX via DNS lookup and names
   what is missing). Revoking a domain suspends its mailboxes
   (`suspended`, reason named) rather than deleting them.

DMARC alignment holds because the customer domain is DKIM-verified in the
sending SES account — `From: acme.com` mail is signed with `acme.com` keys,
never `nessie.works` spoofing a customer domain. The operator-level switch
exists because every custom domain shares the deployment's SES reputation.

### 3.8 Metering, audit, limits

- `enum ConnectorType` gains `email` — the Prisma enum **and** the runtime
  union in `packages/runtime/src/connector-usage.ts`, in one change. Every
  send and every processed inbound message writes `recordConnectorUsage`
  (`operation: 'send' | 'receive'`, full attribution, **no cost fields** —
  commercial rating is UOA's). Granularity is pinned: **one event per tool
  call / per inbound message**, never per IMAP protocol command. Inbound
  events attribute to the mailbox's agent + org with the service actor —
  no synthetic user is ever minted for an external sender.
- Every send writes an `AuditLog` entry (approval id when one existed);
  bounces and complaints audit too.
- Inbound attachments ride storage quota/accounting by construction
  (FileService); size caps per §3.1.

## 4. Phasing

**P1 — hosted mailbox core (Model B).** Env configuration + startup checks
(incl. SNS self-subscribe) + `docs/deployment.md` reference; schema
(`AgentMailbox` incl. `sendPolicy`, `EmailConversation`, `EmailMessage`,
suppressions, `Attachment.emailMessageId` + FileService destination + ACL
arm, `agent_email` channel type); `packages/agent-mail` (MIME parse/build,
SESv2 wrapper, SNS verification); inbound route + worker pipeline
(envelope routing, receipt-id idempotent claim-and-wake, HTML sanitizer,
retention deletion); the **bounce/complaint consumer + suppression**; the
mailbox UI + read APIs + agent-detail Email section; backing channel/threads
+ service-actor run dispatch + the email context loader feeding the
disclosure sink (`email:{mailboxId}` scope); `email_send` under `approval`
(frozen-args approval, rendered-draft route, `requiredApproverUserId`
build-once, long expiry + alerts, crash-safe `queued → sending → sent /
delivery_unknown`) + `email_read`/`email_list`; ConnectorType (both unions) +
audit. Tests named now: SNS replay/idempotency, envelope-vs-header routing
(incl. Bcc delivery), missing/forged `Message-ID`, send crash recovery,
non-deadlock of the mailbox disclosure scope, external-disclosure approval
forcing, attachment ACL (incl. Prisma-fake coverage), prompt-injected
mutation attempts, private-agent/PA mailbox refusal. Stub SES/SNS harness;
Playwright on the surfaces.

**P2 — domains + autonomy + attachments.** `EmailDomain` + SES identity
driving + settings surface + health alerts; `auto_reply`/`auto` unlocked
with the structural floors and loop caps; `email_send.attachmentIds` with
the per-attachment disclosure rule; bounce/complaint rendering polish.

**P3 — SMTP/IMAP native connector (Model A). Built 2026-09-02; see §2.3
for the as-built deltas.** `MailboxConnection` + separate credential row,
per-agent access rows, the connection panel on both connection surfaces, a
connection test enforcing the TLS/egress discipline, live IMAP/SMTP tools
(`mailbox_search`/`mailbox_read`/`mailbox_send`) beside the Google plan's
mailbox tool family, the structural send gate with a pinned approver, and
disclosure-sink wiring for connection reads. Standing send grants and outbound
attachments are explicitly deferred.

**Later, deliberately unplanned:** human "send as the agent" from the
mailbox; multiple mailboxes per agent; private-agent mailboxes (placement +
stewardship extension); per-viewer read state on conversations; opt-in IMAP
import into `CommsEvent` for Chief-of-Staff context;
Gmail-as-agent-owned-transport (app-password SMTP/IMAP covers it).

## 5. Superseded

[2026-04-07-email-integration.md](2026-04-07-email-integration.md) sketched
the SES model before the comms stack, trigger/delivery model, approval
machinery, `FileService`, and secret store existed; its address scheme,
BYO-SES AssumeRole path, `agents.email` column, and bespoke `integrations`
table are all replaced here. Two earlier same-day revisions of *this*
document are also dead: the first mapped hosted-mailbox email onto chat
messages (replaced by the stored mailbox + surface), the second interposed a
vendor-operated "Nessie Mail relay" between Nessie and SES (replaced by
direct, env-configured SES integration).

## 6a. Post-build review (Kimix, 2026-09-02)

Three scoped Kimix passes over the built code. What was accepted and fixed:

- **Duplicate sends were possible.** The `queued → sending` claim stops one row
  being dispatched twice; nothing stopped a replayed run inserting a *second*
  row. `EmailMessage.sendKey` (`{runId}:{toolCallId}`) makes the write itself
  idempotent, with the unique index deciding a race.
- **Suppression and the hourly cap moved inside the queueing transaction.**
  They were exported helpers the caller had to remember, and the cap counted
  outside the write, so two concurrent runs could both take the last slot.
- **A crashed send now resolves.** `sweepStuckSends` ages a `sending` claim into
  `delivery_unknown` — never back to `queued`, which would re-dispatch a message
  SES may already have delivered.
- **The email attachment ACL now asks agent visibility**, the same question the
  mailbox reads ask, and honours `retiredAt`. It had used the backing channel's
  membership predicate, so the two could disagree and leave blobs reachable
  after the mail around them went dark.
- **The sender-written `Date:` header is clamped** against the SES receipt time;
  unclamped it set mailbox sort order and biased threading.
- **Smaller:** the SNS certificate cache is bounded, the future-skew window is
  five minutes rather than an hour, `/api/agent-email/config` no longer hands
  operator configuration to members, and the conversation context loader binds
  the mailbox to the run's own agent.

Rejected, with reasons:

- *"The regex sanitizer fails open on obfuscated XSS."* Probed with the
  reviewer's own cases (`<scr<script>ipt>`, comment-terminated attributes,
  `svg/onload`, entity-encoded `javascript:`): all clean, because the allowlist
  pass runs **after** stripping, so anything reconstituted is then dropped as an
  unknown tag.
- *"Unbalanced closing tags let mail break out of its container."* Stray closers
  are parsed as an `innerHTML` fragment in the context of their own element; the
  HTML parser drops them rather than closing an ancestor.
- *"Dispatch does not verify the approval."* The gate is at tool authorization,
  before the handler runs — the same shape every gated tool has. Re-checking at
  dispatch would be a second gate, and content is already bound by `argsHash`.
- *"Threading trusts `In-Reply-To`."* By design and tested: candidates are
  scoped to the mailbox, and an unrecognised reference starts a new
  conversation. Every mail client threads this way.

One finding is **real but out of scope**: agent-to-agent mailbox delivery and
workflow step messages do not propagate a disclosure basis (`agent-message.ts`
names this in its own docstring). That predates this work and belongs to the
disclosure build.

## 6. Review adjudication (2026-09-02)

Two independent reviews (Codex Sol, Kimix) ran against the previous
revision; convergent and verified findings are folded above. The
load-bearing corrections: external-recipient disclosure got its own decision
(`email:{mailboxId}` scope + consumed-source inspection) instead of the
destination-relative chat predicate, which was simultaneously too weak for
outsiders and a deadlock for replies; approvals reuse the existing
frozen-args/`argsHash` machinery with a rendered-draft view, longer expiry
and a pinned approver, instead of a duplicate fingerprint system; inbound
identity moved to the SES receipt envelope with receipt-id idempotency and
an atomic claim-and-wake; Model A grants became per-`(connection, agent)`
rows because `toolPolicy` cannot name a resource; the SMTP/IMAP dialer pins
the validation (re-resolve + re-vet per dial, TLS/SNI rules), not cached
addresses; `Attachment`/`FileService`/ACL work for email is named P1 scope;
private agents are excluded until the placement guard is deliberately
extended; sends got a crash-safe state machine with `delivery_unknown`; and
the unimplementable `unreadCount`/`muted`/`needs_approval` aggregates were
cut in favour of derived chips. One reviewer claim was narrowed rather than
adopted: the content fingerprint is redundant only for Model B's direct
tool-call sends — it remains correct in the Google plan for mutable
provider-side drafts.
