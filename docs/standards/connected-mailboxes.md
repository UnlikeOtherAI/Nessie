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
  named on the request. Standing send grants are deliberately absent: a grant is
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
  connection to `needs_reauthorization`.
- **Seams.** Protocol clients live in `@nessie/agent-mail` (`dial`, `wire`,
  `smtp`, `imap`, `mailbox-client`) beside the SES transport, because MIME
  building and address handling are transport-neutral and `buildOutboundMime`
  serves both models. They are hand-written rather than a mail library: the dial
  must open to a just-vetted literal address with SNI pinned to the configured
  hostname, and a client that owns its own socket cannot be given that.
  Lifecycle and the credential chokepoint are in `@nessie/team-admin`
  (`mailbox-connection*.ts`); the routes are `/api/mailbox-connections*`; the
  only tuning is `NESSIE_MAILBOX_TIMEOUT_MS` (20s).

