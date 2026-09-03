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
  block's value goes through the same `storeInstanceSecret` seam and the same
  authorization as the instance-secret route, inside the press transaction, and
  is absent from the row, the message, the audit metadata, the realtime payload,
  the presenter and the model: only that it was provided, and where. Details:
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
- **A secret field's value reaches the credential store and nothing else.** It
  goes through the same `storeInstanceSecret` seam and the same authorization
  as `POST /api/mcp/instances/:id/secret`, inside the press transaction, and is
  absent from the row, the message, the audit metadata (key names only), the
  realtime payload, the presenter and the model. Only
  `secretOutcomes[key] = {kind, instanceId, placement}` is kept.
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
