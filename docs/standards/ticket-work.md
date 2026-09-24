# Ticket work — who starts it, whose authority it runs under, who ends it

Authoritative standard. `AGENTS.md` → "Architecture" carries the one-line
summary and points here; **this file is the rule.** The design, the four
reviews every rule answers, and the PR order are in
[docs/plans/2026-09-23-ticket-driven-agents/overview.md](../plans/2026-09-23-ticket-driven-agents/overview.md);
where that plan and the code differ, the code and this file win.

A person moves a ticket into a start-work column; an agent a team set up picks
it up, and later, on a machine its owner confirmed once, has a local coding
agent do the work. One work record per ticket carries every later wake. The
platform owns that record's state: the agent is told the state in every wake,
and is never asked to manage it.

## What is shipped

Each rule is tagged with the PR that first enforces it in code:

- **(T0)** shipped with this file: the schema with its CHECKs and partial
  unique indexes, the Zod vocabularies, the queue payload shapes, the
  TaskEvent origin shape, the `ticket.work` purpose and its empty
  `isProjectDelegatedRun` arm, and the refusals that keep the two new trigger
  types uncreatable.
- **(T1)** shipped so far in T1: ticket event provenance (an origin on every
  ticket writer, `column_entered`, `priority_changed`), the dispatch job
  enqueued in the event's own transaction, and `trigger.ticket.dispatch`'s
  decision with one delivery row per decision; and `ticket_changed` itself,
  released with its typed configuration, its server-side resolution and
  field-level refusals, the one-pickup-per-column rule, and the Designer's
  `project_structure_read` and generated trigger catalogue; and what a
  decision then does — the work record and its one thread, the `ticket.work`
  run acting as the agent with its ticket tools, wakes that coalesce, the
  kickoff rebuilt from the record, the work thread's posting rule and event
  rows, `assignOnPickup`, teardown in the move and on disabling a trigger,
  and the `wakesPerTicket` and `startsPerDay` limits; and what the project
  sees — the Triggers editor's ticket fields with refusals on their fields,
  the column badge and column menu, the ticket's work chip and the card's
  dot, the work thread's wake rows, read-only composer and Tickets fold — and
  board watchers retired to people only. No machine does ticket work yet: the
  agent reads, comments on and moves tickets.
- **(from T1)**, **(from T3)**, **(from T4)**, **(from T5)** are rules the
  design fixes now and a later PR builds. Until that PR lands no code path
  exists that could break them, because nothing can create a `ticket_changed`
  or `document_changed` trigger (below).

The PR that ships a rule changes its tag here in the same change. A tag that
still says "from T*n*" after T*n* merged is a false statement about the code.

## Nothing is half-exposed (T0)

- `ticket_changed` and `document_changed` are in `AgentTriggerType` (Prisma)
  and `AgentTriggerTypeSchema` (`packages/schemas/src/lifecycle.ts`) before
  anything may create one. An unreleased type is listed in
  `UNRELEASED_TRIGGER_TYPES`
  (`packages/team-admin/src/trigger-type-availability.ts`), and every
  agent-trigger create surface refuses it with
  `unreleasedTriggerTypeRefusal`'s one sentence:
  `POST /api/agents/:agentId/triggers` answers 400
  `TRIGGER_TYPE_UNAVAILABLE`, `agent_trigger_create` throws it, and
  `createAgentTrigger` returns null before touching the database. **(T1)**
  `ticket_changed` is off the list; `document_changed` stays on it until T2.
- **Both types are agent-only, permanently.** Workflow installations are
  gated by `WORKFLOW_TRIGGER_TYPES` (manual, scheduled, webhook, event,
  interval), not by the release list: `POST
  /api/workflow-installations/:id/triggers` answers 400
  `TRIGGER_TYPE_UNAVAILABLE` with `workflowTriggerTypeRefusal`'s sentence,
  `workflow_trigger_create` throws it, and `createWorkflowTrigger` returns
  null. Each new type wakes an agent bound to its target channel, through a
  work record and `ticket.work` runs, and a workflow has none of these, so
  releasing a type for agents never opens it there. A new trigger type is
  agent-only until it is added to that list deliberately.
- Nothing that lists trigger types to a person or a model names an
  unreleased one: **(T1)** the agent tools' `type` enum and the Designer's
  trigger catalogue are generated from the typed config union
  (`AGENT_TRIGGER_INPUT_TYPES`, `packages/schemas/src/trigger-configs.ts`),
  which holds exactly the released types — a test holds the union and
  `RELEASED_TRIGGER_TYPES` equal — `workflow_trigger_create` offers exactly
  `WORKFLOW_TRIGGER_TYPES`, and the admin's `TriggerTypePicker` offers the
  released types it has an editor for. The picker serves the agent and the
  workflow editors alike, so **(T1)** it offers `ticket_changed` only for an
  agent target (`offerTicketChanged`), and `document_changed` nowhere. The
  `agent-triggers` browser suite pins the picker;
  `admin/test/trigger-type-unreleased.test.tsx` pins the labels, the
  agent-only offer and `document_changed`'s edit refusal.
- Taking a type off `UNRELEASED_TRIGGER_TYPES` is what releases it for
  agents. That happens in the PR that ships the type's typed configuration
  (its arm on the union), dispatch and editor (T1 for `ticket_changed`, T2
  for `document_changed`), never earlier: a row nobody can configure and
  that never fires is worse than a refusal.

## A ticket trigger's configuration is resolved on the server (T1)

- **The config is one arm of a typed union.** `AgentTriggerConfigInputSchema`
  (`packages/schemas/src/trigger-configs.ts`) discriminates on `type`, with a
  `.describe()` on every field (a test walks them with
  `listUndescribedFields`). The `ticket_changed` arm is `targetChannelId`
  beside a config of `boardId?`, `pickup? { columns: ({id} | {name} |
  {category: in_progress | review})[], assignOnPickup = true }` (null or
  absent: the trigger starts no work), `follow` and `endOn` (the stored
  schema's own fields and defaults), `limits { wakesPerTicket = 30,
  startsPerDay = 20 }` capped by `TICKET_TRIGGER_LIMIT_CEILINGS`, and
  `instructions { general, onPickup?, onTicketChanged?, onSessionTurnEnded?,
  onReminder?, onQueued? }`. It is strict: an unknown key is refused. A limit
  or option nothing enforces yet is not on it; the PR that enforces one adds
  it. The other arms describe the keys their fire paths read and are not
  checked by the union; those types keep their own checks and the generic
  refusal.
- **Resolution** (`resolveTicketChangedTrigger`,
  `packages/team-admin/src/trigger-ticket-config.ts`) derives the project
  from the target channel, never from the caller. The channel must be live
  (not deleted or archived), ordinary (`standard`, no system type, no DM
  key), **public** — every ticket reader must be able to open its work
  thread — and have the agent bound. `boardId` may be left out when that
  project has exactly one board; a board of another project is refused. A
  pickup column is resolved by id, by name (case-insensitive, exactly one
  match) or by category (every column of it), and stored by id; an `endOn`
  id must be on the board, and a pickup column that `endOn` would end is
  refused. `targetThreadId` and `nextRunAt` are refused. The stored config is
  `TicketChangedStoredConfigSchema`'s shape with limits and instructions
  (`TicketChangedWorkConfigSchema` types them), and the trigger's
  `scope_project_id` / `scope_board_id` are the resolved project and board.
- **Refusals are field-level.** A refused config throws
  `TriggerConfigRefusalError` (`trigger-config-refusal.ts`) with one
  `{ path, reason }` per wrong field, for example `pickup.columns[0]: no
  column "In Progres" on board Engineering (columns: Backlog, In progress,
  Review, Done)`. The Triggers routes answer 400 `TRIGGER_CONFIG_REFUSED`
  with the first path as `error.field` and every refusal in `error.details`;
  `agent_trigger_create` and `agent_trigger_update` relay the message as it
  is, and on success say back the board as a link and the columns it
  resolved.
- **One enabled pickup trigger per column.** At most one enabled
  `ticket_changed` trigger picks up from a column, so two agents never start
  on the same ticket. It is checked on create, on every edit, on switching a
  trigger on (`updateAgentTrigger` with `enabled: true`) and on resume
  (`resumeAgentTrigger`, `ticketTriggerPickupConflict`), each under a
  transaction-scoped advisory lock on the board, so two writes racing for a
  column cannot both pass; the refusal names the other trigger and its
  agent. A disabled trigger claims nothing.
- **An edit names only what it changes.** `updateAgentTrigger` reads the
  stored config back in the input's words (`ticketChangedConfigAsInput`),
  lays the patch's top-level keys over it and resolves the whole again, so a
  changed channel or board re-checks every column. A name or description
  edit resolves nothing.
- **Authorship grants nothing.** Every agent trigger records who set it up
  as `config.authorUserId` (server-owned: stripped from client input, never
  returned). It is not `createdByUserId`, because that key is what
  `resolveTriggerExecutionOrigin` and the resume check read as the identity
  a schedule's fire acts as; an author on any other trigger reconstructs
  nobody, which `worker/src/control/trigger-identity.test.ts` pins.

## A ticket or document trigger is found by its scope

- **(T0)** `agent_triggers.scope_project_id` and `scope_board_id` exist for
  the two new types only; every existing type leaves both null. Both keys are
  `ON DELETE SET NULL`, so deleting the board or project leaves the trigger
  row behind, unscoped.
- **(T1)** `createAgentTrigger` and `updateAgentTrigger` write both from the
  resolved configuration (above), in the transaction that writes the config.
- **(T1)** The ticket dispatcher looks triggers up by these columns, never by
  loading every trigger in the organisation and matching JSON in memory:
  `dispatchTicketEvent` (`worker/src/control/ticket-trigger-dispatch.ts`)
  reads the enabled, active `ticket_changed` triggers whose `scope_board_id`
  is the event's board, plus any trigger with live work on the ticket, which
  follows it even to another board. A trigger whose scope is null matches
  **nothing** — never every board. **(T1)** One the dispatcher still meets,
  through its live work, with no scope or a stored config that no longer
  parses, writes a `config_invalid` skip and moves to health `error` with
  reason `ticket_trigger_config_invalid`. **(from T1)** A null scope with no
  live work shows its health reason on the Triggers page too.

## Only a board editor's own move starts work; board editors, and an opted-in board source, steer it

- **Origin is stamped by the layer that authenticated the call, never by the
  caller.** The shape is T0: `TaskEventOriginSchema`
  (`packages/schemas/src/task-events.ts`) is an allowlist, like
  `PERSON_MESSAGE_AUTHORSHIP` — `session` (a route authenticated by a person's
  own browser or app session cookie, and nothing else), `token { keyId }` (API
  keys and the MCP surface), `agent { agentId, runId }` (worker ticket tools,
  which always run inside a run), `source { boardSourceId }` (inbound board
  sync) and `system` (everything else, including migrations and platform
  teardown). `ColumnEnteredTaskEventPayloadSchema` and
  `PriorityChangedTaskEventPayloadSchema` refuse an author `by` that
  disagrees with the origin — a `session` or `token` origin must name its
  member's user id, an `agent` origin `agent:<agentId>` or the member its run
  acted for, a `source` origin only `source:<boardSourceId>` (what
  `board-source-apply.ts` writes) — and refuse an event that changes nothing.
  **(T1)** Every ticket writer stamps it, and writes the two events, as
  [ticket activity](ticket-activity.md) → "History" lists: `session` only
  when the global auth hook verified a person's own session token
  (`request.authenticatedWith`), `token` for the MCP surface's agent
  credential, `agent` from the worker's ticket tools, `source` from a
  board-source apply, `system` when a writer names none. An event whose
  origin does not parse is read as `system`.
- **(T1) A pickup fires only for a `session`-origin event whose author
  can edit the board**: a `column_entered` into a start-work column from
  outside the pickup set, or a `created` straight into one (both wake with
  reason `pickup`). "Can edit the board" is `canMemberEditProjectBoards` — a
  live organisation member who is in the project, or an organisation owner or
  admin — asked by the dispatcher when it decides, a moment after the event
  was written, so an author who lost the right in between starts nothing. An
  agent's move, a token's move, a source sync, the platform and an agent's
  `ticket_create` into the column start nothing: each writes a `skipped`
  delivery with its reason (`agent_origin`, `token_origin`, `source_origin`,
  `system_origin`, `not_board_editor`), and
  `TICKET_TRIGGER_SKIP_SENTENCES` holds the sentence for it. **(from T1)** The
  ticket shows that sentence. Tests pin each of those as starting nothing.
- **(T1) A follow wake fires for a `session`-origin event by a person who
  can edit the board and — only when the trigger sets
  `follow.includeSourceEvents` — for a `source`-origin event. Nothing else
  wakes it, and a source event never picks up or resumes work.** A re-entry
  into a start-work column obeys the same rule, so a token's or an agent's
  move back leaves a parked record parked, and its skip carries `reentry` so
  the ticket says the work did not *resume*; a move between two start-work
  columns re-enters nothing, and with live work is an ordinary `moved`
  follow. **(T1)** Text from anyone but a
  board editor — agents, sources (opted in or not), external provider users,
  people who cannot edit the board — reaches the agent only as quoted,
  attributed, untrusted content, which it is told never to forward to the
  coding agent as an instruction: `describeWakeEvent`
  (`worker/src/control/ticket-work-events.ts`) asks each author's right to
  edit the board when it builds the kickoff, and frames a wake the dispatcher
  marked `untrusted` (an opted-in source event) the same way whoever wrote it.
  The ticket's title is quoted as ticket data in every kickoff, and a
  description is quoted as its author's words only while the ticket still
  says what they wrote: `detail_edited` records the new text's hash
  (`detailSha256`, `taskDetailSha256`), and a description a later write
  replaced is framed untrusted. Each follow kind wakes with its own
  reason (`TICKET_FOLLOW_WAKE_REASONS`): comment `ticket_commented`,
  description `ticket_description_changed`, priority
  `ticket_priority_changed`, labels `ticket_labels_changed`, assignee
  `ticket_assignee_changed`, moved `ticket_moved`, and `thread_message` and
  `document_changed` by those names.
- **(T1) Every decision is exactly one `agent_trigger_deliveries` row**,
  deduped on `ticket:<triggerId>:<taskEventId>`, with `source` `pickup` or
  `follow` and a `TicketTriggerDeliveryPayloadSchema` payload (ids, the origin
  kind, the outcome, the wake or skip reason). A skip names its reason in
  `errorMessage` too, as a webhook skip does. An event the trigger has
  nothing to do with — a kind it does not follow, a column that is neither
  start-work nor end, a ticket it has no live work on — writes no row; every
  event it would act on writes one. The decision itself is the pure
  `decideTicketTrigger` (`worker/src/control/ticket-trigger-decision.ts`);
  a start or a wake goes through the `TicketWorkSeam` (`createTicketWorkSeam`,
  `worker/src/control/ticket-work.ts`) inside the delivery's transaction, and
  a throw there leaves a failed, retryable row — a classified authority loss,
  such as the agent no longer being in the target channel, also moves the
  trigger's health, through the `recordTriggerRunFailure` a trigger fire uses
  — which the delivery-retry poller decides again through
  `reattemptTicketTriggerDelivery` because a ticket trigger has no fixed
  thread. The bookkeeping is `settleTicketDelivery`
  (`ticket-trigger-settle.ts`), shared with the work thread's messages.
  **A start, a resume and an end are decided against where the ticket is
  now**, never the column the event named: the seam takes the ticket's work
  lock (`lockTicketColumn`, `packages/team-admin/src/ticket-work-lock.ts`) —
  the same row lock every move's teardown takes — and reads its column, so a
  ticket moved in and back out before the job ran starts nothing, and a
  parked one moved back and out again stays parked (both skip
  `left_pickup_column`). Entering an end column sends one machine-less
  `ticket_moved` wake for the record *that move* ended — its `work_ended` row
  names the move as `causeEventId`, so a second move into an end column
  re-announces nothing — or for a live record the seam ends then, while the
  ticket is still in an end column; except when the trigger's own agent made
  the move (`own_agent_event`). A priority change on a `queued` record wakes
  nothing (`priority_while_queued`).
- **(T1) Only board editors write in a work thread**, checked live on every
  write by every writer (`findTicketWorkThread` and
  `canPostInTicketWorkThread`, `packages/team-admin/src/ticket-work-thread.ts`;
  a thread is a work thread for as long as any work record names it, its work
  ended or its trigger deleted): the message route, an edit of a message there
  (`PATCH /api/threads/:threadId/messages/:messageId`, so a stamp never keeps
  carrying the words of someone who lost the right), and `send_message` — a
  Personal Assistant posting as its person is that person writing. The REST
  doors pass the request's own UOA-verified role (`isOrganizationAdmin`), so
  a demotion upstream counts before the local row catches up. Anyone else
  gets 403 `TICKET_WORK_THREAD_READ_ONLY` (the tool: its error) with
  `TICKET_WORK_THREAD_READ_ONLY_SENTENCE`, the words the composer shows. A
  board editor's message there is stamped `metadata.ticketWorkSteer = true`
  and starts no ordinary run: the transaction that writes it enqueues
  `ticket-work.thread-message` (`enqueueTicketWorkThreadMessage`) instead of
  orchestration, and the worker decides it (`dispatchTicketThreadMessage`) as
  a `thread_message` follow of the thread's live record — under the origin
  rule again, one delivery deduped on `thread:<triggerId>:<messageId>`,
  retried by the same poller arm. A message that wakes nothing still writes a
  skipped delivery with its reason — `work_ended`, `trigger_disabled`,
  `config_invalid`, `not_followed` (`ticketWorkThreadMessageOutcome`,
  `packages/schemas/src/ticket-work-view.ts`) — and the composer says the
  same before anyone sends. **No card is answered in a work
  thread**: `ticket.work` runs cannot post one (`card_post` is in
  `TICKET_WORK_PERSON_TOOL_IDS`, because an unattended run's card is
  answerable by anyone who reads the channel), and `respondToAgentCard`
  refuses a card whose thread is a work thread with 403
  `TICKET_WORK_THREAD_READ_ONLY` before it reads or writes anything.

## A `ticket.work` run acts as the agent, never as a person

- **(T0) Every `ticket.work` kickoff drains alone.** `TICKET_WORK_PURPOSE`
  (`packages/schemas/src/ticket-work.ts`) is in `DRAINS_ALONE_PURPOSES`
  (`packages/db/src/thread-serialization.ts`): a pended wake becomes its own
  follow-up run and is never folded into a batch with people's messages, so no
  person's message is consumed under the agent's authority.
  `packages/db/test/thread-serialization-ticket-work.test.ts` pins it.
- **(T1) Pending wakes for the same work record coalesce when they are
  enqueued, not when they drain.** At most one pending `ticket.work` row
  exists per work record: a wake for a record that already has one folds its
  event into that row's kickoff instead of adding a second row, so the one
  run that drains lists every event in order (*"Since your last run, in order
  (2 changes): 1. ticket_commented: Ondrej commented: … 2. …"*) and counts
  once against `wakesPerTicket`. Draining alone is unchanged: the drain still
  takes one row per run. The work-record key is a typed field of the stored
  actor context, `actionContext.ticketWorkId`, and the fold runs under the
  thread's claim/drain lock (`lockThreadRunSlot`, `@nessie/db`), so a drain
  has either already taken the kickoff (the wake then pends its own) or has
  not started (the run it starts reads the folded kickoff). The kickoff keeps
  its events in `metadata.ticketWorkKickoff` (`TicketWorkKickoffMetadataSchema`)
  and is re-rendered whole on each fold. A pending row of another purpose —
  a person's ordinary message, say — is never folded into, and never drains
  with a kickoff.
- **(T1) The actor is the agent**: `actorType: 'agent'`,
  `effectiveUserId: null`, `interactive: false`, purpose `ticket.work`, the
  record in `actionContext.ticketWorkId` (`queueTicketWorkRun`,
  `worker/src/control/ticket-work-run.ts`) — the way event triggers already
  run (`worker/src/control/trigger-origin.ts`). `effectiveUserId` is read
  across the codebase as "act as this person", so the run **never
  reconstructs one**: not the mover, not the trigger's author (`authorUserId`
  is authorship and grants nothing, above), not the machine owner. Tools that
  need a person refuse, and `worker/test/db/ticket-work-authority.test.ts`
  pins each: `kb_page_read` of a person's private space (the agent reads with
  its own reach), `schedule_task`, `card_post`, the mailbox and every other mail tool, and
  every setup verb (`project_create`, `channel_create`, `agent_create`,
  `agent_trigger_create`, `ticket_board_create`, `ticket_label_create`, and
  the ticket tools that need a person, `ticket_create` and `ticket_assign`).
  Schedules and mail would otherwise fall back to the agent's own authority,
  so `TICKET_WORK_PERSON_TOOL_IDS` (`worker/src/run/execute/ticket-work-setup.ts`)
  are withheld from the run's toolset and refused by the builtin dispatcher;
  identity tools and setup verbs refuse on their own, through
  `requireActingUserId`, which says why on a ticket.work run.
- **(T0) `isProjectDelegatedRun` decides a `ticket.work` run by its own arm,
  first** (`worker/src/run/execute/run-setup.ts`). So the run can never be
  lent project tools through a person-started arm (`interactive`,
  `agent.peer_delegation`, `channel.policy`), whatever its actor context says.
  **(T1)** The arm admits a shared agent whose run serves a work record — run
  setup re-reads it, and it must name this agent and this thread
  (`loadTicketWorkRunFacts`) — of this channel's own project, and the caller
  still requires the agent's binding to the channel; it is lent only
  `TICKET_WORK_PROJECT_TOOL_IDS` (read, list, board read, update, move,
  transition, the checklist, label, comment and file reads, and comment add)
  that its tool policy grants; `worker/test/pa-tools-ticket-activity.test.ts`
  pins it for user and agent actors, interactive or not. Those tools resolve a
  `TicketMember` (`worker/src/run/pa-tools/ticket-member.ts`): the agent
  itself, whose reach is its live binding to a channel of the project
  (`projectFor`, refusing with *"<agent> is no longer in a channel of this
  project."*), which reads a run-derived ticket only when that run carries no
  disclosure basis, and which writes through an `AgentTaskActor`
  (`packages/team-admin/src/task-access.ts`) credited `agent:<id>` with its
  run — never through `requireActingUserId`. The run's conversation is only
  the agent's own replies and people's stamped messages
  (`ticketWorkConversationWhere`), and it recalls no history and no memory
  (`ticketWorkRecallSkipped`): the work thread is a conversation with its
  agent, so recall would search that same thread and hand back exactly what
  the window leaves out. Every kickoff is built from the ticket, so
  the run starts having read its project: anything it writes where that
  project's audience is not already implied carries the project's basis (in
  the work thread itself, a channel of the project, it is implied).
- **(from T1) The run signs with the ledger as event triggers do, with no
  user identity.** A deployment that refuses unsigned agent runs sets the
  record's `stateReason` to `identity_unverifiable`, which the chip shows,
  and raises the trigger's health banner.
- **(T1)** `ticket.work` run limits are clamped to `TICKET_WORK_RUN_CEILING`
  in `worker/src/run/run-budget.ts` (500 cents, 300k tokens, 200 iterations,
  300 tool calls, 20 minutes), whatever the agent's own `runLimits` say; a
  tighter limit of the agent's own still wins.

## The work record, its thread, and what every wake says (T1)

- **A pickup creates one record** (`startTicketWork`,
  `worker/src/control/ticket-work.ts`): `active`, no executor, `startedByUserId`
  the mover, `startedByEventId` the `column_entered` or `created` event, and a
  `work_started` row on the ticket — only while the ticket is still in a
  start-work column, read under its work lock (above). A pickup racing
  another for the same ticket refuses (`no_longer_applies`) under the
  trigger's start lock. The target channel is re-checked on every start and
  wake: still live, bound, ordinary and public, or the trigger's health moves
  (`agent_channel_access_lost`).
- **One thread per (trigger, ticket)** (`ensureTicketWorkThread`,
  `packages/team-admin/src/ticket-work-thread.ts`, apart from the
  size-capped `agent-conversations.ts`): a conversation with the trigger's
  agent in its target channel, opened by nobody, with metadata
  `{ taskId, triggerId }` and the title `ticketWorkThreadTitle` gives — the
  mirrored key and the title (*"ENG-12 Fix login redirect"*), or the title
  alone for a native ticket, which has no key. A ticket that comes back after
  its work ended is worked in the same thread while it is still in the
  trigger's target channel.
- **Every wake's kickoff is rebuilt from the record**
  (`renderTicketWorkKickoff`, `worker/src/control/ticket-work-kickoff.ts`),
  with the same three blocks whatever woke it: *Why you were woken* (each
  event's reason code and what happened, in order), *State* (the ticket and
  its id, its title quoted as ticket data, board, column and category,
  priority and assignee; every column of the board with its category, what
  moving the ticket there does — `starts work`, `ends work`, `parks work` —
  and its id; the work's status: live, parked (and that only a person moving
  it back resumes it), or ended with its reason and that nothing wakes it
  again; "wake n of m"; that no machine does ticket work yet; the pull
  request on record; that this is the ticket's work thread and, while the
  work is live, what wakes it next and that its own changes never do) and
  *Instructions* (the trigger's `general`, then — while the work is live —
  each section matching a reason: `onPickup`, `onTicketChanged` for every
  ticket change and thread message, `onSessionTurnEnded`, `onReminder`,
  `onQueued`). Each setting is read on its own (`ticketWorkConfigOf`), so an
  instruction that no longer parses costs the instructions alone. A comment
  carries its full text and its author, a description change the new
  description (T2 adds the line diff), a thread message the message.
- **A kickoff is rendered again when its run starts**
  (`rerenderTicketWorkKickoff`, called by `resolveRunKickoffPrompt` in
  `worker/src/run/execute/run-kickoff-prompt.ts`), from the record as it is
  then, and written back: a wake that pended behind another run may drain
  after the work ended or parked, and its run is told so, never the state it
  was queued in. The wake it counted as is kept in
  `metadata.ticketWorkKickoff.wakeNumber`. A run whose record has ended
  (`loadTicketWorkRunFacts`'s `live`) keeps its read and comment tools and
  loses `ticket_update`, `ticket_move` and `ticket_transition`
  (`withoutEndedWorkWrites`), so a stale plan cannot move the ticket back.
- **Every wake writes one compact thread row** — a `system` message with
  `metadata.ticketWorkEvent` (`TicketWorkThreadEventSchema`: `woken` with its
  wake reason, or `stopped` with its state reason) and the content *"Woken:
  Ondrej commented"* or *"Stopped: 30 wakes used. …"*. The thread feed admits
  those rows by their `kind` (`listThreadMessages`,
  `api/src/services/message-read-model.ts`) and still hides every kickoff. A
  row never repeats ticket text, because a public channel's audience can be
  wider than the ticket's project.
- **Ticket activity** gains `work_started`, `work_paused` (a review column
  parked it), `work_resumed` (a person moved it back) and `work_ended`
  (`TICKET_WORK_ACTIVITY_EVENT_TYPES`, `TicketWorkActivityPayloadSchema`:
  `system` origin, the record, its status and reason, `by` for whoever caused
  it, and `causeEventId` for the move that did); `work_queued` is named for
  the machine queue (from T4). None is dispatched. The ticket dialog's chip
  lists them (below).
- **(T1) `assignOnPickup` is applied in the transaction that places the
  ticket** (`resolvePickupAssignment` and `resolvePickupAssignmentForStatus`,
  `packages/team-admin/src/ticket-work-pickup.ts`, `recordPickupAssignment`
  writing the row), at every door that can start work: a drag or
  `ticket_move` (`moveProjectTaskToColumn`), a status transition
  (`transitionProjectTask`, the ticket dialog's status select) and a create
  straight into a start-work column (`createProjectTask`). When an unassigned
  ticket enters a pickup column of an enabled trigger that assigns on pickup
  and the change itself qualifies — a person's own session, a board editor,
  from outside the pickup set, no live work of that trigger on the ticket —
  the trigger's agent is assigned instead of the mover, with an `assigned`
  event of `system` origin and reason `assign_on_pickup` that wakes nothing.
  A ticket with any assignee keeps it, and any other move keeps the
  assign-the-mover rule (an agent with no person behind it that moves an
  unassigned ticket into in-progress takes it itself).

## What the project sees, and where a person sets it up (T1)

Everything a mover needs is on the ticket, the board and the work thread,
readable by the project audience; none of it needs the owner-only Triggers
routes, and none of it names a machine.

- **Three reads, each on its own gate** (`packages/team-admin/src/ticket-work-view.ts`,
  `api/src/routes/ticket-work.ts`, shapes in
  `packages/schemas/src/ticket-work-view.ts`):
  - `GET /api/tasks/:taskId/work`, behind the ticket's own read rule: each
    trigger's newest record (`TicketWorkChipRecordSchema`: agent, status and
    reason, who started it, last wake and its reason, wake n of
    `limits.wakesPerTicket`) and the work thread **only for a viewer who may
    open it** (`buildViewerThreadWhere`); a reader who may not gets the same
    state and no door. It also carries `lastSkip`: the newest pickup skip, or
    refused re-entry (`reentry`), in `TICKET_WORK_NOTICE_SKIP_REASONS` (an
    agent's, a token's, a source's or the platform's move, a non-editor's,
    the daily start limit) while nothing newer happened under that trigger —
    *"Moved by an agent, so work did not start…"* belongs on the ticket that
    did not start, and *"Moved back by an agent, so work did not resume…"*
    (`ticketTriggerSkipSentence`) on the one whose work stayed parked. And
    `history`: the ticket's newest `work_*` rows, each with its agent, what
    happened, why, and who caused it by name.
  - `GET /api/projects/:projectId/boards/:boardId/ticket-work`, behind project
    access: the columns an **enabled, active** ticket trigger starts work from
    (what the dispatcher itself reads), the cards whose newest record is live
    or failed at a limit, and `viewerCanCreateTriggers` — the Triggers
    routes' own `requireOwner`, asked on the server.
  - `GET /api/threads/:threadId/ticket-work`, behind the thread's own read
    rule: whether it is a work thread (`findTicketWorkThread`), whether the
    viewer may write there (`canPostInTicketWorkThread`, the rule the message
    route enforces, with the request's own role), and `messageOutcome` —
    whether a message there reaches the agent, or which skip it would be
    (`ticketWorkThreadMessageOutcome`, the dispatcher's own rule).
- **The ticket dialog's chip** (`TicketWorkChip`, first in the meta column):
  *"CTO · working · started 14:05"*, who started it, *"Last woken 14:32: a
  comment · wake 3 of 30"*, the reason it stopped or waits (*"Stopped: 30
  wakes used. Move the ticket out of and back into a start-work column to
  continue."*, *"Parked while the ticket is in review…"*), and "Open the work
  thread" for its readers. The board card (`KanbanCard`) shows the agent's
  avatar with a state dot (`TicketWorkCardDot`). Both re-read while work is
  live, because work moves in the worker after the move has answered.
- **The board column** says *"Moving here starts work: <agent>"* to everyone
  (`ColumnStartsWorkBadge`). Its menu offers *"Start work with an agent…"* on
  In progress and Review columns — the categories a pickup names by category —
  only when `viewerCanCreateTriggers`, and opens the Triggers editor on a
  ticket trigger for that board and column (`BoardStartWorkDialog`), on a
  draft of its own so the Triggers page's unsent create never replaces it.
- **The Triggers editor** offers "Ticket change" for an agent target only
  (`TriggerTypePicker offerTicketChanged`). Its fields (`TicketTriggerFields`,
  `ticket-trigger-form.ts`) narrow the channel list to live, ordinary, public
  project channels and say why (`TICKET_TARGET_CHANNEL_HINT`); pick the board
  and its columns (a new trigger starts from the board's In progress
  columns, and a column an end rule covers cannot also start work); follow
  kinds with the connected-board opt-in explained, and the mirrored board
  named when there is one; end columns; both limits; and sectioned
  instructions with a neutral example. It posts the typed config by column
  id, and a `TRIGGER_CONFIG_REFUSED` answer lands **on the field its path
  names** (`groupTicketRefusals`). A ticket trigger's page names its board
  and columns (`useTicketTriggerFacts`) and says what each delivery decided
  and why (`ticketDeliveryLine`: the skip sentence, or the wake reason).
- **The work thread** renders each `metadata.ticketWorkEvent` row compactly
  (`TicketWorkEventRow`: *"Woken: Ondrej commented"*, time, no author). A room
  member who cannot edit the ticket's board gets `ChannelPostRefusal`'s line
  in place of the composer — *"Comment on the ticket to give the agent more
  information."* — with the ticket's link, before they type what the server
  would refuse. In the agent's conversation list, threads whose record names
  a ticket (`AgentConversationRecord.ticket`, from the thread's own
  `{ taskId, triggerId }` metadata) fold under **Tickets**, closed unless the
  one on screen is in it.
- **Board watchers are people.** An agent recipient is refused with
  `AGENT_WATCHERS_RETIRED` (*"Agents start work from the column menu…"*), the
  Watchers editor offers no agent, and
  `20260924000000_board_agent_watchers_to_ticket_triggers` turned every agent
  row of a wakeable agent into a paused, disabled, follow-only trigger
  ("Board watcher: <board>", no start-work columns and no instructions until
  a person adds them), naming each row in a WARNING line of the database log
  ([board watchers §11](../plans/2026-09-06-board-watchers.md)). On a
  mirrored project both the editor and the agent tools' answer
  (`describeMirroredSources`) say that a move on the connected board never
  starts work, and what its own changes can still do.

## The machine owner's authority is read only by the standing-policy binder (from T4)

- The author of a standing policy is never in the run's actor context. It
  travels as `actionContext.standingPolicy = { policyId, authorUserId }`, and
  only `bindStandingPolicyExecutor`
  (`packages/executor-manage/src/executor-standing-policy-binding.ts`), its
  provenance arm and the dispatch fence beside
  `assertExecutorCommandBindingCurrent` read it. No tool, gate or disclosure
  check may treat it as "act as this person".
- Every wake with an active record is bound afresh and every check runs again:
  the policy is `live` and names this trigger, agent and executor; the trigger
  and descriptor digests still match; the author is re-resolved live with UOA,
  failing closed and never from a cache; the machine is online and still
  private to the author; the target channel is still live, ordinary and public
  in the project; the run consumes only this work record's kickoffs; the limits
  allow it. A refusal writes `executor.run.policy_refused` and the run
  continues unbound.
- In a `ticket.work` run, host-output-bearing writes are admitted only to that
  ticket's comments and its work thread, and the machine is named only to its
  owner and executor admins, never to the project audience.
- **(T0) The policy's shape is enforced by the database.**
  `executor_standing_policies_confirmed_known` requires a `live` or
  `suspended` policy to carry `confirmed_at` and `author_origin`;
  `suspended_reason` is set exactly while suspended, and `ended_at` /
  `ended_reason` exactly once ended. The pool,
  `executor_standing_policy_executors`, has one row per machine (composite
  primary key, unique `(policy_id, position)`, `position` 0 or 1), because a
  JSON array cannot hold a foreign key.
- **(T0) One binding policy and one outstanding card per trigger.**
  `executor_standing_policies_one_binding` allows one `live` or `suspended`
  policy per `trigger_id`, and `executor_standing_policies_one_preparing` one
  `preparing` card. So the dispatcher and the binder always find exactly one
  policy for a trigger; a confirm ends the policy it replaces (`replaced`) in
  its own transaction before it goes live; and a new prepare ends the card it
  replaces first, so a stale card can never be confirmed. A policy whose
  trigger was deleted (`trigger_id` null) blocks nothing.
- **(T0) The pool's executor key cascades.** No product path hard-deletes an
  executor: revoking one is a status change and a fence that ends its
  policies first (from T4). The one hard delete is the organisation's own,
  which removes its executors and its policies in one statement, and a
  `RESTRICT` or `NO ACTION` key on the pool refuses that delete whenever a
  pool exists. A test pins the organisation delete.
- **(from T4) Limits and digests.** Lowering a limit is the one edit of a
  pinned field that does not suspend the policy: the edit recomputes
  `triggerDigest` in the same transaction, so binding check 2 still matches.
  Raising one takes a new prepare and a new card. `dailyUsd` is per policy per
  day, while `AgentTicketWork.costUsd` is a record's lifetime total and
  cannot be split across midnight, so T4 adds a per-policy daily spend ledger
  (policy, day, cost, unique on the pair) with its migration.

## One live record per (trigger, ticket), one record per machine (T0)

Five partial unique indexes in
`api/prisma/migrations/20260923220000_ticket_work_contracts/migration.sql`
hold these, so no read-then-write race can break them:

- `agent_ticket_work_one_live`: one live record (`queued`, `active`, `parked`
  or `waiting_machine`) per `(trigger_id, task_id)`. A ticket re-entering a
  pickup column while its record is live, `parked` included, is a
  `ticket_moved` follow on that record, never a second pickup, and a person's
  re-entry resumes a parked record (T1).
- `agent_ticket_work_one_per_executor`: one record holds each `executor_id` —
  the `active` one, or the `waiting_machine` one waiting for that machine to
  reconnect (`TICKET_WORK_MACHINE_HOLDING_STATUSES`). A dequeue onto a machine
  that just came back therefore cannot take the slot before the ticket that
  was mid-work there resumes, and the pool dispatcher's "free" means no
  record in either status (from T4 and T5). A `waiting_machine` record that
  waits for machine access rather than for its machine names no executor and
  holds nothing: a pickup while access is not set up or suspended is never
  pinned, and suspending access unpins its `active` records in the same
  transaction (from T4). A `parked` or `queued` record may still name an
  executor without holding it. `policyId` / `executorId` are written by the
  dispatcher, never by run setup.
- `agent_reminders_one_pending_per_work`: one pending reminder per work
  record; a new `check_back_in` replaces it (from T3).
- `executor_standing_policies_one_binding` and
  `executor_standing_policies_one_preparing`: above.

Prisma cannot express a partial index, so these exist only in migration SQL,
and a generated migration that drops them is wrong.

`agent_ticket_work_ended_known` requires `ended_at` and `ended_reason` exactly
when a record is terminal. `triggerId` and `policyId` are `onDelete: SetNull`,
so a record and its audit outlive a deleted trigger or policy; the trigger
delete service ends live records first (T1). `active_ms` is a `BIGINT`
(Prisma `BigInt`), because an `INTEGER` of milliseconds overflows at about 596
hours.

## Teardown, limits and session closes are the platform's

Session teardown never depends on the model: a run cannot bind once its policy
has ended, and when the agent itself moves a ticket to Done, the loop guard
suppresses its own wake. So each of these happens **in the transaction that
causes it**:

- **(T1) Entering an `endOn` column**, whoever moved the ticket, the agent
  included: the record goes to `done` in a done-category column
  (`stateReason: merged` when a merged pull request is on record, `left_flow`
  otherwise) or `cancelled` (`left_flow`), its reminders are cancelled and a
  `work_ended` row names who moved it, all inside the move transaction —
  `recordColumnEntered` calls `applyTicketWorkColumnEntry`
  (`packages/team-admin/src/ticket-work-teardown.ts`), so a drag, a
  `ticket_move`, a status transition and an inbound source change tear down
  alike, each after taking the ticket's work lock first (`lockTicketForWork`)
  so a pickup being decided at the same moment is seen or sees this move. A
  ticket that leaves every column — archived to cancelled or failed, by a
  person, a source or the agent's own `ticket_transition` — writes no
  `column_entered`; its live work is `cancelled` with `left_flow` in the same
  transaction (`applyTicketWorkLeftBoard`), and nothing wakes. The agent then
  gets one machine-less `ticket_moved` wake, only to comment (none for its
  own move). A review-category column outside `endOn` and outside the pickup
  set parks the record instead, with a `work_paused` row; a person's move
  back resumes it with `work_resumed`. **(from T4)** The same
  transaction frees the record's machine, writes its sessions' close requests
  and enqueues the pool dispatcher; in T1 no record holds a machine.
- **(T1) Disabling or deleting the trigger** ends every live record with
  `trigger_disabled`, in that transaction (`endTicketWorkForTrigger`,
  `packages/team-admin/src/ticket-work-records.ts`: `updateAgentTrigger`
  switching it off, the Triggers page's pause, `deleteAgentTrigger`, which
  ends them first, and `recordTriggerHealthFailure` when a classified failure
  — a lost target channel, a config that no longer parses — switches it off).
  **(from T4)** Its sessions get close requests
  (`trigger_changed`), and the trigger's policy ends, with `trigger_disabled`
  or `trigger_deleted`, so re-enabling a trigger takes a fresh confirmation.
- **(from T4) Suspending machine access** (either `suspendedReason`) moves
  every `active` record of that policy to `waiting_machine` with
  `machine_access_suspended` and unpins it, which frees the machine, pauses
  the hours clock and stops quiet wakes; its sessions get close requests
  (`policy_suspended`). A pickup while access is suspended or not yet set up
  gets one short, unbound pickup wake and then waits the same way, with
  `machine_access_suspended` or `machine_access_not_set_up`. The transaction
  that confirms or re-confirms access moves those records to `queued` and
  enqueues the dispatcher, which resumes them with a `dequeued` wake.
  **Ending machine access** cancels every live record of the policy with
  `machine_access_ended`, and its sessions get close requests
  (`policy_ended`).
- **(from T4) Sessions are closed by the server.** Session-scoped
  `executorCodingSessionCloseRequest` rows for the record's `sessionIds` are
  written in the same transaction as the ticket leaving the flow
  (`ticket_left_flow`), the trigger being disabled, deleted or edited in a
  pinned field (`trigger_changed`), the policy suspending
  (`policy_suspended`) or ending (`policy_ended`), or a limit (`work_limit`).
  T4 adds those five reasons to `EXECUTOR_CODING_SESSION_CLOSE_REASONS` and
  its CHECK.
- **Limits are enforced by the platform.** **(T1)** A wake that would start a
  run past `wakesPerTicket` (every model run counts once; a wake folded into a
  pending kickoff does not count again) starts none: the record goes to
  `failed` with `limit_wakes`, the ticket gets a `work_ended` row, the thread a
  *"Stopped: 30 wakes used. Move the ticket out of and back into a start-work
  column to continue"* row, and the delivery is skipped `limit_wakes`. A
  pickup past the trigger's `startsPerDay` (UTC day, counted under the
  trigger's start lock) is recorded `failed` with `limit_daily`, starts
  nothing, and is skipped `limit_starts`. **(from T4)** `ticketHours`,
  `ticketUsd` and `dailyUsd` fail the record the same way, and its sessions
  get close requests.
- **(from T4) The policy ends in the same transaction as each fence**, reusing
  the `endExecutorConversationLeasesInTransaction` call sites. The target
  channel being archived, made non-public or leaving the project is one of
  them (`target_channel_unavailable`): the audience the author agreed to no
  longer reads the work. UOA has no removal feed, so the binder and
  `ticket-work.sweep` re-check the author with UOA and end the policy when
  UOA no longer lists them.

## The vocabularies live in two places that change together (T0)

- `packages/schemas/src/ticket-work.ts` holds every closed list:
  `TicketWorkStatusSchema` with `TICKET_WORK_LIVE_STATUSES`,
  `TICKET_WORK_TERMINAL_STATUSES` and `TICKET_WORK_MACHINE_HOLDING_STATUSES`,
  `TicketWorkStateReasonSchema`, `TicketWorkWakeReasonSchema`,
  `TicketWorkPullRequestStateSchema` (`OPEN`, `CLOSED`, `MERGED`, as
  `gh pr view` spells them), `ExecutorStandingPolicyStatusSchema` and its
  suspended and ended reasons, and `AgentReminderStatusSchema` with
  `AgentReminderCancelledReasonSchema`.
- Each list is also a CHECK in the migration, and the status lists are also
  the partial indexes' `WHERE`s. Two tests fail when any of them disagree:
  `api/test/ticket-work-contracts-migration.test.ts` reads every migration in
  the order `migrate deploy` applies them and compares each constraint's
  **latest** definition (a later drop without a re-add fails it), and
  `api/test/ticket-work-contracts-postgres.test.ts` reads `pg_constraint` and
  `pg_indexes` from the migrated database. Adding or renaming a value is one
  change with two edits: the Zod list, and a **new** migration that drops and
  re-adds that CHECK (and the index, for a status). An applied migration is
  never edited.
- Wake reasons are configuration vocabulary the trigger's instructions are
  sectioned by (`onPickup`, `onSessionTurnEnded`, …). No code decides what the
  agent does from one.
- The queue topics and their payload schemas are in
  `packages/schemas/src/jobs.ts`: `TRIGGER_TICKET_DISPATCH_TOPIC` (T1,
  subscribed in `worker/src/worker-subscriptions-integrations.ts`),
  `TICKET_WORK_THREAD_MESSAGE_TOPIC` (T1, a person's message in a work
  thread, subscribed beside it),
  `TRIGGER_DOCUMENT_DISPATCH_TOPIC` (from T2), `TICKET_WORK_SWEEP_TOPIC` (from
  T3, with an optional idempotency `bucket`) and `TICKET_WORK_SESSION_TOPIC`
  (from T5, whose `status` is only one that wakes: `waiting_for_input`,
  `interrupted`, `failed` or `closed`). The sweep is also **the pool
  dispatcher**: every transaction that may free a machine — a record ending,
  parking or moving to `waiting_machine`, a session closing, a machine coming
  online, access being re-confirmed — enqueues it with a short idempotency
  window, and the periodic tick is only the backstop (from T5). So dispatch is
  one idempotent job that reads the queue and the pools afresh, and there is
  no per-executor dispatch topic. Only `trigger.ticket.dispatch` and
  `ticket-work.thread-message` have a subscriber so far; each other handler
  parses its payload with its schema when it lands.
- The dispatch vocabularies are in `packages/schemas/src/ticket-triggers.ts`:
  the stored `ticket_changed` config the dispatcher reads
  (`TicketChangedStoredConfigSchema`, the board and pickup columns by id),
  `TICKET_TRIGGER_EVENT_TYPES`, the follow kinds, and the delivery source,
  outcome and skip reasons. None is a database CHECK, so none is pinned to
  the migration.

## Tests that hold these rules

- `api/test/ticket-work-contracts-migration.test.ts` and
  `api/test/ticket-work-contracts-postgres.test.ts`: the vocabularies against
  the latest SQL and against the migrated database, and every CHECK and
  partial index against real rows.
- The upgrade path is CI's Upgrade Path job: the baseline fixture, then
  `migrate deploy` from HEAD, then `api/scripts/upgrade-smoke.mjs`. The repo
  has no down migrations; this one is purely additive, and a failed apply
  rolls back as one transaction
  ([docs/deployment/upgrade-paths.md](../deployment/upgrade-paths.md)).
- `packages/db/test/thread-serialization-ticket-work.test.ts`: a wake drains
  alone, as the agent.
- `worker/test/pa-tools-ticket-activity.test.ts`: a `ticket.work` run is lent
  only its agent-capable ticket tools, only through its own arm, and withholds
  and refuses the tools that act for a person. `worker/src/run/run-budget.test.ts`:
  the ceiling it is clamped to.
- `packages/schemas/src/__tests__/task-events.test.ts`,
  `packages/schemas/src/__tests__/ticket-work-jobs.test.ts` and
  `packages/schemas/src/__tests__/ticket-triggers.test.ts`: the origin,
  payload, stored-config and delivery shapes.
- `api/test/task-event-origin-routes.test.ts`: the origin each door stamps —
  the global hook's session, a minted agent credential as a token, the task
  routes behind the real hook, the MCP tools.
- `packages/team-admin/test/task-event-origin-db.test.ts`: `created`,
  `column_entered` (a same-category move and a transition included) and
  `priority_changed` with their origins, an unattended agent credited as
  `agent:<id>`, a board source's own events, and the dispatch job written in
  the event's transaction only when a ticket trigger could see it.
- `worker/test/ticket-trigger-decision.test.ts`: every branch of
  `decideTicketTrigger`. `worker/test/db/ticket-trigger-dispatch.test.ts`:
  the dispatcher against Postgres — a board editor's move starts work once;
  an agent's `ticket_move`, a token's move, an agent's `ticket_create`, a
  token's create and a board-source create into the column each start
  nothing and write a skip; a token or agent move back leaves a parked
  record parked; a source event wakes live work only when opted in; a
  non-editor's comment wakes nothing; the end wake and the own-move guard;
  and a failed start retried by the poller onto the same row.
- `worker/test/db/ticket-work.test.ts`: the seam against Postgres — a pickup's
  record, thread, `assignOnPickup`, activity row, wake row, three-block
  kickoff and a run as the agent; wakes folding into one pending kickoff while
  a person's pended message is never consumed by a `ticket.work` run; the
  wake and start limits; teardown in the move, the agent's own move to Done
  included; parking and a person's resume on the same record; the thread
  reused when the ticket comes back; `assignOnPickup`'s three cases; and a
  disabled or deleted trigger ending its work.
  `worker/test/db/ticket-work-thread.test.ts`: a thread message as a
  `thread_message` wake, a non-editor's refused again at dispatch, a message
  that wakes nobody skipped with its reason, and the content rules.
  `worker/test/db/ticket-work-races.test.ts`: each job dispatched after the
  moves that race it — a ticket moved in and back out starts nothing, a
  parked one moved back and out stays parked, a second end column
  re-announces nothing — plus parking and resuming on the history, an
  archived ticket's work ended, a health failure ending its trigger's work,
  `assignOnPickup` on a transition and a create, a pended kickoff rendered
  again as its run starts with the writes withheld, and a description
  replaced after its edit framed untrusted. `worker/test/db/ticket-work-authority.test.ts`: the ticket
  tools acting as the agent through its binding, the refusals, and the run's
  conversation. `worker/test/db/ticket-work-run.test.ts`: one pickup's run
  through the real run executor against the mock provider, its comment the
  agent's. `worker/test/db/ticket-work-writers.test.ts`: `send_message` into a
  work thread refused for a non-editor and a steer for an editor.
  `api/test/ticket-work-thread-routes.test.ts`: the posting rule, the stamp
  and the wake job in place of orchestration, an edit refused once its author
  lost the right, a card in a work thread refused, and the feed's event rows.
- `packages/team-admin/test/trigger-type-availability.test.ts`,
  `api/test/trigger-type-unreleased-routes.test.ts`,
  `worker/test/trigger-type-unreleased-tools.test.ts` and
  `admin/test/trigger-type-unreleased.test.tsx`: the unreleased type is
  refused on every agent surface, both types on every workflow surface, and
  the released types are the typed config union's.
- `packages/schemas/src/__tests__/trigger-configs.test.ts`: the union's
  types, the `ticket_changed` arm's defaults and refusals, a description on
  every field, and the generated prose.
- `packages/team-admin/test/trigger-ticket-config-db.test.ts`: resolution by
  name and by category with the board left out, each field-level refusal,
  the public-channel requirement, one enabled pickup per column on create,
  enable and edit, an edit that names one key, and authorship recorded and
  never returned. `api/test/trigger-config-refusal-routes.test.ts`: both
  routes answer `TRIGGER_CONFIG_REFUSED` with the field and the details.
- `worker/test/db/designer-ticket-trigger.test.ts`: `project_structure_read`
  lists only what the person asking can see, and the Designer's
  `agent_trigger_create` / `agent_trigger_update` resolve from names, refuse
  field by field and say back what they resolved.
- `api/test/ticket-work-view-routes.test.ts`: the three reads against
  Postgres — the chip's record, wake limit and thread only for its readers,
  a skip said until work starts after it, a refused re-entry said and an
  ordinary follow skip not, the work history, the board's badges from
  enabled triggers only and its dots, the owner gate, and the thread's
  posting rule and message outcome.
  `api/test/agent-conversations-postgres.test.ts`: a work thread's
  conversation names its ticket. `api/test/board-agent-watchers-migration-postgres.test.ts`:
  the watcher migration on seeded rows. `packages/team-admin/test/board-watchers.test.ts`
  and `board-watch-notify.test.ts`: an agent recipient refused, a legacy agent
  row never a recipient.
- `admin/test/ticket-trigger-form.test.ts` and
  `admin/test/trigger-type-unreleased.test.tsx`: what the editor posts is the
  typed config the server parses, a refusal lands on its field, only a public
  project channel is offered, Ticket change for an agent only.
- `pnpm --filter @nessie/admin test:e2e:agent-triggers`: the real Triggers
  editor offers the released types, Ticket change for an agent and never
  `document_changed`; a ticket trigger's form, a pickup refused on its field
  and the typed create; the column badge, card dots and the column menu that
  opens the editor prefilled; and a ticket trigger's page — at 1280 and
  390 px. `test:e2e:task-dialog` shots the chip in each state and the card's
  dot; `test:e2e:agent-conversations` walks the Tickets fold, the wake rows
  and the read-only composer.
