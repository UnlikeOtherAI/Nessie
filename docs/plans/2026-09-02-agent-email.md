# Agent email — every agent can have its own mailbox

**Date:** 2026-09-02
**Status:** Design (approved direction; supersedes
[2026-04-07-email-integration.md](2026-04-07-email-integration.md))

---

## 1. Goal

Every agent can have **its own email address** and act as a first-class email
participant: people CC it into a conversation, it reads the thread, and — with
permission — it replies or starts new mail. Two ways an agent gets a mailbox:

1. **Provided (default, free):** `{name}@nessie.works`, hosted by us on a
   first-party mail relay (Amazon SES underneath). Zero setup: claim a name,
   the agent has email. Organisations can later attach a **custom domain**
   (`{name}@agents.acme.com`) through the same relay.
2. **SMTP/IMAP:** an existing external mailbox (any provider/host) handed to
   the agent — IMAP for inbound, SMTP for outbound, credentials stored
   encrypted. The mailbox belongs to the agent operationally even though it
   lives elsewhere.

**Explicitly out of scope — the Gmail lane.** "Agent manages a person's
existing Gmail mailbox" is the
[Google Workspace plan](2026-08-31-google-workspace-email-calendar.md)
(P0 connect/import is built; the `gmail_*` tools are its P1–P3). That is
**send-as-you**; this plan is **send-as-the-agent**. The two must not share a
code path (that plan's §11 says the same from the other side). A dedicated
Gmail mailbox *owned by an agent* could later become a third transport here,
but it is deliberately not planned now — the SMTP/IMAP transport already
covers "agent owns a mailbox that happens to be Gmail" via an app password.

## 2. The shape: an email conversation is a Nessie conversation

The single load-bearing decision. Inbound email does **not** get its own
viewer, store, or triage UI. Each mailbox owns one **channel**, and each email
conversation is one **thread** in it:

- An inbound email becomes an ordinary `Message` (`role: 'user'`) in the
  mapped thread, carrying an `metadata.email` envelope (from, to/cc, subject,
  authentication results, provider ids) and its MIME attachments stored
  through the one `FileService` chokepoint.
- The agent is bound to the channel; a direct email addressed to the agent is
  **structural engagement** (like a mention — the sender chose the agent), so
  a run starts and its reply lands in that thread. Bulk/auto mail
  (`Auto-Submitted`, `Precedence: bulk/list`, `List-Id`, DSNs with a null
  return-path) is posted to the thread **without** a run — registered, no
  spend, no reply loop.
- Humans in the channel see the whole correspondence, can discuss in-thread
  (internal by default — a human post is a note to the agent, never outgoing
  mail), and approvals for outbound sends appear in the same thread via the
  existing `waiting_approval` machinery.
- Every outbound email is an **explicit tool call** by the agent
  (`email_send`), never an implicit side effect of replying in chat.

What this buys, for free: history, search, reply threads, the composer,
realtime, unread counts, disclosure provenance, run budgets, the thinking
bubble, and approvals — all already exist on threads. No eighth look-alike.

Channel mechanics: created with the mailbox, `type: 'standard'`,
`systemChannelType: 'agent_email'` (new enum member), in the agent's team,
`visibility` following the agent (`workspace` agent → team-visible channel;
`private` agent → private channel with the owner as sole member — the
established home-DM discipline). One `AgentBinding` to the mailbox's agent.
The channel cannot be unbound or rebound; deleting the mailbox archives it.

### Threading map

RFC 5322 identity ↔ Nessie thread identity is a dedicated join table (not
message metadata, because inbound resolution must be an indexed lookup):

```
model EmailThreadLink {          // email_thread_links
  id, organizationId, mailboxId, threadId
  rfcMessageId  String           // normalized <...> stripped, lowercased
  direction     inbound | outbound
  @@unique([mailboxId, rfcMessageId])
  @@index([mailboxId, threadId])
}
```

Inbound resolution walks `In-Reply-To` then `References` (newest first)
against the mailbox's links; any hit joins that thread, no hit creates a new
thread titled from the subject. Outbound sends record their own generated
`Message-ID` and set `In-Reply-To`/`References` from the thread's newest
inbound link, so both sides' clients thread correctly.

## 3. Data model

```
model AgentMailbox {             // agent_mailboxes
  id, organizationId, agentId @unique      // at most one mailbox per agent
  address        String  @unique          // full lowercased address
  transport      relay | smtp_imap
  domainId       String?                  // -> EmailDomain (custom domain); null = nessie.works
  channelId      String  @unique          // the mailbox channel
  status         active | needs_attention | suspended | deleting
  statusReason   String?                  // remedy-naming, "A schedule that stops says so" discipline
  sendPolicy     approval | auto_reply | auto   @default(approval)
  displayName    String?                  // From: display name; defaults to agent name
  relayAddressId String?                  // relay-side id for provided addresses
  createdByUserId, createdAt, updatedAt
}

model EmailDomain {              // email_domains (custom domains, P2)
  id, organizationId
  domain         String @unique           // lowercased apex or subdomain
  status         pending_dns | verified | failed | revoked
  relayDomainId  String                   // relay-side identity id
  dnsRecords     Json                     // relay-issued DKIM CNAMEs + MX + SPF/DMARC guidance, rendered verbatim
  verifiedAt, lastCheckedAt, createdByUserId
}

model AgentMailboxCredential {   // agent_mailbox_credentials (smtp_imap transport only)
  id, mailboxId @unique
  imapHost, imapPort, smtpHost, smtpPort, username
  secretCiphertext String                 // sealSecret(...) — comms-connect packing, reused
  keyVersion Int @default(1)
  lastImapUidValidity/lastImapUid ...     // sync checkpoint fields
}
```

Facts pinned by this shape:

- **`Agent` gets no email column.** The address lives on `AgentMailbox`; the
  agent presenter joins it. (The 2026-04 doc's `agents.email` is dead.)
- **One mailbox per agent** (`agentId @unique`). Multiple addresses per agent
  is speculative generality; a second agent is cheap.
- **Not a `CommsConnection`.** The comms stack is *a person's* imported
  correspondence feeding their assistant's context, keyed
  `(org, ownerUserId, provider, tenant, externalUser)` with sync jobs and a
  normalized `CommsEvent` store. An agent mailbox is a *live conversational
  surface* with different ownership, lifecycle, and delivery semantics.
  Forcing it into `CommsConnection` would need a nullable owner and a fake
  tenant, and would pour operational agent mail into people's comms memory.
  What **is** reused from that stack: `sealSecret`/`openSecret` credential
  packing, the webhook ingestion pattern (public route → ack → raw snapshot →
  queue → verify in worker), and the `needs_reauthorization`-style
  remedy-naming status discipline.
- Address normalization: local parts lowercased, stored fully qualified.
  Uniqueness of provided addresses is enforced **at the relay** (global
  namespace, §4); the local `@unique` is a mirror, never the authority.

## 4. The provided address — Nessie Mail relay

`nessie.works` is one global namespace across every org and every self-hosted
instance, so provided addresses cannot be minted locally. A small first-party
**Nessie Mail relay** (vendor-operated, SES underneath, same product posture
as Ledger) owns the domain and fronts SES for custom domains too.

Instance-side configuration, Ledger-style — two env vars, fail loudly:

- `NESSIE_MAIL_RELAY_URL` (canonical hosted value, e.g.
  `https://mail.nessie.works`)
- `NESSIE_MAIL_RELAY_KEY` — one deployment-wide, product-bound app key.
  Never a per-user credential, never reused from Ledger/DeepSignal
  (startup key-distinctness check, same as the existing ones).

Unset ⇒ the provided-address option renders as unavailable with the reason;
claiming refuses with `MAIL_RELAY_UNCONFIGURED` rather than persisting a dead
mailbox. SMTP/IMAP transport works without the relay.

Relay API contract (sketch — the relay service itself lives outside this
repo):

| Call | Purpose |
|---|---|
| `POST /v1/addresses` | Claim `{localPart, orgId, agentId, webhookUrl}`. First-come, reserved-word list (`admin`, `postmaster`, `abuse`, `support`, …), returns the full address + per-address webhook signing secret, or `ADDRESS_TAKEN` with suggestions (`support-acme`, …). |
| `DELETE /v1/addresses/:id` | Release (address enters quarantine, not immediate reuse). |
| `POST /v1/domains` / `GET /v1/domains/:id` | Begin custom-domain verification; returns DKIM CNAMEs + MX + recommended SPF/DMARC records and live status. |
| `POST /v1/send` | Outbound send `{from, to, cc, bcc, subject, text, html?, inReplyTo?, references?, attachments (pre-signed fetch URLs or inline ≤ cap)}`. Relay signs DKIM, sends via SES, returns provider message id. |
| Webhooks → instance | `email.inbound` (S3-fetched raw MIME, parsed envelope, SPF/DKIM/DMARC + spam verdicts), `email.bounce`, `email.complaint` — HMAC-signed with the per-address secret. |

Instance side:

- **Inbound route** `POST /api/integrations/email/inbound` — public,
  HMAC-verified against the stored per-address secret (encrypted at rest,
  `ProductWebhookSecret` precedent), ack-fast, snapshot raw, enqueue
  `email.inbound.process`; the worker job parses MIME (one parser in
  `packages/agent-mail`), stores attachments via `FileService`, resolves the
  thread (§2), writes the message, and dispatches the run through the
  existing claim-or-pend discipline (`claimThreadRunOrPend`), exactly the
  `mailbox.ts` pattern.
- The relay is the **only** SES touchpoint. No AWS credentials in Nessie, no
  BYO-SES roles (the 2026-04 `sts:AssumeRole` design is dropped — a customer
  who wants their own infrastructure uses the SMTP/IMAP transport against
  their own mailserver).
- Relay-side abuse control is a relay concern but shapes the contract:
  per-instance and per-org outbound rate limits, mandatory suppression-list
  handling (a hard-bounced or complained address refuses further sends with
  `RECIPIENT_SUPPRESSED`), and inbound spam/virus verdicts delivered with the
  webhook so the instance can quarantine rather than run.

## 5. Sending — permission is layered, and the default is a human approves

The user-visible rule: *agents can send email if they have permission.* Three
layers, each reusing an existing mechanism:

1. **The tool is explicit-grant.** `email_send` is a builtin with
   `requiresExplicitGrant: true`, `safe: false` — invisible until an owner
   grants it per agent from the Tools page (the established
   `toolPolicy[id] === true` gate; Agent Designer filters explicit-grant keys
   already). Having a mailbox without the grant is legitimate: a
   receive-and-summarise agent.
2. **The mailbox has a send policy** (`AgentMailbox.sendPolicy`):
   - `approval` (default) — every send suspends the run via the existing
     approval machinery (`waiting_approval`, checkpoint, in-thread gate
     message). The approval is bound to the **content fingerprint** (sha256
     over canonical to/cc/bcc/subject/body/attachment ids — the Google plan's
     §9 discipline, shared, not forked) so what was approved is what is sent.
     `ApprovalRequest.requiredApproverUserId` (added by the Google plan's P1;
     shared column) pins approval to the agent's steward (`ownerUserId`),
     falling back to `requiredApproverRole: owner` for unowned agents.
   - `auto_reply` — replies within an existing email thread send
     immediately; **new** outbound threads still require approval. This is
     the support-bot mode.
   - `auto` — everything sends immediately. Owner-set only, with the risk
     stated in the UI.
3. **Structural floors that no policy relaxes:** an unattended run
   (trigger/schedule) may send only under `auto_reply`/`auto` and only as a
   reply — an unattended *new* thread always parks an approval; sends to a
   suppressed recipient refuse; per-mailbox outbound rate cap
   (`NESSIE_AGENT_MAIL_MAX_SENDS_PER_HOUR`, default 30) with overflow parking
   as approvals rather than dropping.

Loop protection on the sending side: any non-approved (auto) send stamps
`Auto-Submitted: auto-replied`; the agent never replies to messages that were
posted run-less by the bulk/auto classifier (§2); at most N auto-replies per
thread per hour (default 4) before the thread degrades to `approval` for the
rest of the window.

### The tools

In `packages/runtime/src/builtin-comms-tools.ts` (same slice as the existing
comms builtins), handlers in `worker/src/run/pa-tools/agent-email.ts` — but
**not** `personalAssistantOnly`: any granted agent with a mailbox uses them.

- `email_send` — `{to[], cc?[], bcc?[], subject?, text, attachmentIds?[]}`.
  Called from inside an email thread it defaults to **replying** (recipients
  prefilled from the thread's latest inbound envelope, subject `Re:`-derived,
  RFC threading headers set); outside one, or with explicit recipients, it
  starts a new conversation (and creates/links the thread so the sent mail is
  in the channel too). Attachment ids must be reachable to the run (existing
  attachment ACL), streamed to the transport via `FileService`.
- `email_status` is **not** a tool — delivery state (queued/sent/bounced) is
  rendered as a state note beside the sent message (the resolved-card
  pattern: server-written metadata, `withMessageNotes`), and a bounce posts a
  system line into the thread. The channel is the status surface.

No `email_list`/`email_search` tools either: the mailbox channel is ordinary
conversation history, so the transcript window and the existing conversation
search already cover it. Reuse, never fork.

### Disclosure and trust

- Inbound email is **untrusted third-party content**; the prompt frames it as
  such (existing external-content convention), and instructions inside mail
  are data, not commands — the engagement/act decisions stay model-judged.
- An outbound send is a disclosure to the outside world. The send tool is the
  gate (grant + policy + approval); additionally, if the composing run's
  reply basis is restricted (`runReplyIsRestricted`), `email_send` **refuses**
  — content whose audience is limited inside Nessie cannot be mailed out of
  it. The mailbox channel's messages themselves flow through the normal
  disclosure stamping like any other thread.

## 6. Custom domains (P2)

Owner-only, in `/settings/organization` → **Email domains**:

1. Owner adds `agents.acme.com` → `POST /v1/domains` on the relay →
   `EmailDomain` row `pending_dns` with the relay's DNS records rendered
   verbatim (DKIM CNAMEs, MX to the relay's inbound, recommended SPF +
   DMARC).
2. A worker sweep (and a "Check now" button) polls relay status;
   `verified` unlocks the domain in the mailbox-creation picker.
   Verification failures persist `status`/`statusReason` — the schedule
   health-alert discipline, including the one-time durable `UserAlert` to
   owners on the transition, not a log line.
3. Mailboxes on a custom domain pick any free local part on it (per-domain
   uniqueness is org-scoped at the relay). Revoking a domain suspends its
   mailboxes (`needs_attention`, reason named) rather than deleting them.

DMARC alignment is why custom-domain mail still relays through us: the relay
holds the DKIM keys issued at verification, so `From: acme.com` mail is
signed by `acme.com` keys — never `nessie.works` spoofing a customer domain.

## 7. SMTP/IMAP transport (P3)

The same `AgentMailbox` + channel + tools, different plumbing — configured on
the agent's Email section with host/port/username/password (app password),
sealed via the comms credential packing. Per the mailbox-creation authority
below, creating it is owner-gated like any mailbox.

- **Outbound:** `email_send` dispatches over SMTP (STARTTLS/implicit TLS,
  AUTH) from the worker. Same permission layers, same fingerprint approval,
  same rate caps.
- **Inbound:** no push exists, so a worker poll job per mailbox (default
  every 2 min, jittered) runs IMAP `UIDVALIDITY`/`UID SEARCH` incremental
  fetch against the checkpoint columns, then feeds the **same**
  `email.inbound.process` normalization/threading path as relay webhooks —
  one pipeline, two intakes. Auth failure flips the mailbox to
  `needs_attention` with a remedy-naming reason (never silent retry-forever).
- The plain-`fetch` SSRF rules don't apply (raw sockets, not HTTP), but the
  same egress hygiene does: operator-supplied hosts are resolved and checked
  against the private-range policy the MCP endpoint validation uses, so a
  member can't point IMAP at an internal service and exfiltrate banners.
- Honest capability statement in the UI: an IMAP mailbox is all-or-nothing
  (whoever holds the password reads everything); there is no capability
  catalog to narrow it. Matches the Google plan §11's honesty rule.

## 8. Who can create/manage a mailbox

Mailbox lifecycle is an **owner-level** action (it mints an externally
visible identity for the org), mirrored PA-tool-style later but UI-first:

- **Home:** the agent detail page gets an **Email** section — address (or
  "Claim an address" / transport picker), status with reason, send policy,
  link to the mailbox channel. This is also the Rule-zero doorway from the
  agent.
- **Doorways:** the mailbox channel itself sits in the sidebar like any
  channel; `/settings/organization` → Email domains (P2); the Tools page
  grant row for `email_send` names the mailbox it acts through.
- API: `POST/GET/PATCH/DELETE /api/agents/:agentId/mailbox` (+
  `POST …/mailbox/verify` for smtp_imap connection tests), owner-gated via
  `checkPolicy`, all through one service in `@nessie/workspace-admin` so a
  future PA builtin mirrors the route exactly (the established pattern).
- Deleting a mailbox releases the relay address, archives the channel
  (history retained), and revokes nothing else.

## 9. Metering, audit, limits

- `enum ConnectorType` gains `email`; every send and every processed inbound
  writes `recordConnectorUsage` (`operation: 'send' | 'receive'`,
  `units: recipients | messages`, full run/agent/org attribution). No cost
  fields — commercial rating of relay usage is UOA's, per the standing rule.
- Every send writes an `AuditLog` entry (recipients hashed-or-truncated in
  metadata per audit conventions, approval id when one existed); bounces and
  complaints write audit entries too.
- Inbound attachments ride the existing storage quota + accounting by
  construction (FileService). Inbound message size cap
  `NESSIE_AGENT_MAIL_MAX_INBOUND_BYTES` (default 25 MiB) — oversize mail is
  registered in-thread as a stub naming the reason.

## 10. Phasing

**P1 — provided address, receive, gated send (the product).**
Schema (`AgentMailbox`, `EmailThreadLink`, `agent_email` channel type),
`packages/agent-mail` (MIME parse/build, relay client, inbound pipeline),
relay claim flow + inbound route + worker job, `email_send` with explicit
grant + `approval` policy (content-fingerprint approvals,
`requiredApproverUserId` shared with the Google plan's P1), agent-detail
Email section, mailbox channel surface, ConnectorType + audit. Playwright
verification of the surfaces; mock relay for tests.

**P2 — custom domains + autonomy.**
`EmailDomain` + relay verification + settings surface + health alerts;
`auto_reply`/`auto` send policies with the structural floors and loop caps;
outbound attachments; bounce/complaint state notes.

**P3 — SMTP/IMAP transport.**
Credential storage + connection test, IMAP poll intake into the shared
pipeline, SMTP dispatch, egress hygiene, `needs_attention` lifecycle.

**Later / deliberately not planned:** Gmail-as-agent-transport (covered
conceptually by SMTP/IMAP; revisit only on demand), multiple mailboxes per
agent, human "send as the agent" from the composer, inbound-email
`event`-type triggers for *other* agents (the mailbox agent's engagement is
structural; if a second agent should react to mail, publish an
`email_received` event through the existing `POST /api/events` machinery —
the Google plan already reserved that eventType shape).

## 11. Superseded

[2026-04-07-email-integration.md](2026-04-07-email-integration.md) sketched
this before the comms stack, `AgentTrigger`/delivery model, approval
machinery, `FileService`, and the secret store existed. Its address scheme
(`*.agents.unlikeother.ai`), BYO-SES AssumeRole path, `agents.email` column,
and bespoke `integrations` table are all superseded by this document.
