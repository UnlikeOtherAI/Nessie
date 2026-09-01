# Agent chat cards — one interactive card system for every agent

**Status:** design proposal — research + design only, no code.
**Date:** 2026-09-01
**Related:**
[2026-08-31-approvals-suspend-resume-and-auto-review.md](2026-08-31-approvals-suspend-resume-and-auto-review.md)
(the run suspend/resume machinery a *waiting* card reuses — Stage 1 landed in
`cd0fbe9`, its status header is stale),
[2026-08-31-conversational-agent-setup/core-decisions.md](2026-08-31-conversational-agent-setup/core-decisions.md)
(the opaque-id + viewer-scoped presenter card pattern this design adopts),
[2026-08-29-approvals-in-chat.md](2026-08-29-approvals-in-chat.md)
(superseded; its "a model-invoked gate fails open" lesson still applies),
[2026-08-11-disclosure-boundaries-build.md](2026-08-11-disclosure-boundaries-build.md)
(why the card message goes through the one write chokepoint),
[2026-08-07-images-in-agent-context.md](2026-08-07-images-in-agent-context.md)
(the "beside content" note that carries card state into the model's context).

## The idea in one paragraph

Every agent that can talk can post a **card** into the conversation: a
persistent, structured message — a Linear ticket, an email overview, an image
with a caption, a small form — with a row of buttons at the bottom (Allow / OK
/ Cancel / whatever the agent names) and a small service mark in the top-left
corner. A person presses a button, optionally after filling in fields; the
press is recorded **once**, the card freezes into its resolved state for
everyone scrolling back, and the outcome — who pressed what, when, with which
values — is retained both in the chat and in the agent's context. A form can
carry a **secret field** whose value goes straight into the encrypted
credential store and is never written anywhere else. The agent decides per
card who may press, whether to wait for the answer inside the same run or be
woken by it later, and whether the card expires. It is **one schema, one
table, one renderer, one tool** — the eighth bespoke card component is the
defect Rule zero names, and this design exists to stop the count at seven.

## 1. What exists today — verified against `main`, 2026-09-01

### Landed

- **Seven metadata-driven chat cards, each bespoke**, all mounted in one
  place — `admin/src/components/features/channels/ChannelMessageRow.tsx:394-428`
  — and each self-suppressing when its key is absent: `uiCards`
  (`MessageUiCards.tsx`, verbatim product output), `dashboardEmbeds`,
  `card.comms_connect` (`CommsConnectCard.tsx`), `appSetupCard`
  (`AppSetupCard.tsx`), `runStop` (`RunStopContinue.tsx`), `todoRef`
  (`TodoProgressCard.tsx`), `workflowRun` (`WorkflowRunCard.tsx`). Two
  authority patterns coexist: data embedded in metadata (`comms_connect`,
  `runStop`, `uiCards`) versus **an opaque id in metadata + a viewer-scoped
  presenter** (`appSetupCard`, `todoRef`). The house decision for anything
  with a lifecycle is the second — `AgentAppConnectionRequest`'s schema
  comment: *"the corresponding assistant message stores only this row's
  opaque id; it never becomes mutable connection authority."*
- **The only generic action model** is `IntegrationUiCardActionSchema`
  (`packages/schemas/src/integrations.ts:319-325`): `href` links plus one
  hardcoded client intent. There is **no** "call this API on press" action,
  and no card has a persisted resolved state except `approvalGate`.
- **Run suspend/resume for a human decision exists and works.**
  `worker/src/run/execute/tool-authorization.ts:184` returns a `suspend` arm;
  `tool-batch.ts` short-circuits the batch; `run-outcome.ts:49-70` handles it
  before every terminal branch; `approval-suspend.ts` writes a checkpoint
  (`reason: 'approval_required'`), posts a notice through `createAgentMessage`
  with `metadata.approvalGate`, flips run → `waiting_approval` (non-terminal,
  holds the thread slot: `packages/db/src/thread-serialization.ts:56`), task →
  `awaiting_approval`, agent → `waiting_approval`. Resume is API-side:
  `api/src/services/approval-resume.ts:74` flips `waiting_approval →
  completed`, creates a continuation run (`continuationOfRunId`), claims the
  checkpoint set-once, enqueues `run:approval:<id>`, and `run-setup.ts:303`
  injects an `approvalInstruction` system line. `ApprovalRequest.resumeState`
  carries the enqueue-time `actorContext`. Reject/expire terminalise the run
  and **leave the checkpoint unconsumed** so a plain reply resumes.
  `approvalGate` has **no chat renderer** — resolution happens only on
  `/approvals`.
- **The write chokepoint** `worker/src/run/execute/agent-message.ts`
  `createAgentMessage(tx, context, draft)` accepts arbitrary `metadata`,
  stamps `MessageBasisScope` + `RunBasisScope` in one transaction, injects
  `onBehalfOfUserId`. Worker-posted messages create mention alerts by calling
  `createMessageMentionAlerts` (`worker/src/run/mention-alerts.ts:25`) —
  `completion.ts:213`, `pa-tools/message-delivery.ts:141`.
- **The model never sees `Message.metadata`.** `loadConversation`
  (`worker/src/run/execute/prompt.ts:240`) selects `id, content, role,
  agentId, agent.name, basisScopes`. The one precedent for out-of-band
  per-message state entering a turn is the attachment inventory:
  `attachmentNote` computed in `loadConversation`, joined by
  `withAttachmentNote` (`prompt.ts:30-37`) as `content\n[attached: …]`.
- **Structural prompt blocks** already exist for exactly the "say it once
  when the tool is present" shape: `buildAgentTodoFactsBlock`,
  `buildAgentDocumentsBlock`, `buildResearchRoutingBlock` (`prompt.ts:174-176`),
  each derived from toolset facts, never from message content.
- **Secrets.** Two stores, different jobs. (a) The encrypted `secret_*` store
  (`packages/mcp-manage/src/mcp-oauth-secret-store.ts`, AES-256-GCM under
  `NESSIE_AUTH_SECRET`, table `mcp_oauth_secret`, no tenancy on the row —
  tenancy comes from the row that points at the ref; prefixes `secret_oauth_`,
  `secret_mcp_`, `secret_push_`, `secret_dashboard_`). `storeInstanceSecret`
  (`packages/mcp-manage/src/instance-secret.ts:35`) is *the* plaintext → ref
  seam: mints a ref, places it on the instance or a per-user override,
  returns only `{ placement }`. Connectors resolve it at dispatch. The PA's
  `connector_set_secret` records `inputSummary = instanceId only`. (b) The
  org **vault** (`Secret` + `SecretGrant`, `api/src/routes/secrets.ts`,
  Infisical-backed) is the human-facing catalogue; **nothing in the worker or
  packages reads a vault value at use time** — it is write/rotate/revoke only
  from Nessie's side. `SecretCaptureDialog.tsx` is the composer's existing
  masked capture into the vault. Audit `redactMetadata` already masks
  `secret`/`token`/`apiKey`/`credential` keys.
- **Service icons.** `McpCatalogEntry.iconAttachmentId` bytes are served at
  `GET /api/apps/:id/icon` behind `storeCatalogWhere`, MIME-sniffed raster
  only, fetched by `AppIcon.tsx` as an authed blob with initials fallback. No
  provider marks exist anywhere else in the admin.
- **Follow-up runs.** A new human message enqueues `orchestrate.decide`;
  `worker/src/run/orchestrate.ts` applies structural fast paths (PA DM,
  @mentions) before the model-judged engagement decision; each `reply`
  decision runs `claimThreadRunOrPend` and enqueues `run.execute` with
  `interactive = actorType === 'user'`, `messageId` as the trigger.
  `Run.triggerMessageId` is written at run-create time.
- **Expiry sweep.** `api/src/services/api-maintenance.ts:9` runs
  `sweepExpiredApprovals` on a timer.

### Not landed — do not design against these

- No in-chat approval card (`RunApprovalGate.tsx` was planned, not built).
- No `card.*` realtime event; no admin handler for `approval.needed` /
  `approval.resolved`.
- No agent-facing tool reads a vault (`Secret`) value. A card secret that
  lands in the vault is catalogued for people, not usable by the agent.
- Streaming/optimistic rows render no cards; a card appears only once its
  durable message arrives (acceptable: the tool call *is* the durable write).

## 2. The model

### 2.1 One card = one row + one message pointer

A card is a **row in `agent_cards`** (the authority: spec, who may press,
status, resolution, secret outcomes) plus **one assistant `Message`** whose
metadata carries only `{ agentCard: { cardId, schemaVersion: 1 } }`. The
message is what places the card in a thread, a reply thread, the unread
counters, search, notifications and the model's transcript window; the row
is what changes. This is the `appSetupCard` pattern, chosen over embedding
the spec in metadata for three reasons: a press must be claimed exactly once
by a conditional UPDATE on a row, not a JSON mutation; "may *this* viewer
press" is a server decision the presenter makes per viewer; and a withheld
message carries no metadata, so the pointer is simply absent for a viewer the
disclosure predicate refuses.

### 2.2 Schema

```prisma
enum AgentCardStatus { open resolved expired cancelled }

model AgentCard {
  id               String          @id @default(uuid()) @db.Uuid
  organizationId   String          @map("organization_id") @db.Uuid
  channelId        String          @map("channel_id") @db.Uuid
  threadId         String          @map("thread_id") @db.Uuid
  messageId        String          @unique @map("message_id") @db.Uuid
  agentId          String          @map("agent_id") @db.Uuid
  runId            String          @map("run_id") @db.Uuid        // the run that posted it
  /// Set only when the posting run suspended on this card (`wait: true`).
  waitRunId        String?         @unique @map("wait_run_id") @db.Uuid
  /// Enqueue-time actor context for the continuation, exactly as
  /// `ApprovalRequest.resumeState`. Server-only; never presented.
  resumeState      Json?           @map("resume_state")
  spec             Json            // validated AgentCardSpec, immutable after insert
  /// Empty = anyone who can read the message. Resolved at post time.
  respondentUserIds String[]       @map("respondent_user_ids") @db.Uuid
  status           AgentCardStatus @default(open)
  expiresAt        DateTime?       @map("expires_at")
  resolvedAt       DateTime?       @map("resolved_at")
  resolvedByUserId String?         @map("resolved_by_user_id") @db.Uuid
  resolvedActionKey String?        @map("resolved_action_key")
  resolutionValues Json?           @map("resolution_values")     // input values only, never secrets
  responseMessageId String?        @unique @map("response_message_id") @db.Uuid
  /// `{ [fieldKey]: { destination, placement } }` — the fact that a secret
  /// was stored and where; never a ref, never a value.
  secretOutcomes   Json?           @map("secret_outcomes")
  resumedByRunId   String?         @unique @map("resumed_by_run_id") @db.Uuid
  createdAt        DateTime        @default(now()) @map("created_at")
  updatedAt        DateTime        @updatedAt @map("updated_at")

  @@index([organizationId, status, expiresAt])
  @@index([threadId, status])
  @@index([agentId, status])
  @@map("agent_cards")
}
```

`RunStatus` and the worker's agent-status union gain **`waiting_input`**.
`waiting_approval` is not reused: its label is rendered in four admin places
as "waiting for approval", which is wrong for a form, and a fake sentinel is
the thing `docs/architecture.md` forbids. Touchpoints, all mechanical:
`ACTIVE_THREAD_RUN_STATUSES` and the raw SQL at
`packages/db/src/thread-serialization.ts:56,379`; `ACTIVE_RUN_STATUSES` in
`api/src/services/run-continuation.ts`; `updateRunStatus` terminal set
(`lifecycle.ts:31`, unchanged because it enumerates terminals); the cancel
route's `status: { in: ['pending','waiting_approval'] }` (`api/src/services/runs.ts:171`);
`AgentStatusDot`, `AgentDetailDrawer`, `AgentDetailPage`,
`project-dashboard-data` labels.

### 2.3 The card spec — a closed block vocabulary, not a kind per integration

"Universal" is delivered by making the **body a list of blocks** from a
closed vocabulary and the **footer a list of actions**, so a ticket, an email
overview, an image and a form are four arrangements of the same parts and
share one renderer. There is deliberately no `kind: 'linear_ticket'` — a kind
enum is a per-integration renderer in waiting.

```ts
// packages/schemas/src/agent-card.ts
AgentCardSpec = {
  schemaVersion: 1,
  service?: { key: string /* slug, ≤64 */, label: string /* ≤40 */ },
  title: string /* ≤120 */,
  subtitle?: string /* ≤200 */,
  blocks: AgentCardBlock[] /* 1–12 */,
  actions: AgentCardAction[] /* 1–4 */,
}

AgentCardBlock =
  | { type: 'text';   markdown: string /* ≤2000, rendered by MessageMarkdown */ }
  | { type: 'fields'; items: { label: string; value: string }[] /* ≤12 */ }
  | { type: 'image';  attachmentId: uuid; alt: string; caption?: string }
  | { type: 'link';   href: string /* https: only */; label: string }
  | { type: 'input';  key: Key; label: string; input: 'text' | 'textarea' | 'number'
                      | 'select' | 'checkbox' | 'date'; required?: boolean;
                      placeholder?: string; options?: { value; label }[]; default?: primitive }
  | { type: 'secret'; key: Key; label: string; help?: string;
                      destination: AgentCardSecretDestination }

AgentCardAction = {
  key: Key /* ^[a-z][a-z0-9_]{0,31}$, unique per card */,
  label: string /* ≤24 */,
  style: 'primary' | 'secondary' | 'danger',
  /** true = the press validates and submits inputs (OK, Allow, Send);
      false = a dismissal that ignores inputs (Cancel, Not now). */
  submits: boolean,
}

AgentCardSecretDestination =
  | { kind: 'connector_credential'; instanceId: uuid; shared?: boolean }   // phase 3
  | { kind: 'vault'; name: string; scopeType; scopeId?: uuid }              // later
```

Invariants enforced by the zod schema (`.strict()` throughout) and at post
time: input and secret keys unique across the card; at least one action;
a `secret` block requires at least one `submits: true` action; an `image`
`attachmentId` must be an attachment the posting run can already reach
(uploaded by its attachment tools or attached to a message in the thread —
the same reach `pa-tools/attachments.ts` enforces), never a URL; `link.href`
is `https:` only and rendered with `rel="noopener noreferrer"` and its host
visible. Nothing in the spec is a URL the client fetches.

### 2.4 The service mark

`service.key` identifies the originating service in the top-left corner. The
icon is **resolved server-side by the presenter, never supplied by the
model**: the key is matched against `McpCatalogEntry.slug` under the viewer's
`storeCatalogWhere` floor and, on a hit, the presenter returns
`iconUrl: /api/apps/:id/icon` — the same MIME-sniffed, Nessie-cached bytes the
App Store serves. No hit → `iconUrl: null` and the client draws
`service.label`'s initials. The renderer is `AppIcon` with a new
`size: 'badge'` (24 px), not a new component. The mark is identification, not
authority: an agent naming `linear` on a card about nothing gets Linear's mark,
exactly as it could write "Linear" in prose — the prompt line (§5) tells it
to name the service the card is about.

### 2.5 Lifecycle, stated as invariants

- `open → resolved | expired | cancelled`. Every transition is **one
  conditional UPDATE whose WHERE carries the decision** (`status = 'open'`),
  so two presses, or a press racing the expiry sweep, have exactly one winner;
  the loser gets `409 CARD_NOT_OPEN` with the current state in the body.
- `spec` and `respondentUserIds` are immutable after insert. There is no
  edit; a changed ticket is a new card. The posting run may not withdraw a
  card in phase 1 (§10).
- A resolved card never reopens. Deleting the card message tombstones the
  message; the row keeps its resolution and the tombstone still renders the
  card's terminal line (the tombstone branch keeps metadata for this key).
- `resolutionValues` holds input values only. Secrets are represented solely
  by `secretOutcomes[key] = { destination: { kind, instanceId }, placement }`.

## 3. The tool — `card_post`

One builtin, declared in a new `packages/runtime/src/builtin-card-tools.ts`
and composed into `BUILTIN_TOOL_DEFINITIONS` like its siblings. `safe:
false`, **no `personalAssistantOnly`, no `requiresExplicitGrant`**, seeded
`enabled: true` by `seedBuiltinToolRegistry` — so every agent whose run has a
destination thread has it by default, and an agent's `toolPolicy['card_post']
= false` is the only opt-out. It is not offered to a run with no destination
(a delegate sub-agent posts nothing; the parent posts the card).

```ts
card_post({
  card: AgentCardSpec,
  respondents?: 'requester' | 'thread' | { userIds: uuid[] },  // §4.1
  wait?: boolean,          // default false                     // §4.4
  expiresIn?: number,      // seconds, 60 … 30 days; default none // §4.5
})
→ { cardId, messageId, status: 'open' }                      // wait:false
→ (run suspends; the model's next turn carries the answer)   // wait:true
```

The handler (`worker/src/run/pa-tools/cards.ts`):

1. Parses with the zod schema; refuses in words on any invariant above.
2. Resolves respondents (§4.1) to user ids; refuses an id that cannot read
   the thread.
3. Validates every `secret` destination now, not at press time: the instance
   exists in the run's organisation, is not integration-managed
   (`MCP_INSTANCE_MANAGED_BY_INTEGRATION`), and its catalogue entry permits
   the requested placement (`SHARED_CREDENTIAL_AUTH_FORBIDDEN` for `shared`).
4. In one transaction: `createAgentMessage` (the chokepoint — basis stamped,
   `onBehalfOfUserId` set, `rootMessageId = context.replyRootMessageId`) with
   `content` = a plain-text rendering of the card (title, subtitle, text and
   fields blocks, "asks for: <input labels>", "buttons: Allow, Cancel") and
   `metadata.agentCard`; then the `agent_cards` row. The plain content is what
   search, push previews, other clients and the model's transcript see.
5. Named respondents are written as `metadata.mentions` so
   `createMessageMentionAlerts` (called exactly as `message-delivery.ts:141`
   does) produces the bell alert and the mention-framed push — no new
   `UserAlertKind`. `'thread'` respondents produce no alert (a channel card
   is read like any channel message).
6. Publishes `message.new` / `message.reply` through the existing helpers.
7. With `wait: true`, returns a result flagged `suspend: { cardId }`; the
   loop treats it as §4.4 describes.

Model-facing output is deliberately small (`{ cardId, messageId, status }`):
the tool result is not where the answer arrives.

## 4. Responding — the press

`POST /api/agent-cards/:cardId/respond`
`{ actionKey, values?: Record<Key, primitive>, secrets?: Record<Key, string> }`

### 4.1 Who may press

Two gates, both server-side, both fail closed:

1. **Can the viewer read the card's message?** Thread membership via
   `findThreadForUser` plus the message disclosure predicate (the same one
   the message list uses). Failure is an indistinguishable `404`.
2. **Is the viewer a respondent?** `respondentUserIds` empty → yes; otherwise
   membership in the list. Failure is `403 CARD_NOT_RESPONDENT`, and the
   presenter already told the client so (`action: 'none'` +
   `waitingFor: [names]`), so the button was never enabled.

`respondents` defaults to **`'requester'`** when the run has an originating
human (`run.originatingUserId ?? principalUserId`) — an "Allow" pressed by a
bystander on someone else's behalf is the failure to avoid — and to
`'thread'` for unattended runs (a schedule has no requester; whoever reads the
channel answers). The agent widens or narrows explicitly per card.
Only people press in this design; an agent pressing another agent's card is
out of scope (§10).

### 4.2 The response is a message

A press creates a real `Message` — `role: user`, `userId` = the presser,
`rootMessageId = cardMessage.rootMessageId ?? cardMessage.id` — with
server-authored content (`Allow`, or `Send · environment: production ·
notes: …`, or `Provide key · API key: provided`) and
`metadata.agentCardResponse = { cardId, actionKey, schemaVersion: 1 }`. Three
things fall out of making the record a message rather than a side table:

- **It is in the chat** as the user asked: a compact row under the card
  (rendered by `AgentCardResponseRow`, muted, action label as a pill), in the
  reply thread of a channel card so the room is not spammed, and in the
  reply panel of a threaded one. Unread counters, thread follows and
  `message.reply.meta` all work unchanged.
- **It is in the agent's context** as a `user` turn in the transcript window,
  which is exactly the shape the model already understands. No metadata
  plumbing is needed for the answer itself.
- **It triggers the agent structurally.** A human message with
  `metadata.agentCardResponse` is the anti-loop guard's favourite kind
  (`triggerIsHuman`), and the orchestrator gets one structural fast path
  before the model-judged engagement decision: *card response → `[{ action:
  'reply', agentId: card.agentId, replyPlacement: 'thread' }]`*. Structural
  because it reads a server-written metadata key, never content.

The card row stays the authority: the message is the record. Editing a
message that carries `agentCardResponse` is refused by the message-edit
service (a "Deny" edited into "Allow" would lie beside a card that says
otherwise); deleting tombstones it and changes nothing on the card.

The route does the whole press in **one transaction**: conditional claim
`open → resolved` (with `resolvedBy/At/ActionKey`, validated
`resolutionValues`), secret storage (§4.3), then the response message through
the ordinary `message-create` service — the same path the composer uses, so
reply bookkeeping, the `orchestrate.decide` enqueue and realtime publication
happen once, the same way. A `submits: false` action skips input validation
and records no values. An `agent_card.responded` audit event carries
`{ actionKey, valueKeys, secretKeys }` — key names, never values.

### 4.3 Secrets — plaintext in once, a placement out, nothing recorded

A `secret` block renders as a masked input (`type="password"`,
`autoComplete="off"`), held only in component state and sent only in the
respond request body over TLS. On the server the value's entire life is:

1. `storeInstanceSecret(tx, secretStore, …)` inside the claim transaction —
   the same function `POST /api/mcp/instances/:id/secret` and
   `connector_set_secret` call, with **that route's authorisation mirrored
   exactly**: the presser must have manage rights on the instance or see it
   in `listInstancesVisibleToUser`. The store mints a `secret_mcp_*` ref and
   places it on the instance or the presser's user override; the transaction
   makes ref minting and the card claim atomic, so a failed store rolls the
   press back and the buttons re-enable with the API's refusal toasted
   verbatim (the `RunStopContinue` convention).
2. `secretOutcomes[key] = { destination: { kind: 'connector_credential',
   instanceId }, placement }` on the card row. The ref is not recorded there.
3. The response message content says `API key: provided`.

The value never reaches: `resolutionValues`, the response message, the
`agent_card.responded` audit metadata (key names only; `redactMetadata` is a
second net), the `card.updated` realtime payload (ids and status only), the
presenter, the model's transcript, the tool result, or a log line (the route
is registered with body logging disabled, as the instance-secret route is).
Client state is cleared on completion and on unmount. The agent learns
`provided · stored on <instance>` — enough to call the connector, which
resolves the credential at dispatch as it does today.

Phase 3 ships `connector_credential` only, because it is what makes an app
usable (`app_connect_request`'s `needs_secret` state is precisely this gap)
and it is atomic with the claim (both are Prisma rows). The `vault`
destination goes through the existing `POST /api/secrets` path (Infisical,
an external HTTP call) and is a later phase with an explicit
`secretOutcomes[key].status: 'pending' → 'stored' | 'failed'` because it
cannot join the transaction; it is catalogued for people, and no agent can
read it today, which the tool's description must say plainly.

### 4.4 Waiting inside the run vs being woken by the press

Both are the agent's choice per card, and both are the *same* machinery seen
from two ends.

**`wait: false` (default)** — the run finishes as usual. The press creates the
response message; the structural orchestrator rule starts a fresh run for the
card's agent (`triggerMessageId` = the response message) or pends it if the
slot is busy. The fresh run auto-loads any unconsumed checkpoint in that
reply thread through the existing `loadRunCheckpointForRun`, so an agent that
wrote work-state before posting continues from it.

**`wait: true`** — after the card is posted the loop exits with
`pendingInput: { cardId }`, a third exit beside `pendingApproval` and
`cancelled`. `handleRunLoopOutcome` routes it to a **shared suspend core**
extracted from `approval-suspend.ts` and parameterised by reason: checkpoint
(`reason: 'card_response'`), `run.suspended` TaskEvent, run → `waiting_input`,
task → `awaiting_approval` (reused: the task-level meaning is "a person owes
an answer"), agent → `waiting_input`, `stream.done`, and the card row gets
`waitRunId` + `resumeState`. The card message itself is the notice, so no
second message is posted. Remaining tool calls in the same batch are filled
with "not executed: the run is waiting for a card response" exactly as the
approval suspension fills them, and the model re-issues them if still
relevant. `wait` is refused in words for delegate sub-agents and handoff
turns — the same structural set `maySuspendForApproval` already excludes.

On a press the respond route, still in the one transaction, calls a **shared
resume core** extracted from `approval-resume.ts` (and used by it afterwards —
"refactor, then reuse"): conditional flip `waiting_input → completed`,
continuation run (`continuationOfRunId`, inherited `replyPlacement`, same
trigger message), set-once checkpoint claim, task, `run.continued` TaskEvent
`{ auto: false, fromCardId }`, enqueue `run:card:<cardId>` with the stored
`resumeState` actor context; the card row records `resumedByRunId`. The
response message is created in the same transaction but its
`orchestrate.decide` is *not* enqueued — the continuation is the follow-up.
`run-setup.ts` finds the card by `resumedByRunId` and builds a
`cardResponseInstruction` system line beside `approvalInstruction`: *"The
person answered your card "Deploy hotfix?": pressed Allow. Values: …
Secret "API key": provided, stored on Linear. Continue from there."*

A waiting run holds the `(agent, thread)` slot, as an approval-suspended run
does today, so a human message in that thread pends behind it — the person
answers by pressing, not by typing past the card. Because a card has no
expiry by default, a waiting run cannot be allowed to hold that slot forever:
**`NESSIE_CARD_WAIT_BACKSTOP_MS`** (default 24 h) terminalises a still-waiting
run as `completed` with its checkpoint left unconsumed and the card still
`open` — from then on it is a `wait: false` card, and a later press wakes a
fresh run that auto-loads that checkpoint. The backstop is a deployment
envelope like the run backstops, not a user budget. `POST /api/runs/:id/cancel`
on a waiting run flips its card to `cancelled` beside
`expirePendingToolApprovalsForRun`.

### 4.5 Expiry

`expiresIn` sets `expiresAt`; the default is none. `sweepExpiredAgentCards`
runs beside `sweepExpiredApprovals` in `api-maintenance.ts`: conditional
`open → expired` for rows past `expiresAt`, then `card.updated`. A waiting run
whose card expires is **resumed once** with a `cardResponseInstruction` of
"nobody answered before it expired" — the agent chose both `wait` and an
expiry, so it expects to be told; a non-waiting card just freezes to
`Expired` and the agent reads that state the next time the message is in its
window (§5). The frozen card renders its buttons disabled with an `Expired`
pill; no message is posted for expiry.

## 5. What the agent sees — context retention

Three carriers, all existing shapes:

1. **The card message's own `content`** (plain rendering, §3 step 4) is in
   the transcript window like any assistant turn.
2. **A card state note beside that content.** `loadConversation` selects the
   `agentCard` relation for admitted turns and computes `cardNote`, carried
   on `StoredConversationMessage` and joined by the generalised
   `withMessageNotes` exactly where `attachmentNote` is joined today:
   `[card "Deploy hotfix?" · buttons: Allow, Cancel · open, waiting for
   Ondrej]`, `[… · resolved: Allow by Ondrej 09:14 · environment=production ·
   secret "API key": provided]`, `[… · expired]`. The note is computed at
   render time from the row, so a resolved card reads as resolved in every
   later run without rewriting the message.
3. **The response message** as a `user` turn (§4.2), and for a waiting run
   the `cardResponseInstruction` system line (§4.4).

Together these satisfy "retained in the context": as long as the card is in
the window the model knows its terminal state and who decided it, and the
decision itself is a human turn it would never mistake for its own words.

**The one-line prompt block.** A structural `buildAgentCardsBlock` is injected
beside the todo/documents blocks **only when `card_post` is in the run's
resolved builtin ids** — the same toolset-derived condition the documents
block uses — as one sentence: *"You can post an interactive card into this
conversation with `card_post` (a ticket or email overview, an image with a
caption, a small form) whose buttons the person presses, and the press and
any entered values come back to you and stay in the conversation — prefer it
over prose whenever you need a decision, a confirmation, a secret, or
structured input."* An agent whose `toolPolicy` disables the tool sees no
line, so the prompt never advertises a capability the toolset withholds.

## 6. Disclosure and tenancy

- The card message goes through `createAgentMessage`, so what the run read
  before posting stamps its basis; a card built from a private space is
  withheld from an unentitled viewer as a whole, metadata included, and the
  presenter's own predicate refuses the id with the same indistinguishable
  404 (`sessionId`-style: a global UUID with only a thread gate would leak
  across organisations).
- The presenter is viewer-scoped: `action: 'respond' | 'none'`,
  `waitingFor` names only for entitled viewers, `iconUrl` resolved under the
  viewer's store floor.
- The response message carries no basis (a person wrote it) and echoes only
  what the person typed plus a button label.
- Every route re-checks `organizationId` **and** thread visibility; the
  respond route additionally mirrors the instance-secret route's
  authorisation for each `secret` destination.
- `resumeState` is server-only and never presented, as on `ApprovalRequest`.

## 7. Humans — Rule zero surfaces

- **Home:** the card in the message feed, rendered by one
  `AgentCardMessage.tsx` mounted in `ChannelMessageRow` beside the seven
  (each of which stays as it is — `uiCards` is verbatim product output, and
  the two id-pointer cards keep their own authority rows). The reply panel
  shares the row renderer, so a card renders identically in a channel, a
  reply thread and the Threads inbox. Header: `AppIcon size="badge"` +
  service label top-left, title, subtitle, status pill; body: blocks in
  order (`MessageMarkdown` for text, the existing thumbnail path via
  `useAuthedObjectUrlFromPath` for images, `admin-input` controls for
  inputs); footer: up to four buttons, `primary` filled with `--accent`,
  `danger` with `--danger`, enabled only when `action === 'respond'`, every
  press `stopPropagation()`. A non-respondent sees "Waiting for Ondrej"
  where the buttons are; a resolved card shows "Allowed by Ondrej · 09:14"
  with the submitted values, buttons removed. No raw colours — tokens only.
- **Doorway:** named respondents get the existing mention bell + push
  (`<agent> mentioned you in <channel>`), deep-linking to the message; the
  card is the first thing they see. No new alert kind, no new page.
- **Response row:** `AgentCardResponseRow.tsx`, compact, under the card in
  its reply thread.
- **Verification:** headless Playwright on `http://localhost:5455` — a form
  card open, a press, the resolved card, and a non-respondent's view.

## 8. Realtime and API

- `GET /api/agent-cards/:cardId` → presenter `{ cardId, messageId, threadId,
  spec (with `secret` blocks' destination replaced by a label), service:
  { label, iconUrl }, status, expiresAt, action, waitingFor, resolution?:
  { actionKey, actionLabel, byUserId, byName, at, values, secrets:
  { [key]: 'provided' } } }`.
- `POST /api/agent-cards/:cardId/respond` (§4). Errors: `404`
  (unreadable), `403 CARD_NOT_RESPONDENT`, `409 CARD_NOT_OPEN`, `422
  CARD_INVALID_VALUES` naming the field keys, and the instance-secret
  route's own codes passed through.
- WS event **`card.updated`** `{ cardId, messageId, threadId, status }` on
  resolve/expire/cancel, published to channel + organisation scopes, content
  free by construction. The admin handler invalidates
  `agentCardKeys.card(cardId)`; the response message's ordinary
  `message.reply` refreshes the thread.
- Facade: `admin/src/facades/agent-cards/hooks.ts` — `useAgentCard(cardId)`,
  `useRespondToAgentCard()`; keys in `lib/query-keys.ts`.
- TaskEvents: `run.suspended { reason: 'card_response', cardId }`,
  `run.continued { fromCardId }`. Audit: `agent_card.responded`.

## 9. New vs reused

| Need | New | Reused |
|---|---|---|
| Card authority + lifecycle | `agent_cards` table, `AgentCardStatus`, one conditional-UPDATE claim | opaque-id-in-metadata + presenter pattern (`appSetupCard`, `todoRef`) |
| Card spec | `AgentCardSpec` block vocabulary in `@nessie/schemas` | zod `.strict()` discipline; `MessageMarkdown` for text |
| Posting | `card_post` builtin + `pa-tools/cards.ts` | `createAgentMessage` chokepoint, basis stamping, `createMessageMentionAlerts`, realtime helpers, `seedBuiltinToolRegistry` |
| Service mark | presenter slug → icon resolution; `AppIcon size="badge"` | `/api/apps/:id/icon`, `storeCatalogWhere`, `AppIcon` initials fallback |
| Images | — | attachment reach rules, thumbnails, `useAuthedObjectUrlFromPath` |
| Press | respond route + service; `agentCardResponse` metadata; orchestrator structural rule | `message-create` service (bookkeeping, orchestrate enqueue, realtime), `triggerIsHuman` guard |
| Waiting run | `waiting_input` status; `pendingInput` loop exit; shared suspend/resume cores (refactored out of the approval files); wait backstop | checkpoint persistence/claim/auto-load, `continuationOfRunId`, `run.continued`, `resumeState` shape, `approvalInstruction` slot |
| Secrets | `secret` block + destination validation at post time | `storeInstanceSecret`, the instance-secret route's authorisation, `secret_mcp_*` store, audit redaction |
| Context | `cardNote` + `withMessageNotes`; `buildAgentCardsBlock`; `cardResponseInstruction` | `attachmentNote` precedent, toolset-derived prompt blocks |
| Expiry | `sweepExpiredAgentCards` | `api-maintenance` timer, `sweepExpiredApprovals` shape |
| Surface | `AgentCardMessage.tsx`, `AgentCardResponseRow.tsx`, facade hooks | `ChannelMessageRow` mount point (one renderer for channel + reply panel), mention bell + push, `Pill`, theme tokens |

## 10. Phased path

1. **Cards that wake the agent** — schema + migration, `AgentCardSpec`
   (text/fields/image/link/input blocks), `card_post` without `wait`,
   presenter + respond route (values only), the response message, the
   orchestrator structural rule, `cardNote` in the transcript, the prompt
   one-liner, `card.updated`, the admin renderer + response row, expiry
   sweep, Playwright verification. *This phase alone delivers the product
   sentence: any agent posts a ticket/email/image/form card with buttons, a
   person presses, the resolved state is retained in chat and context.*
2. **Waiting runs** — `waiting_input`, `pendingInput` exit, the shared
   suspend/resume cores (approval paths migrated onto them in the same
   change), `resumeState` on the card, `cardResponseInstruction`, the wait
   backstop, run-cancel → card cancelled, expiry-resumes-once.
3. **Secret fields** — `secret` block with `connector_credential`,
   post-time destination validation, transactional `storeInstanceSecret`,
   `secretOutcomes`, the masked control, body-logging-off route registration.
4. **Later, each a deliberate decision** — `vault` destination (non-atomic,
   pending/stored/failed outcome); `card_withdraw` for the posting agent;
   a batch presenter (`GET /api/threads/:id/agent-cards?ids=`) if per-card
   fetches show up in feed timing; agents as respondents; re-expressing the
   existing `comms_connect` rendering on the block renderer.

## 11. Decisions (resolved with Ondrej, 2026-09-01) and what remains open

Resolved:

- **Who may press is the agent's call per card**: `requester`, `thread`, or
  named people. Default `requester` when there is one, else `thread`.
- **Form values are retained** in the chat (response message) and the
  context (transcript turn + card note).
- **Expiry is agent-set, none by default.**
- **Waiting is supported and agent-chosen** (`wait`), alongside
  wake-on-press.
- **Enabled by default for every agent that can communicate**; the prompt
  carries a one-line mention only when the tool is actually in the toolset.
- **A service mark in the top-left**, resolved by the server from a key.
- **A secret field goes straight to the secret store and is never
  recorded** beyond the fact that it was provided and where it landed.

Open, with a proposal each:

1. **Does a waiting run hold the thread slot?** Options: hold (matches
   approval suspension; typing past the card pends) or release (a typed
   message could start a second run beside the waiting one). Proposed:
   **hold**, with the 24 h backstop, because two runs of one agent in one
   thread is the state the slot exists to prevent.
2. **`waiting_input` versus reusing `waiting_approval`.** Proposed: **new
   value**; the label is user-visible in four places and "waiting for
   approval" on a form is a lie the UI would tell daily.
3. **Should expiry post a message?** Proposed: **no** — the frozen card and
   the state note are the record; a message per expiry is the noise the
   rolling watch status exists to avoid.
4. **Top-level card, threaded response.** The response starts a reply thread
   under a channel card and the agent's follow-up lands there. Proposed:
   keep — it is Slack's shape and keeps the room clean; the agent can still
   choose `replyPlacement: channel` for a standalone announcement.
5. **Vault destination semantics.** No agent can read a vault value today,
   so a `vault` secret is a catalogue entry for people. Proposed: ship it
   later only with an honest tool description, or not at all until an
   agent-side consumer exists.
