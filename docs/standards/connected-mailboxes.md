# A connected mailbox is somebody else's store

Authoritative standard, in the shape [`AGENTS.md`](../../AGENTS.md) points to:
`AGENTS.md` carries the one-line invariant and links here; **this file is the
rule**. Its companion is [`agent-email.md`](agent-email.md) — the *hosted*
mailbox, where Nessie is the mail store. This one is the opposite case.

- **A connected mailbox is somebody else's store, and reaching it takes two
  decisions, not one.** SMTP/IMAP connections (agent email Model A) let an agent
  work in a mailbox that already exists — a person's own, or a team's shared
  `support@`. Nothing is synced and no mail is stored: reads run live, which is
  the whole difference from a hosted mailbox. The properties that carry it:
  **an access row per `(connection, agent)`**, because `Agent.toolPolicy` is
  keyed by tool id and cannot name a resource — a bare tool grant would silently
  widen to every mailbox connected afterwards; **the effective user for a
  personal mailbox**, so a shared agent cannot read your inbox by being
  mentioned in a public channel, while a team mailbox is shared by construction
  and the access row is the whole decision; **ambiguity is refused, never
  guessed**, since sending from the wrong address cannot be taken back; and
  **every send is approved and pinned** to the personal owner or the shared
  mailbox's installer, live-checked, with any source the recipient cannot reach
  named on the request. A pin is also the approval's read and delivery audience:
  its card/reason, alert, and pending/resolved realtime events reach only that
  exact active person, whose existing Approvals home remains reachable even
  outside the source channel. The list remains address/body-free; when that
  person chooses **Review email**, a short-lived server projection materializes
  the frozen sender, recipients, subject and body for an explicit confirm. It
  is evicted from the browser cache on close or resolution and never copied into approval context, audit,
  tool metadata, or websocket data. A missing or
  inactive accountable person (the personal owner or shared installer) denies
  the send rather than creating an unpinned or unanswerable approval: an owner
  or admin reconnects a shared mailbox under an active approver, while a
  personal mailbox needs its owner reactivated or reconnected. Standing send
  grants are deliberately absent: a grant is
  the mailbox owner's to give about their own account, and a shared mailbox has
  no such owner. The reads feed the disclosure sink with the connection's scope
  in the same call that puts mail in the window — user scope for a personal
  mailbox, team for a shared one — so an agent answering out of your mailbox
  produces a reply only you can see. On the wire: TLS is mandatory (a server
  that omits STARTTLS is a downgrade, not a fallback), the host is re-resolved
  and re-vetted through the shared `resolveVettedAddresses` on **every** dial and
  the socket opens to that literal address with SNI and certificate checked
  against the *configured hostname*, and every caller-supplied value — folder
  name, search term, credential — is a counted IMAP literal, so injection is
  structurally impossible rather than a validation somebody must remember.
  The as-built detail is below; the plan is
  `docs/plans/2026-09-02-agent-email.md` §2.2–2.3 and the guide is
  `docs/connected-mailboxes.md`.

Plan and as-built deltas:
[`docs/plans/2026-09-02-agent-email.md`](../plans/2026-09-02-agent-email.md)
§2.2–2.3. Operator and user guide:
[`docs/connected-mailboxes.md`](../connected-mailboxes.md).

## As built

- **Three tool families, deliberately disjoint.** `mailbox_search` /
  `mailbox_read` / `mailbox_send` act on a connected mailbox; `gmail_*` acts on
  the requesting person's Google account through Google's API; `email_*` acts on
  the agent's own hosted mailbox and takes no handle at all. An agent holding
  two of them must never have an ambiguous send path, which is why they are
  three families rather than one with a mode.
- **One panel, two homes** (`components/features/mailbox-connections/`): personal
  mailboxes on `/settings/connections`, shared ones on `/settings/organization`,
  scope as a parameter — the `CloudBrowserPanel` shape. Both carry per-agent
  access rows: a connection no agent may use does nothing. Connecting tests both
  legs before it stores, and only a provider rejection (`auth`-kind) flips a
  connection to `needs_reauthorization`. That conditional health transition
  increments its revision and creates one content-free `UserAlert` pointing to
  its owning personal or shared mailbox surface; reconnect resolves the prior
  revision and is an explicit credential
  replacement that retains the connection and its agent-access rows. The personal Email doorway is
  address-first: a server-approved Google or Microsoft OAuth route starts its
  native connector, while a reviewed IMAP/SMTP route keeps its server details
  hidden until the person chooses Advanced settings. A team shared mailbox stays
  Model A-only and never starts a personal OAuth connection.
- **Account lifecycle is available from the Personal Assistant without making
  chat a credential surface.** `email_account_list` returns the exact kind and
  id for every Google/Microsoft account the person owns and every SMTP/IMAP
  mailbox they may administer — personal mailboxes for their owner, plus shared
  mailboxes only for an organisation owner or admin. It deliberately does not
  reuse the broader member-visibility list, because a visible shared mailbox is
  not necessarily mutable. Every lifecycle action that reads an account — list,
  check, disconnect, or an agent-access change — stamps the acting person's user
  disclosure basis before its model-visible result and emits only structural
  connection-state remedies, never provider/server diagnostics. `email_account_connect`
  posts a doorway into the
  same address-first form used by Settings; it accepts no password, server, or
  OAuth-code argument, and refuses a team-scope doorway for a non-manager before
  it posts anything. `email_account_check` invokes the same provider resync or
  live two-leg mailbox test as the account card, and
  `email_account_disconnect` is structurally approval-gated before it invokes
  the same disconnect service. `email_account_agent_access` changes only the
  per-`(connection, agent)` row: it never silently rewrites that agent's tool
  policy. These lifecycle tools are Personal-Assistant-only and stay separate
  from the independently grantable `mailbox_search` / `mailbox_read` /
  `mailbox_send` content tools. Their schemas reject undeclared fields before a
  policy or approval record can observe them, so a secret-shaped extra argument
  never becomes durable approval state.
- **Standing Google consent is a separately bounded exception.** Direct settings
  grants and the approval-card shortcut both use the same shared write boundary:
  an active Google connection owned by the granter and an eligible non-system
  agent in that organization are required at the final write. The shortcut only
  accepts a live pinned `tool.invoke` approval that froze the exact connection;
  connected-mailbox and lifecycle approvals remain one-time decisions.
- **Correspondence never becomes operational telemetry.** Exact recipients,
  addresses, subjects, bodies, attachment/provider responses, credentials and
  server details remain only in the authorized run context and, for an approved
  send, the server-owned frozen resume arguments and action hash. Approval
  context, ToolCall rows, thinking and realtime status, demonstrations,
  connector telemetry, and audit metadata carry only a fixed action/outcome
  summary. The same boundary covers connected-mail, Gmail, contact, and
  connected-account lifecycle tools; a provider failure becomes a stable remedy
  rather than raw remote text.
- **Approval continuations execute a frozen action, never a model recreation.**
  `ApprovalRequest.resumeState` retains the strict, server-owned canonical
  arguments. The continuation queue carries only the approval id and its
  one-time proof; at dispatch the worker resolves that opaque handle, verifies
  its argument hash and direct parent-run lineage, then sends the frozen action
  through the ordinary live authorization gates. Frozen arguments never enter
  a prompt, checkpoint, audit/event payload, ToolCall metadata, or client API.
  A changed draft, revoked mailbox access, inactive approver, wrong lineage, or
  already-claimed proof therefore denies the action rather than inviting a
  model to compose a near-match.
- **Discovery has no credential capability.** The authenticated discovery route
  accepts only an address plus explicit scope, fans out reviewed registry, MX,
  secure mail/JMAP/Exchange-Online SRV, and HTTPS autoconfiguration evidence,
  and returns separate configuration confidence and credential-destination
  trust. HTTPS uses `safeFetch` with IP pinning, same-origin redirects, a 64 KiB
  cap, and one three-second budget; declarations/entities are refused by the
  narrow autoconfig parser. MX and uncorroborated external SRV records may
  classify but never produce `trustedImapSmtp`. The UI may show the password
  screen only when that server-authored property exists; manual settings remain
  an explicit user override and the dial path still re-vets every endpoint.
- **Seams.** Protocol clients live in `@nessie/agent-mail` (`dial`, `wire`,
  `smtp`, `imap`, `mailbox-client`) beside the SES transport, because MIME
  building and address handling are transport-neutral and `buildOutboundMime`
  serves both models. They are hand-written rather than a mail library: the dial
  must open to a just-vetted literal address with SNI pinned to the configured
  hostname, and a client that owns its own socket cannot be given that.
  Lifecycle and the credential chokepoint are in `@nessie/team-admin`
  (`mailbox-connection*.ts` and `comms-connection-management.ts`); provider
  routes and agent tools call those same ownership predicates and mutations.
  The routes are `/api/mailbox-connections*`; the
  only tuning is `NESSIE_MAILBOX_TIMEOUT_MS` (20s).
