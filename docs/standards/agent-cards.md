# Agent chat cards

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- **An interactive card is one system, and its press is claimed once.** Every
  agent that can talk can post a card (`card_post`, default-on) whose buttons a
  person presses; `AgentCard` is the authority and the message carries only its
  id, because a press must be claimed by a conditional UPDATE carrying the
  decision (`status = 'open'`) rather than a JSON mutation, and whether a given
  viewer may press is a per-viewer server decision. The body is a **closed block
  vocabulary** (`text`, `fields`, `image`, `link`, `input`, `secret`) plus up to
  four actions, so a ticket, an email overview and a form share one renderer — a
  `kind` per integration is the eighth look-alike Rule zero names, and the seven
  existing metadata cards are exactly why. The press writes a real `user`
  message stamped `agentCardResponse`, which is what puts the outcome in the
  chat, in the agent's transcript, and on one *structural* orchestrator path
  that wakes the card's agent (a server-written key, never content matching); a
  resolved card additionally renders its live state beside its message content
  in every later window, so nothing rewrites a message. Waiting on a card
  (`wait: true`) reuses the approval suspend/resume machinery through one shared
  core each — never a second copy of the claim-once discipline — and parks the
  run in `waiting_input`, non-terminal and holding the thread slot. A `secret`
  block's value reaches its typed credential destination inside the press
  transaction — `storeInstanceSecret` for a connector or
  `setSourceCredential` for a dashboard source — and is absent from the row,
  the message, the audit metadata, the realtime payload, the presenter and the
  model: only that it was provided, and where. A third destination,
  `vault_secret`, is the general one — the person's own Secrets, for a
  credential belonging to them rather than to a connector. It is the only
  destination whose write is an external HTTP call and so cannot join the
  press transaction: the vault write happens at resolution and is rolled back
  if the press does not commit, through the one `secret-vault-write.ts` seam
  `POST /api/secrets` also uses, so the two doors cannot authorise a scope
  differently. The agent supplies the NAME the form arrives pre-filled with,
  and may name one message in the card's own thread to scrub
  (`redactMessageId`) — the half that takes a credential back out of a context
  it already reached. The replacement text is server-computed from the value
  the person typed; the block is `.strict()`, so an agent can neither choose
  the new wording nor edit a message by this route. Details:
  `CLAUDE.md` → "Agent chat cards"; spec:
  `docs/plans/2026-09-01-agent-chat-cards.md`.

## Detail

Moved verbatim out of [`CLAUDE.md`](../../CLAUDE.md) → "Agent chat cards — one card system, not an eighth look-alike".


Every agent that can talk can post an **interactive card** into a conversation
with `card_post`: a ticket or email overview, an image with a caption, a small
form. Buttons along the bottom; a person presses one; the card freezes into a
terminal state retained in the chat **and** in the agent's context. Default-on
for every agent (`safe: false`, no `personalAssistantOnly`, no
`requiresExplicitGrant`) — a card is a better-shaped message, not a wider
permission, and what a card *does* is still gated at the tool called
afterwards. Spec:
[docs/plans/2026-09-01-agent-chat-cards.md](../plans/2026-09-01-agent-chat-cards.md).

- **One authority, one pointer.** `AgentCard` is the row; the assistant message
  carries only `metadata.agentCard = {cardId, schemaVersion}` — the
  `appSetupCard`/`todoRef` discipline, because a press must be claimed by a
  conditional UPDATE (`status = 'open'` in the WHERE), not a JSON mutation, and
  "may this viewer press" is a per-viewer server decision. Every transition —
  press, expiry sweep, run-cancel — is that same claim, so two presses or a
  press racing the sweep have exactly one winner.
- **A closed block vocabulary, never a kind per integration.** `AgentCardSpec`
  = `blocks` (`text`, `fields`, `image`, `link`, `input`, `secret`) + up to four
  `actions`. A ticket, an email overview and a form are arrangements of the
  same parts under `AgentCardMessage`/`AgentCardBlocks`. A `kind:
  'linear_ticket'` is a renderer in waiting and the eighth look-alike Rule zero
  names. An `image` is an attachment id the run can already reach, never a URL.
- **The press is a message.** It writes a real `user` turn stamped
  `metadata.agentCardResponse`, so the outcome is in the chat, is an ordinary
  human turn in the transcript, and wakes the card's agent through one
  *structural* orchestrator path (a server-written metadata key — never content
  matching). A resolved card also renders a state note beside its message
  content in every later window (`message-cards.ts`, joined by
  `withMessageNotes` exactly where the attachment inventory line goes), so
  nothing ever rewrites a message. Nor may a person: `updateMessage` refuses a
  message carrying `agentCardResponse` (`409
  MESSAGE_IMMUTABLE_CARD_RESPONSE`) and the admin hides the pencil, both
  through the one `isAgentCardResponseMessage` predicate — a "Deny" edited into
  an "Allow" would lie beside the card that is the authority. Deleting stays
  allowed; a tombstone changes nothing on the card.
- **Waiting is the approval machinery, reused.** `wait: true` exits the loop
  through `pendingInput` (decided *after* dispatch — the card must exist first),
  checkpoints, and parks the run in `waiting_input`: non-terminal, holding the
  `(agent, thread)` slot exactly like `waiting_approval`. A distinct status
  because that label is user-visible in four admin surfaces and "waiting for
  approval" is the wrong words for a form. Suspend and resume are **one shared
  core each** (`run-suspend.ts`, `run-resume-core.ts`), with the approval paths
  migrated onto them — never a second copy of the claim-once discipline.
- **A secret field's value reaches its credential store and nothing else.** A
  `connector_credential` goes through `storeInstanceSecret` and the exact
  authorization of `POST /api/mcp/instances/:id/secret`; a
  `dashboard_source_credential` goes through `setSourceCredential` and the
  exact authorization of its dashboard-source route; a `vault_secret` goes
  through `putSecretInVault` and `canManageSecretScope` — the same seam
  `POST /api/secrets` uses, so `personal` is the presser's own and every wider
  scope stays owner-only and must resolve inside the organisation.
- **A plain `input` block is not a credential field.** Its value is written to
  `resolutionValues`, to the response message, to realtime and into the agent's
  next context, so a credential typed into one is refused at the press with
  `SECRET_INTERCEPTED` — the same interception the composer and message routes
  use. An agent that needs a credential uses a `secret` block or gets nothing.
- **A scrubbed message says so, and memory forgets with it.** The rewrite sets
  `editedAt` and publishes `message.updated`, because viewers holding the thread
  open would otherwise keep rendering the plaintext, and a silent edit of
  somebody else's words is worse than the leak it fixes. It also deletes the
  `thoughts` rows captured from that message (`forgetMessageThoughts`) — a
  person's message is copied into memory at send time, so rewriting
  `messages.content` alone leaves recall serving the credential straight back.
  Deletion rather than rewriting, because the row carries an embedding of the
  plaintext and there is no way to un-embed a value. Both the save and the
  scrub emit audit events (`secret.created`, `message.redacted`), never a
  value. The rewrite is floored at twelve characters: it replaces every
  occurrence of the submitted string, so a shorter one would be a defacement
  tool rather than a redaction. Both run inside the press
  transaction and are absent from the row, message, audit metadata (key names
  only), realtime payload, presenter and model. `secretOutcomes[key]` keeps
  only the destination kind and its safe id/placement — never a value, ref,
  ciphertext, length or prefix.
- **The service mark is server-resolved.** The agent names a slug; the
  presenter matches it against the app catalogue under the viewer's own store
  floor and returns the cached `/api/apps/:id/icon` path, else null and
  initials. The model never supplies an icon URL. Rendered by `AppIcon`
  `size="badge"` — not a second icon component.
- **Who may press is the agent's call per card**: `requester` (the default when
  a person asked for the run), `thread`, or named `userIds` — refused at post
  time if they cannot see the channel. Named respondents get the ordinary
  mention bell and push through the shared alert core, which now takes an
  explicit recipient list rather than parsing an `@` out of prose.
- Expiry is agent-set, none by default, swept beside `sweepExpiredApprovals`;
  no message is posted for one.
