# Connected-account mail surface

Status: implemented; verified with the gaps recorded below (2026-09-05)

Correction (2026-09-05): the previous record read "implemented and verified" and
restated claims this repository does not support. An adversarial review found a
stored XSS in the shared mail sanitizer, an unpinned `mailbox_send` approval, a
Gmail undo-hold bypass, and unbounded IMAP response aggregation; all four are
fixed, and the verification record below now separates what is proven by a test
from what is not.

Implementation note (2026-09-04): the live provider, entitlement, REST,
`/mail`, and agent-presentation slices are implemented for Gmail and
SMTP/IMAP. Provider mail remains live and no-store. The chat integration can
present an account, thread, or compose doorway; render a bounded mail preview;
and collect a compose form without giving a card press send authority.

## Outcome

Give a person a real mail-shaped review surface for accounts already connected
to Nessie. It is intentionally a task surface, not an attempt to replace the
provider's mail client: a person can choose an account, scan threaded mail,
search or narrow it, open the complete conversation, and compose or reply to a
draft an agent prepared. An agent can also bring that same surface into the
conversation: open a review or compose popup for an entitled viewer, leave a
reopenable doorway in chat, and post a concise email preview or editable compose
form through the universal agent-card system.

The surface covers the two connected-account lanes that already have mail
capabilities:

- a person's Google connection, live through Gmail's API;
- personal and shared SMTP/IMAP `MailboxConnection`s, live through IMAP and
  SMTP.

Slack and Microsoft connection rows are not presented as mail accounts until
their connector has an implemented mail capability. The hosted address owned
by an agent remains at `/agents/:agentId/mailbox`; it reuses the same visual
mail components but is not a connected account.

## Home and doorways

The owning surface is `/mail`. It belongs to the Admin navigation stack but is
not a sixth permanent rail item: this is a contextual work surface, not a daily
inbox product.

Doorways:

1. A Gmail connection on **Connected accounts** offers **Open mail** when
   `gmail.read` is usable.
2. Each personal or shared SMTP/IMAP connection offers **Open mail** to a caller
   entitled to read it.
3. An agent-produced Gmail draft leaves a restricted **Open mail** doorway.
   Existing generic agent cards can present a returned mail doorway, so an agent
   can hand a person a narrowed result set without a new email-specific card
   renderer.
4. Inside Mail, a thread row opens the reading surface, **New email** opens the
   compose flow, and **Reply** opens the same compose flow with structural reply
   context.
5. `mail_present` can open the same review or compose surface over the active
   conversation and leaves an **Open mail** chip in the message that announced
   it. Closing the popup is final for that announcement; it never reopens itself.

Routes are declared in the navigation registry:

- `/mail` — entitled account chooser;
- `/mail/:source/:accountId` — one account's thread list;
- `/mail/:source/:accountId/threads/:threadId` — conversation detail; a nested
  screen on `single`, inline reading pane on `split`;
- `/mail/:source/:accountId/compose` — a Flow, with optional URL state naming a
  reply thread or an existing Gmail draft.

`source` is the closed vocabulary `gmail | mailbox`. The provider id remains an
opaque account id; no route guesses a provider from the id.

## What the interface shows

### Account chooser

Every entitled mail account is one row with provider, human label/address,
personal/shared scope, health, and the actions it actually supports. Personal
SMTP/IMAP accounts are visible only to their owner. A shared mailbox is visible
to members of its team, with management remaining owner/admin-only on its
settings home. Gmail is visible only to the connection owner. Capability and
health failures are visible in place with a link back to the appropriate
connection settings.

### Thread list

The fixed-height mail workspace owns its scrollers. The list has:

- account switcher and search;
- `All` / `Unread` filters through the shared `TabBar`;
- sender, subject, provider snippet when available, latest timestamp, unread
  emphasis, attachment marker, and message count;
- one selected-row treatment and an explicit empty/error/loading state;
- provider-backed cursor paging under one shared contract, with the standard
  10/25/50/100 size choices, previous/next controls, and an estimate only when
  the provider supplies one. Gmail never pretends its estimate is an exact
  result count.

Gmail's provider thread id is the thread identity. SMTP/IMAP threading is
structural: `Message-ID`, `In-Reply-To`, and `References` form a conversation;
messages without those links remain separate rather than being merged by a
subject heuristic. The provider remains the mail store: the server may return
an opaque thread token, but it does not persist messages or a second mailbox.

#### Threading and paging contract

Gmail uses its native thread identity and opaque `nextPageToken`. IMAP threading
is always structural, in this slice: every page load fetches a bounded
newest-first header window, builds reference-linked
threads inside that window, and orders them by the newest member visible in the
window. An older page may reveal earlier members of the same conversation; the
UI says **Earlier messages** rather than claiming that every provider has
returned an exhaustive thread.

`ImapSession` carries `capabilities()` and `threadReferencesUids` for a future
server-side `THREAD=REFERENCES` path, but **no production code calls them**: the
structural window above is the only threading this slice performs, on every
server. Deciding whether to adopt native threading is deliberately left open —
it interacts with the thread-token and cursor design, which are both built
around the window model. Until it is wired, treat those helpers and their tests
as unreached.

An IMAP thread token is a compact, signed, list-issued capability bound to the
account, folder, selected `UIDVALIDITY`, structural root digest, and stable
UID seed. It deliberately carries neither a membership list nor a count:
both change when a new reply arrives. On read, the server re-derives a bounded
current group from the signed seed's structural headers, then authenticates its
root and seed before fetching bodies. A list request scopes every IMAP search
to one 100-UID window — never `THREAD ALL` or `SEARCH ALL` — and a reader
follows the root through at most 20 windows and 500 related-message candidates.
Reaching either cap is surfaced as potentially earlier mail. An unthreaded
message with no usable `Message-ID` incorporates
`UIDVALIDITY` and UID in its digest, so empty header values cannot collide and
folder reset semantics are explicit. Every emitted IMAP cursor carries the
selected `UIDVALIDITY`; a reset is rejected rather than continuing a stale
page. The bounded member slice can mean earlier messages exist. `All` uses
provider-native search; `Unread` adds Gmail `is:unread` or IMAP `SEARCH
UNSEEN`. A page load uses one provider dial at a time per account, bounded
header and body fetches, and no polling refetch; refresh is a person's explicit
action.

### Reading pane

The conversation is oldest-first. Each message shows sender, To/Cc disclosure,
time, body, and attachment metadata. Provider HTML is sanitized before it
crosses the API boundary by the existing `@nessie/agent-mail` MIME sanitizer,
which parks accepted remote URLs on `data-blocked-src`. The pane reuses
`EmailMessageBody`'s reveal contract verbatim, so remote content remains blocked
until the reader asks to load it. A plain-text message uses the same body
component. The current slice does not download attachments from connected
accounts.

### Compose and reply

One compose Flow serves new messages, replies, human drafts, and an agent's
existing Gmail draft. It contains From, To, Cc/Bcc, Subject, and Body; recipient
syntax and required fields are validated in place. `useDraft` owns unsent local
state under
`draft:mail-compose:<userId>:<organizationId>:<source>:<accountId>:<identity>`
so Back never loses work, one account's draft cannot appear in another, and a
shared browser cannot restore one signed-in person's words for the next.

From is display-only and is pinned again on the server to the connected address
or to an already-verified alias selected from a closed list. The client cannot
supply an arbitrary sender. The value persisted through `useDraft` contains
only human-editable outgoing text. Reply context and any quoted history render
from the live no-store conversation beside the form and never enter
`localStorage`; automatic provider-body quoting is out of scope for this slice.

- Gmail creates/updates the provider draft through the existing
  `GmailDraftAction` service, then uses the existing fingerprint check and undo
  hold to send. Create requests carry a stable client idempotency key and are
  persisted before Gmail is called. A lost create/send response becomes the
  human-visible, non-retryable `delivery_unknown` state; no worker reclaims or
  repeats an externally ambiguous Gmail request. Agent-created drafts derive
  the same action identity from the durable run and tool-call id. Undo returns
  the same composer to that provider draft instead of stranding it.
- SMTP/IMAP keeps unsent human text locally and sends directly only from the
  mailbox owner/team member's explicit click. An agent still uses
  `mailbox_send`, which remains pinned to a person and structurally approval
  gated. The human SMTP route records a body-free action, client idempotency
  key, and stable Message-ID before delivery. A transport outcome after claim
  is `delivery_unknown`, not a retryable send; replaying the same key returns
  the durable result or refuses without another SMTP call.
- Reply context supplies the real provider thread id or `In-Reply-To` identity;
  it never infers a reply from subject text.

#### Delivery and provider-draft recovery

Recipient fields are parsed locally with the shared `ConnectedMailComposeInputSchema`
before either create, update, or send mutation; the API remains the final schema
authority. Gmail action identity is persisted before a provider request and is
reconciled through an owner-only, content-free status read after reload. Only a
future `sending` deadline offers Undo. Expired `sending`, `dispatching`, and
`updating` stay locked while status is checked; `sent` confirms delivery;
`delivery_unknown` and `update_unknown` never reopen a resend path. The latter
offers a deliberate blank-composer escape only after the owner has checked
Gmail, and no old content or action id is reused.

Provider drafts with attachments or non-plain MIME are not flattened through a
PATCH. The owner sees attachment metadata and an explicit Gmail doorway instead
of a local Send control. Gmail MIME parsing has bounded headers, parts, depth,
attachment count, filename bytes, response bytes, and decoded-body bytes.

An SMTP action replay that encounters a live `dispatching` claim returns that
content-free action state, polls it, and never dials SMTP again or terminalizes
it early; only the two-minute stale-claim sweep may mark it
`delivery_unknown`.

`gmail_draft_send` approvals fetch the same exact frozen To/Cc/Bcc/subject/body
preview contract as `mailbox_send`, but from a pinned owner-only route. The
preview is read only while the approval is pending, is removed from the query
cache on resolution, and the approved Gmail action still validates its pinned
content fingerprint.

## Agent-driven presentation in chat

Presentation is an agent capability, not a second mail implementation.
`mail_present` is a non-safe UI-posting tool whose closed modes are `account`,
`thread`, and `compose`. It accepts an explicit `source` and `accountId`, plus
the provider thread or draft reference required by the mode. For
`source=mailbox`, it runs
the identical authorization chain as `mailbox_search` and `mailbox_read`:
effective-user resolution, the per-`(connection, agent)` access row, live
personal ownership or shared-team membership, and ambiguity refusal. For
`source=gmail`, the effective user must own the Google connection. The shared
`/api/mail` account lookup is resource resolution underneath those decisions,
never a substitute for them. The tool records the personal-user or shared-team
scope in the run's `ConsumedSourceSink` and only then publishes its result. It
never accepts recipients or a body and it cannot send mail.

The tool writes an ordinary agent-authored message with a small
`mailSurfaceDoorway` metadata pointer: source, account id, mode, and an optional
thread/draft id. Search text, snippets, recipients, subject, and body never enter
that metadata. The client evaluates an offer when an authorized doorway message
first becomes visible, whether it arrived live or appeared after the restricted
run's refetch. A per-doorway id in `sessionStorage` records that it was offered
or dismissed without storing mail data. Historical messages render only the
reopenable chip; changing threads, reloading, closing, or minimizing never
causes an old request to seize focus. The popup uses `useOverlay` and the
navigation Back contract, becomes a full-screen Flow on a phone, and reuses the
same `MailboxWorkspace`, `MailConversation`, and `MailCompose` components as
`/mail`.

Opening is presentation, never authority. The client live-fetches through the
normal no-store mail routes, and every open rechecks the signed-in viewer's
current entitlement. The message itself inherits the run's disclosure basis;
an ineligible viewer gets neither its preview nor a working doorway. An agent
cannot target another person's browser or create a global popup: only clients
currently viewing the conversation that received the authorized message may
auto-open it.

The existing universal `AgentCard` supplies embedded chat content:

- a preview uses `fields` for sender, subject, date, and account plus a bounded,
  model-authored `text` summary; it does not persist or reproduce the complete
  inbound provider body;
- a compose card uses existing `input` blocks for To, Cc, Bcc, Subject, and
  Body and ordinary submit/dismiss actions; the textarea limit is raised only
  as far as a useful email draft requires;
- a card action creates the usual real user response and wakes the card's
  agent. The agent then updates a Gmail provider draft or prepares the explicit
  SMTP send. A button labelled **Send** still enters the existing Gmail
  grant/approval decision or the mandatory `mailbox_send` approval gate; a card
  press is not a send-authorization shortcut.

These cards are deliberately durable conversational answers, and therefore
carry the same disclosure basis as any agent reply derived from connected mail.
That is distinct from syncing provider mail into Nessie: no bulk body, mailbox
index, or provider draft mirror is created. Gmail's provider draft stays the
source of truth. SMTP/IMAP compose-card text is an agent-authored draft retained
as part of the chat artifact; the standalone compose Flow keeps human-only
unsent text in `useDraft`.

## One contract from provider to pixel

Add domain-owned contracts in `@nessie/schemas`:

- `ConnectedMailAccountRecord`;
- `ConnectedMailThreadSummary` and paged response metadata;
- `ConnectedMailMessage` / `ConnectedMailConversation`;
- account-list, thread-list/search, conversation-read, compose, and send input
  schemas.

The admin consumes these through one `facades/mail` family and TanStack Query.
Provider adapters normalize at the server boundary; page components never
branch on Gmail response JSON or IMAP protocol shapes.

The API routes remain thin:

- `GET /api/mail/accounts`;
- `GET /api/mail/accounts/:source/:accountId/threads`;
- `GET /api/mail/accounts/:source/:accountId/threads/:threadId`;
- `POST /api/mail/accounts/:source/:accountId/drafts`;
- `PATCH /api/mail/accounts/:source/:accountId/drafts/:draftId` for a provider
  draft;
- `POST /api/mail/accounts/:source/:accountId/send` for an explicit human send.

The draft routes are Gmail-only. `source=mailbox` refuses them with
`CAPABILITY_UNSUPPORTED`; SMTP/IMAP human drafts remain local, and implementers
must not invent an IMAP draft mirror. The shared page contract is
`{ items, nextCursor?, previousCursor?, estimate? }`: cursors are opaque and an
estimate is never rendered as an exact total.

Entitlement, credential loading, provider dispatch, and status transitions live
in a shared `@nessie/team-admin` mail service. Gmail reads reuse
`@nessie/comms-google`; SMTP/IMAP reads reuse `@nessie/agent-mail`. Credential
rejection updates the existing connection-health state, while transient network
failure does not pretend that reauthorization is the remedy.

Gmail list metadata runs with at most eight provider requests in flight. Mail
reads stop the provider response stream at 512 KiB per request, cap aggregate
HTTP input at 2 MiB and decoded body input at 256 KiB, then apply the normalized
message limits. Oversized provider success and error bodies are refused before
they can be buffered in full.

## Agent and MCP parity

Do not create a fourth ambiguous email tool family. The existing families stay
the public agent capability:

- `gmail_search`, `gmail_thread_read`, `gmail_draft_create/update/send`;
- `mailbox_search`, `mailbox_read`, `mailbox_compose`, `mailbox_send`.

`mail_present` is the one provider-neutral presentation tool. It does not read,
draft, mutate, or send provider data, so it does not collapse the deliberately
separate Gmail and SMTP/IMAP resource families. Its output includes the created
message id and canonical `reviewUrl`; provider search/read/draft tools also
return presentation references that the agent may pass to it without copying
mail content through arguments.

The implementation moves the shared provider operations used by the new REST
surface behind the same `@nessie/team-admin` seams the tools call. The agent
tools keep their stronger run-specific obligations: effective-user resolution,
disclosure-sink stamping, per-connection agent access, and structural approval
for connected-mailbox sends. A human route never weakens those gates.

Search/list tool results return a `reviewUrl` scoped to the account and provider
reference; search text is not encoded into a durable URL or message. Gmail
drafts return an **Open mail** doorway. `card_post` remains the single
renderer for an agent-curated email preview or compose form — a dedicated
`email_card` kind is forbidden.

### Implemented presentation

The worker foundation now provides strict, content-free `mailSurfaceDoorway`
metadata and the provider-neutral `mail_present` builtin. Its mailbox branch
uses a shared presentation-access seam for the effective requester,
per-agent connection access, live organisation and team entitlement, and
ambiguity refusal. Its Gmail branch requires the current requester to own the
named active Google connection. Both branches record the account's disclosure
scope before writing the ordinary agent message and publish only the normal
restricted-aware message event. The tool accepts no mail content and has no
send path.

`mailbox_compose` returns a `card_post`-compatible universal form
template. A card response is only a normal user turn; a later `mailbox_send`
call still takes the existing pinned approval path. Gmail tool results carry a
content-free presentation reference and canonical review URL, while connected
mailbox search/read results carry an account doorway instead of pretending an
IMAP message id is a portable thread id. The client resolves every doorway
through the live entitlement-gated API before it renders mail content.

## Reuse and component shape

Extract the existing hosted-agent mailbox's visual pieces rather than building
a second mailbox:

- `MailboxWorkspace` — bounded split/single layout and scroller ownership;
- `MailThreadList` / `MailThreadRow`;
- `MailConversation` / `MailMessage`;
- `MailCompose`.

`AgentMailboxPage` supplies its stored-mail facade to those components;
`ConnectedMailPage` supplies the live connected-mail facade. Shared components
take normalized view data and callbacks, never fetch directly. `ScreenHeader`,
`TabBar`, `QueryState`, `RowList`, `PaginationFooter`, form controls, `useDraft`,
and the navigation framework remain the only primitives for their jobs. All new
colour is expressed through existing tokens in `styles.css`.

## Security and privacy

- Every account lookup is scoped by live actor entitlement and organisation;
  unknown, foreign, and no-longer-entitled ids are indistinguishable.
- Every cookie-authenticated `/api/mail` mutation requires an allowed `Origin`,
  `Content-Type: application/json`, and a non-empty validated body. Foreign,
  missing-origin browser, simple-form, empty-body, and wrong-content-type
  requests are refused before provider work. Gmail REST send still re-reads the
  live provider draft, compares the reviewed fingerprint, and claims the send;
  the human route does not bypass that service. A claim never retries a stale
  Gmail provider request: its outcome is marked `delivery_unknown` instead.
- No connected-account message, snippet, recipient, search, or draft body is
  persisted by the new read surface or written to logs/audit metadata.
- Read responses set `Cache-Control: no-store` and are not placed in a durable
  server cache. Client query data is cleared by the existing sign-out path.
- IMAP folder/search inputs remain counted literals; hosts are re-resolved and
  re-vetted on every connection; TLS and hostname verification stay mandatory.
- HTML crosses the API only after the shared sanitizer. Remote images stay
  blocked by default.
- Human sends audit account id/source and outcome only — never recipients,
  subject, body, username, or credential material.
- Gmail's audit trail names held, undone, sent, and ambiguous-delivery states
  separately. A stale claim is audited only by the worker that atomically wins
  its transition to `delivery_unknown`; a held draft is never reported as sent.
- From is server-derived from the entitled connection or a verified alias;
  client-supplied sender text is rejected rather than trusted.
- Agent read paths continue stamping the disclosure sink before provider I/O.
- `mail_present` records account scope even when it presents a reference already
  known to the model, and every popup open repeats viewer authorization.
- Auto-open delivery is conversation-local, offered once, and carries no mail
  body or compose data on the realtime event.
- Agent sends continue through the existing approval gate; no standing send
  grant is introduced for shared SMTP/IMAP mailboxes.

## Implementation slices

1. **Contracts and provider services.** Normalized schemas; Gmail paging/read
   adapters; IMAP flags, structural headers, paging/threading, and bounded body
   reads; shared account entitlement and provider dispatch; focused unit tests.
2. **API and agent parity.** Thin routes, no-store responses, human compose/send,
   existing tool refactor, `mailbox_compose`, `mail_present`, review URLs,
   disclosure-stamped doorway messages, and Gmail draft doorway; route/service,
   authorization, presentation, and redaction tests.
3. **Admin surface.** Facade, routes and navigation registry, settings doorways,
   reusable mailbox workspace, responsive thread/read views, compose/reply with
   drafts, the conversation-owned mail popup/chip, universal preview/compose
   card fixtures, query and component tests.
4. **Integration and documentation.** Update the connected-mailbox guide,
   functionality table, navigation route inventory and this plan's status.

## Verification

Verification is recorded against the merged implementation, not inferred from
the individual slices. The deterministic browser harness owns the full Mail and
chat-doorway flows; package suites own the provider, entitlement, disclosure,
and route contracts. Database-backed suites must run against an explicitly
exported, isolated `DATABASE_URL`; a run whose database tests skipped is
reported as such rather than counted as database coverage.

### Final verification record (2026-09-04)

An isolated PostgreSQL `DATABASE_URL` was exported for the database-backed
runs (isolated test port and database; credentials are intentionally omitted).
The focused eight-package Turbo matrix passed **34/34**, as did `pnpm lint`,
`pnpm typecheck`, and the lint-gated `pnpm build`. The headless connected-mail
Playwright suite passed across desktop, tablet, and 200%-zoom phone views,
including chat popup and compose doorways and the standalone approvals surface:
the exact Gmail To/Cc/Bcc/subject/body preview held **Approve** disabled until
it loaded, then enabled it and captured `approvals-mail-send-preview.png`.

The adversarial review also verified the exact one-use,
continuation-bound approval proof; no blind approval path; fail-closed SMTP and
Gmail outcomes; bounded provider reads; local MIME preflight; and safe retention
of the Gmail source draft after direct send.

- Package tests run through Turbo, with `DATABASE_URL` exported when present.
- Root lint, typecheck, and lint-gated build pass.
- API tests prove missing capability, Gmail credential rejection, no-store on
  the account and send-action reads, and a client-supplied From (asserted by
  error code against a payload that is otherwise complete). The mutation
  origin/JSON/empty-body refusals are proven on `POST /drafts`; the other two
  mutations share the one guard but are not separately exercised.
  **Not covered by a test:** cross-org, stale membership and manager access at
  `/api/mail` (the account-scoping `where` is asserted, not evaluated against
  seeded rows); IMAP credential rejection; and human-send audit redaction, since
  no API test reaches a successful send. `mail_present`'s deactivated-owner and
  non-member cases *are* covered, but that is the agent path, not the route.
- Provider tests cover Gmail page tokens and thread reads; IMAP threading covers
  references, replies, unlinked same-subject mail, unread flags, ordering, and
  counted-literal inputs, window boundaries, `UIDVALIDITY`, stable thread tokens,
  and the per-command response budget that bounds a hostile server. The
  `THREAD=REFERENCES` helpers are tested but unreached by production code (see
  "Threading and paging contract").
- Admin tests cover route totality, deep links, Back behavior, selected thread,
  account/filter URL state, session-only search, compose draft isolation and
  exclusion of provider quotes, Gmail draft open,
  reply context, validation, send/undo, auto-open once, no reopen after dismiss,
  restricted-message refetch offering, missing agent-access-row refusal,
  unauthorized doorway refusal, universal preview/compose cards, and no
  duplicate mailbox component.
- Playwright loads `http://localhost:5455` headlessly at phone, tablet, and
  desktop sizes, captures account list, thread list, conversation, and compose,
  and exercises settings doorway → open → reply → draft restore → send/undo plus
  agent preview card → mail popup → dismiss/reopen and compose-card → approval
  against deterministic provider fixtures. It verifies focus enters and returns
  from the popup with an announcement, listbox/grid semantics and
  `aria-selected`, a non-colour unread indicator, keyboard use of remote-content
  reveal, reduced motion, layout at 200% zoom, and the owning `/approvals`
  mail-send preview before approval.
- **Weaknesses in this suite, recorded rather than implied away.** Several
  admin assertions match the component's *source text* rather than rendering it,
  so a refactor that preserves the strings and breaks the behaviour stays green.
  The reduced-motion and 200%-zoom steps capture a screenshot without asserting
  on it. The `Unread` filter is never clicked, so `unreadOnly` has no end-to-end
  coverage. The e2e fixture's send response does not match the route's actual
  shape. Every `/api/**` call is intercepted in the browser, so this job gates
  the UI against fixtures — no API or provider code runs in it.

## Deliberate non-goals for this slice

- becoming the user's primary email client;
- syncing or storing connected-account messages in Nessie;
- connected-account attachment download/upload;
- SMTP/IMAP folder mutation, archive, delete, or mark-read;
- Microsoft mail before that connector exposes a mail capability;
- a new email-specific chat-card renderer or an agent bypass of send approval.

The IMAP reader requests `BODYSTRUCTURE` with its header fetches, so list rows
can accurately mark attachments without downloading them. Conversation reads
use portable `BODY.PEEK[section]<0.n>` text-section fetches (256 KiB per
section), decode and sanitize the selected plain-text or HTML part, and retain
the 100,000-character decoded-body and 2 MiB aggregate-response limits.
Attachment download remains out of scope. Servers that omit or malform
`BODYSTRUCTURE` cannot provide a body through this bounded reader; the message
is omitted rather than falling back to a whole-message fetch.
