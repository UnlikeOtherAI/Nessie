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
- **A page of web results is deliberately not one of these.** The search card
  (`present: true` on `web_search`) is presentational: nothing is pressed,
  nothing resolves, and every viewer sees the same thing, so it rides in the
  message's own metadata rather than borrowing the press machinery — which
  would have meant relaxing "a card with inputs needs an action" for a card
  nobody acts on. The reasoning is in
[`web-search.md`](web-search.md) → "The search card"; it is the boundary of
this standard, not an exception to it.
- **A doorway into another conversation is not one of these either, and it is
  live.** The conversation card — `metadata.conversationRef`
  (`packages/schemas/src/conversation-ref.ts`, `{schemaVersion, threadId,
  channelId, agentId}`, written **only** by the server, by
  `agent_conversation_start` and `conversation_reference`, never from model
  text) — is presentational for the same reason the search card is: nothing is
  pressed and nothing resolves, so pressing it navigates. It differs from the
  search card in the other direction: it holds **no** state at all. It renders
  whatever `GET /api/threads/:threadId/conversation` says right now, per viewer
  — running, queued, done, failed, or "a conversation you can't see" — because a
  status stored in the metadata would be a snapshot that lies within a minute,
  and because two readers of the same pointer are owed two different answers.
  That is what keeps "a card kind per thing" unnecessary: a pointer plus a
  viewer-scoped read is the shape, not a new `AgentCard` kind. See
  [`reply-threads.md`](reply-threads.md) → "Container threads as conversations".
  `AgentHandoffDoorway` stays separate for now — it points at a DM rather than a
  thread — and folding the two is named in the plan's "Later".
- **The research card is the third presentational pointer, and it is live
  too.** `Message.metadata.researchRunRef = {schemaVersion: 1, runId}`
  (`ResearchRunRefMessageMetadataSchema` in
  `packages/schemas/src/deep-water-message-metadata.ts`, `.strict()`) is written
  **only** by the server, never from a client or model text, and points at one
  DeepWater product run. Like the conversation pointer it holds no state: the
  admin's `ResearchRunCard` renders `GET
  /api/integrations/products/deep-water/research-runs/:runId` for the viewer
  right now — the requester's brief being agreed, the launched research for
  everyone else in the room, or "a research you can't see" on a 404 — and
  refetches on the content-free `integration.run.updated` event the shell
  handles once, so its status, report and actions are never a snapshot. Its
  actions navigate (into the brief, or to the report in Documents), download or
  copy (`ResearchArtifactActions`); none is a press, so none claims one. It is
  not a card kind either. The message's text is the plain topic, its twin for
  search and models, and is not rendered beside the card. An edit is refused
  (`updateMessage` → `409 MESSAGE_IMMUTABLE_RESEARCH_CARD`, through the one
  `isResearchRunRefMessage` predicate the admin shares, so the row offers no
  pencil): a card whose words no longer match the research it shows would lie
  about it. Deleting it stays allowed; the research itself is untouched. The
  DeepWater rules are in [`deepwater.md`](deepwater.md) → "Research briefs —
  the admin".
- **An action may be a same-app doorway.** An action with `href` is an internal
  router path. It claims the card before navigation, so a draft cannot remain
  open for a stale second choice. A normal `submits: true` action validates the
  complete form. An `href` may instead set `collectsValues: true` with
  `submits: false`: it stores the present non-secret values without requiring a
  partial form to be complete, and leaves the destination's normal validation
  and action authority unchanged. The destination owns its normal authorization
  check and receives ordinary form values only through in-memory
  router state. An opaque card id in the route lets the destination re-fetch
  the resolved, viewer-scoped values after a reload; no copy enters a URL or
  card metadata. This keeps a mail draft's `Send` response beside `Edit`, which
  opens the canonical Mail composer with the same copy instead of an
  email-shaped second editor.
- **A closed block vocabulary, never a kind per integration.** `AgentCardSpec`
  = `blocks` (`text`, `fields`, `image`, `link`, `input`, `secret`) + up to four
  `actions`. A ticket, an email overview and a form are arrangements of the
  same parts under `AgentCardMessage`/`AgentCardBlocks`. A `kind:
  'linear_ticket'` is a renderer in waiting and the eighth look-alike Rule zero
  names. An `image` is an attachment id the run can already reach, never a URL.
  Text inputs default to 500 characters; a text or textarea card block alone
  may declare a smaller or larger `maxLength`, bounded at 100,000, so mail copy
  does not silently widen every card field.
- **A card is one message, prose included.** `AgentCardSpec.message` is the
  agent's own covering note — the sentence it would otherwise have typed beside
  the card. It renders above the card's header inside the same bubble, with the
  actions still in the footer, so the words, the detail and the decision arrive
  once and are answered in one place. It leads `renderAgentCardPlainText`, so
  search, push previews and the model's transcript window keep it. The field is
  optional in both directions: a card stored before it existed parses and
  renders exactly as it did. The other half of the rule is in the run: a
  completed run whose final text is empty writes no message at all
  (`delivery.kind: 'silent'`), and a tool that already delivered its turn to
  the conversation (`ToolExecutionResult.deliveredToConversation`, today only
  `card_post`) excuses that silence from the empty-output recovery — which
  would otherwise ask the model for exactly the duplicate paragraph the card
  replaced. Emptiness is the only test: a bare "👍" is a real message, and is
  withheld only by the reaction path, which knows the run reacted.
- **One chat-card treatment does not merge authority.** The universal
  `AgentCardMessage` renderer and the read-only historical Gmail-draft preview
  share `ChatCardShell`'s compact visual surface. The preview remains its own
  owner-gated compatibility read: it does not gain an `AgentCard` row, card
  lifecycle, press handling, or access to card form values merely by sharing
  that presentation primitive.
- **The press is a message.** It writes a real `user` turn stamped
  `metadata.agentCardResponse`, so the outcome is in the chat, is an ordinary
  human turn in the transcript, and wakes the card's agent through one
  *structural* orchestrator path (a server-written metadata key — never content
  matching). The press's realtime announcement is scoped by the destination,
  not by the organisation the presser happens to belong to: it goes out through
  `buildChannelRealtimeScopes`, which returns the channel scope alone for a
  delegated system DM (the Personal Assistant's, or a global agent's home) and
  adds the organisation scope everywhere else — so a card answered inside a
  delegated system DM announces to that channel alone, never to every member
  connected to the organisation feed. The response atomically inherits every
  disclosure-basis scope on the source card message: an entered value can be
  more sensitive than the card copy, never less, and its realtime notice is
  content-free when that basis is non-empty. A resolved card also renders a
  state note beside its message
  content in every later window (`message-cards.ts`, joined by
  `withMessageNotes` exactly where the attachment inventory line goes), so
  nothing ever rewrites a message. Nor may a person: `updateMessage` refuses a
  message carrying `agentCardResponse` (`409
  MESSAGE_IMMUTABLE_CARD_RESPONSE`) and the admin hides the pencil, both
  through the one `isAgentCardResponseMessage` predicate — a "Deny" edited into
  an "Allow" would lie beside the card that is the authority. Deleting stays
  allowed; a tombstone changes nothing on the card.
- **A committed press is a success.** The claim, any secret placement, the
  response message and the resume commit in one transaction; everything after
  it only announces the press — the audit events, a scrubbed message's
  `message.updated`, `card.updated` and the response's `message.reply`
  (`agent-card-response-announce.ts`) — and each step is logged, never thrown,
  and never skips the next (the audit writer already swallows its own
  failure). A realtime NOTIFY failure after commit used to answer 500 for a
  card the server had resolved, while the admin refreshed the card only on
  success, so Accept stayed pressable beside "Something went wrong". The route
  answers 200 whenever the transaction committed, and `useRespondToAgentCard`
  refreshes the card and its thread when the press settles, success or not, so
  a pressed card never looks un-pressed.
- **An executor review card holds an id, and every press mints a token.** A
  prepared executor change — an access change (`executor_agent_grant_prepare`
  and the other access-change prepare tools) or a workspace promotion
  (`executor_workspace_promotion_prepare`), both in
  `worker/src/run/pa-tools/executors.ts` — used to come back as a review link
  with `#confirmationToken=` in the fragment. The token is a secret no model
  may see, the secret scanner redacted it from the tool output, and the link
  the Designer posted opened a review that could not confirm. The tool now
  posts a system-authored card — server-written copy, one `review` action
  (`EXECUTOR_REVIEW_CARD_ACTION_KEY`), `respondentUserIds` the preparer alone,
  expiring with the change — through the same `postAgentCard` door `card_post`
  uses (`worker/src/run/pa-tools/agent-card-post.ts`), and the row stores only
  `AgentCard.executorAccessChangeId` or `executorWorkspacePromotionId`. The
  model is told only that a card was posted; no `executor_*` prepare tool puts
  a token in its output.
  - **A press is not an answer.** It resolves nothing, writes no response
    message and wakes nobody (`api/src/services/agent-card-executor-review.ts`):
    it mints a fresh token for the continuation's own actor while the change is
    pending and unexpired (`@nessie/executor-manage` `executor-review-cards.ts`),
    replacing the stored hash, so only the newest token works and the
    prepare-time one — never shown to anyone — is dead. The token travels in
    that press's response alone (`AgentCardRespondResult`, `status: 'open'`),
    and the renderer opens the existing `ExecutorAccessChangeDialog` or
    `ExecutorPromotionDialog` in place with it held in component state: never
    the row, the message, realtime, an address or a model's context. Resolving
    the card on the press made it one-shot — a review closed without
    confirming, a reload, a lost response or another device left a resolved
    card beside a pending change no screen could confirm. Now the same person
    just presses again.
  - **The card closes when the change does.** Confirming or rejecting the
    change through any door closes its open cards in that same transaction
    (`closeExecutorReviewCards`: resolved by the actor with the `review` key,
    or cancelled), the card sweep expires it with the change, and a press that
    finds the change already over closes the card to match and answers
    `409 EXECUTOR_ACCESS_CHANGE_STALE`, so a stale card never keeps a live
    button. `closeExecutorReviewCards` returns the cards it closed; once that
    commits, the confirm and reject routes of both kinds of change, and the
    press, publish `card.updated` with each card's new status to its room
    (`announceClosedExecutorReviewCards`, logged and never thrown). Nothing
    published it before, so the preparer's other devices kept a live Review
    button, and the rest of the room an open card, until they reloaded. The
    sweep's expiry still publishes nothing, for any card. A press finds a
    change over when the card and its change, which expire at the same
    instant, lapse between the press's two reads of the clock, or when a
    confirm elsewhere commits while the press waits on the change's row. A
    press by anyone else while the change is pending refuses with the
    same code and leaves the card and the token alone. Closing the dialog
    re-reads the card. Confirming itself is untouched — same actor, the token,
    fresh verification where the change needs it. Pinned by
    `api/test/agent-card-executor-review.test.ts`,
    `api/test/executor-workspace-promotion-confirm.test.ts` (a promotion
    confirmed through its route, with fresh verification),
    `worker/test/db/executor-review-card.test.ts` and the executor-agents
    fixture suite, which closes the review and presses again.
  - **A standing policy's card is the one composite review.**
    `executor_standing_policy_prepare`
    (`worker/src/run/pa-tools/provisioning-standing-policy.ts`) posts a
    server-written card (`buildStandingPolicyCard`,
    `packages/team-admin/src/standing-policy-card.ts`) through the same door,
    holding only the `executorAccessChangeId` of a `standing_policy` change.
    In plain words: the machines, the host profile and each machine that
    cannot merge (*"This machine cannot merge; tickets will stop at an open
    pull request."*), the board and its start-work columns, who can start
    work (*"Anyone who can edit this board — N people today, and anyone
    added to the project later — can make Claude run commands on these
    machines as you, with your git and coding-agent login."*), the agent and
    its model and that editing it pauses the access, which machines let
    Claude Code run any command unasked, the quiet wake, a mirrored board's
    own events, the tickets waiting to start, who sees it, the limits, that
    merges happen under the author's GitHub identity, what changed since the
    policy it replaces, and the instructions word for word in a closed fold — every punctuation mark
    escaped, so no link, HTML, comment or heading in them can render out of
    sight, and not fenced, because a code block does not wrap and a phone
    would show a sliver of them; refused as too long rather than cut. Its
    one action is the `review` above, so the
    press, the token and the close follow the same rules, and the review
    dialog names the change (`executorChangePresentation`). It is posted
    only on the trigger author's own interactive turn in their own Designer
    or Personal Assistant DM, never in a project room. Pinned by
    `worker/test/db/standing-policy-prepare-tool.test.ts`,
    `packages/team-admin/test/standing-policy-db.test.ts` and
    `packages/team-admin/test/standing-policy-card.test.ts`.
- **Every card goes through one door.** `postAgentCard`
  (`worker/src/run/pa-tools/agent-card-post.ts`) is the only place the worker
  writes an `AgentCard` row: `card_post`, the executor review card and
  `browser_login_request`'s sign-in card all post through it, so none can
  exist without its message and its pointer, and each gets the same reply
  bookkeeping, realtime notice and respondents' bell. The sign-in tool used to
  carry its own copy of all five, which is where two copies drift. Those three
  follow the commit and are best-effort, as a press's announcements are: the
  card is durable and answerable by then, so a step that fails is logged and
  the post still answers with the card. Throwing there failed the tool call
  beside a live card, which the model could only take for a post to try
  again. The sign-in card's personal browser grant is written inside the
  card's own transaction by the door's `browserLogin` step, so neither exists
  without the other, and the grant's deadline — which the deployment's
  browser TTL may shorten — is the card's. `card_post` never passes that step,
  so no model-written card can grant browser access. Pinned by
  `worker/test/browser-login-request.test.ts` (no second writer) and
  `worker/test/db/browser-login-card.test.ts` (the card, its grant, the
  requester's bell, the tool result that parks the run on the card, a failed
  grant taking the card with it, and a failed notice or reply bookkeeping
  after the commit leaving the card and its answer standing).
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
  scope stays owner-only and must resolve inside the organisation. A
  `browserbase_connection` uses the same Browserbase probe-and-persist seam as
  Settings: its masked API key is never copied to
  the ordinary vault, chat, audit, card row, presenter, or model. `user`
  scope always binds to the person who pressed the card; `team` and
  `organization` scope mirror the Settings route's owner and tenant checks.
  The connection only supplies Browserbase credentials. It is never an
  implicit per-agent browser grant; the existing explicit grant remains a
  separate owner-side decision for each named agent.
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
