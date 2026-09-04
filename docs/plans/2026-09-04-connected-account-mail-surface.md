# Connected-account mail surface

Status: implementation plan (2026-09-04)

## Outcome

Give a person a real mail-shaped review surface for accounts already connected
to Nessie. It is intentionally a task surface, not an attempt to replace the
provider's mail client: a person can choose an account, scan threaded mail,
search or narrow it, open the complete conversation, and compose or reply to a
draft an agent prepared.

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
3. An agent-produced Gmail draft card offers **Open in Mail**. Existing generic
   agent cards can link to a returned `reviewUrl`, so an agent can hand a person
   a narrowed result set without a new email-specific card renderer.
4. Inside Mail, a thread row opens the reading surface, **New email** opens the
   compose flow, and **Reply** opens the same compose flow with structural reply
   context.

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
- provider-backed paging under one shared contract, with the standard
  10/25/50/100 size choices and result range.

Gmail's provider thread id is the thread identity. SMTP/IMAP threading is
structural: `Message-ID`, `In-Reply-To`, and `References` form a conversation;
messages without those links remain separate rather than being merged by a
subject heuristic. The provider remains the mail store: the server may return
an opaque thread token, but it does not persist messages or a second mailbox.

### Reading pane

The conversation is oldest-first. Each message shows sender, To/Cc disclosure,
time, body, and attachment metadata. Provider HTML is sanitized before it
crosses the API boundary; remote content remains blocked until the reader asks
to load it. A plain-text message uses the same body component. The current
slice does not download attachments from connected accounts.

### Compose and reply

One compose Flow serves new messages, replies, human drafts, and an agent's
existing Gmail draft. It contains From, To, Cc/Bcc, Subject, and Body; recipient
syntax and required fields are validated in place. `useDraft` owns unsent local
state under `draft:mail-compose:<source>:<accountId>:<identity>` so Back never
loses work and one account's draft cannot appear in another.

- Gmail creates/updates the provider draft through the existing
  `GmailDraftAction` service, then uses the existing fingerprint check and undo
  hold to send.
- SMTP/IMAP keeps unsent human text locally and sends directly only from the
  mailbox owner/team member's explicit click. An agent still uses
  `mailbox_send`, which remains pinned to a person and structurally approval
  gated.
- Reply context supplies the real provider thread id or `In-Reply-To` identity;
  it never infers a reply from subject text.

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

Entitlement, credential loading, provider dispatch, and status transitions live
in a shared `@nessie/team-admin` mail service. Gmail reads reuse
`@nessie/comms-google`; SMTP/IMAP reads reuse `@nessie/agent-mail`. Credential
rejection updates the existing connection-health state, while transient network
failure does not pretend that reauthorization is the remedy.

## Agent and MCP parity

Do not create a fourth ambiguous email tool family. The existing families stay
the public agent capability:

- `gmail_search`, `gmail_thread_read`, `gmail_draft_create/update/send`;
- `mailbox_search`, `mailbox_read`, `mailbox_send`.

The implementation moves the shared provider operations used by the new REST
surface behind the same `@nessie/team-admin` seams the tools call. The agent
tools keep their stronger run-specific obligations: effective-user resolution,
disclosure-sink stamping, per-connection agent access, and structural approval
for connected-mailbox sends. A human route never weakens those gates.

Search/list tool results return a `reviewUrl` scoped to the account and query;
Gmail draft cards return an **Open in Mail** doorway. `card_post` remains the
single renderer for an agent-curated email overview — a dedicated `email_card`
kind is forbidden.

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
- Agent read paths continue stamping the disclosure sink before provider I/O.
- Agent sends continue through the existing approval gate; no standing send
  grant is introduced for shared SMTP/IMAP mailboxes.

## Implementation slices

1. **Contracts and provider services.** Normalized schemas; Gmail paging/read
   adapters; IMAP flags, structural headers, paging/threading, and bounded body
   reads; shared account entitlement and provider dispatch; focused unit tests.
2. **API and agent parity.** Thin routes, no-store responses, human compose/send,
   existing tool refactor, review URLs and Gmail draft doorway; route/service
   authorization and redaction tests.
3. **Admin surface.** Facade, routes and navigation registry, settings doorways,
   reusable mailbox workspace, responsive thread/read views, compose/reply with
   drafts, query and component tests.
4. **Integration and documentation.** Update the connected-mailbox guide,
   functionality table, navigation route inventory and this plan's status.

## Verification

- Package tests run through Turbo, with `DATABASE_URL` exported when present.
- Root lint, typecheck, and lint-gated build pass.
- API tests prove personal-owner, shared-team-member, manager, cross-org, stale
  membership, missing capability, credential rejection, no-store, and audit
  redaction cases.
- Provider tests cover Gmail page tokens and thread reads; IMAP threading covers
  references, replies, unlinked same-subject mail, unread flags, ordering, and
  counted-literal inputs.
- Admin tests cover route totality, deep links, Back behavior, selected thread,
  account/filter/search URL state, compose draft isolation, Gmail draft open,
  reply context, validation, send/undo, and no duplicate mailbox component.
- Playwright loads `http://localhost:5455` headlessly at phone, tablet, and
  desktop sizes, captures account list, thread list, conversation, and compose,
  and exercises open → reply → draft restore → send/undo against deterministic
  provider fixtures.

## Deliberate non-goals for this slice

- becoming the user's primary email client;
- syncing or storing connected-account messages in Nessie;
- connected-account attachment download/upload;
- SMTP/IMAP folder mutation, archive, delete, or mark-read;
- Microsoft mail before that connector exposes a mail capability;
- a new email-specific chat-card renderer or an agent bypass of send approval.
