# Triggers: ticket and document events

Two new native `AgentTrigger` types. A board watcher for agents was only ever
"wake an agent when a ticket moves", so this trigger replaces it. Nothing
here runs on a machine. Machine access is a separate, confirmed policy
([machine-access.md](machine-access.md)).

## Ticket events and their provenance

The trigger fires from `TaskEvent` rows. The existing vocabulary stays
(`created`, `status_changed`, `detail_edited`, `labels_changed`, `assigned`,
`comment_added`, `attachment_added`, and so on). T1 adds only two:

- `column_entered { fromColumnId, toColumnId }`: written on **every**
  column change, including a move between two columns of the same category.
  Today a same-category move writes nothing (`project-task-move.ts`).
- `priority_changed { from, to }`: today a priority change writes nothing
  (`project-task-update.ts`).

Every writer goes through `taskEventBy` (`packages/team-admin/src/task-access.ts`).
The ticket tools in `worker/src/run/pa-tools/tickets.ts` pass `agentId` and
`unattended` into `moveProjectTaskToColumn`, `transitionProjectTask`,
`updateProjectTask` and `assignProjectTask`. An agent's move is then recorded
as `agent:<id>` rather than as the member it acted for. Each event's payload
also gains an **origin**, stamped by the layer that authenticated the call.
Origin is an allowlist, the same approach as `PERSON_MESSAGE_AUTHORSHIP` in
the lease rule:

| Origin | Set by |
|---|---|
| `session` | A route authenticated by a person's browser or app session cookie, and nothing else |
| `token:<keyId>` | API keys and the MCP surface (`api/src/routes/tasks.ts` accepts both today) |
| `agent:<agentId>` plus `runId` | Worker ticket tools |
| `source:<boardSourceId>` | Inbound board-source sync (`board-source-apply.ts`) |
| `system` | Anything else, including migrations and platform teardown |

Events are enqueued for dispatch in the same transaction that writes them,
the way `project-task-attention.ts` already enqueues. The topic is
`trigger.ticket.dispatch`, with its payload schema in
`packages/schemas/src/jobs.ts` (T0).

### Who starts work

This is **the origin rule**. Every pickup, re-entry and follow in
[Dispatch](#dispatch) applies it.

A **pickup** fires only for a `column_entered` event whose origin is `session`
and whose author can edit the board when the event is written. A `created`
event in a start-work column counts under the same rule: origin `session`,
and a creator who is a live board editor. Agent, token, source and system
moves and creates never start work. The ticket shows *"Moved by an agent, so
work did not start. A person who can edit the board can start it."* Tests pin
five cases, each starting nothing:

- an agent's `ticket_move` into the column;
- an API-token move;
- an agent's `ticket_create` straight into the column;
- an API-token create into the column;
- a board-source create into the column.

A **follow** wake follows the same rule. It fires only for events authored by
a person (origin `session`) who can edit the board. The people who can steer
work are exactly the people who can start it. An event from an agent, a
token or an external provider never wakes the work.

A board-source event is the one opt-in exception: `follow.includeSourceEvents`
(default `false`) lets a source event of a followed kind wake a live record.
It can never pick up or resume work, and its text reaches the agent labelled
as untrusted. The option is part of the pinned trigger digest
([machine-access.md](machine-access.md#what-is-pinned)). T1 tests both the
default and the opted-in case.

Whatever its origin, the agent still sees an event when it reads the ticket,
labelled as untrusted where it has to be (see
[ticket-work.md](ticket-work.md#what-every-wake-says)).

## `ticket_changed`

### Configuration

The config is a discriminated union per trigger type in `@nessie/schemas`,
with `.describe()` on every field. The tool's `type` enum and config prose
are **derived** from that union, as `global-agent-catalogue.ts` requires, and
not hand-written in `builtin-agent-tools.ts`. The shape:

```ts
{
  type: 'ticket_changed',
  targetChannelId,                 // a live, ordinary, public channel of the board's project, with the agent bound
  boardId?,                        // optional when the project has one board
  pickup?: {
    columns: Array<{ id } | { name } | { category: 'in_progress' | 'review' }>,
    assignOnPickup: boolean,       // default true
  },
  follow: {
    kinds: Array<'comment' | 'description' | 'moved' | 'thread_message' | 'document'
               | 'priority' | 'labels' | 'assignee'>,
    // default: comment, description, moved, thread_message, document
    includeSourceEvents: boolean,  // default false; see "Who starts work"
  },
  endOn: Array<{ category: 'todo' | 'done' } | { id }>,   // default: every todo- and done-category column
  quietWakeMinutes: number | null, // default 30; see ticket-work.md
  waitingMachineHours: number,     // default 24; see ticket-work.md
  limits: { wakesPerTicket, ticketHours, ticketUsd, startsPerDay, dailyUsd },
  instructions: {
    general: string,
    onPickup?: string, onSessionTurnEnded?: string, onTicketChanged?: string,
    onReminder?: string, onQueued?: string,
  },
}
```

- **Server-side resolution.** `projectId` is derived from `targetChannelId`,
  and a `boardId` from another project is refused. A column may be named by
  id, by name or by category. The resolved board and columns are echoed back
  as links, and stored by id.
- **Field-level refusals.** `createAgentTrigger` returns the failing path and
  reason, for example `pickup.columns[0]: no column "In Progres" on board
  Engineering (columns: Backlog, In progress, Review, Done)`. The generic
  "Trigger configuration is invalid. Check the schedule…" answer stays only
  for types that have not moved to the union yet.
- **Target channel.** It must be readable by the whole project audience, so
  that every ticket reader can open the work thread. The editor and the tool
  refusal both say why.
- **One pickup trigger per column.** At most one enabled `ticket_changed`
  trigger may pick up from a given column, so that two agents never start on
  the same ticket. Creating, enabling or editing a second one is refused with
  the other trigger named.
- **`assignOnPickup`** is applied in the **move transaction**, not later in
  dispatch. When an unassigned ticket enters a pickup column of an enabled
  trigger with `assignOnPickup`, and the move itself qualifies as a pickup
  (origin `session`, a board editor), the trigger's agent is assigned
  *instead of* the mover. That replaces the existing assign-the-mover rule in
  `project-task-move.ts` for that move only. A ticket that already has an
  assignee, person or agent, is never reassigned. The `assigned` event has
  origin `system` and wakes nothing. T1 tests the unassigned case, the
  already-assigned case and a non-qualifying move, which keeps today's
  behaviour.
- **Authorship.** The trigger records `createdByUserId` for every type, as it
  already does for schedules. That is authorship only, and it grants no
  authority (see [ticket-work.md](ticket-work.md#authority-of-a-ticketwork-run)).
- **Indexed scope.** New types carry `scope_project_id` and `scope_board_id`
  columns, so the dispatcher looks triggers up by board. Today
  `dispatchEventTriggers` loads every event trigger in the organisation and
  matches JSON in memory.
- **Instructions** are written by whoever configures the trigger. In practice
  the Designer drafts them from what the person asked for. The editor shows
  only a neutral example. The platform shows `general`, then the section that
  matches the wake reason, first in the kickoff.

### Dispatch

`trigger.ticket.dispatch` handles one TaskEvent. It loads the triggers for
that board and decides, per trigger:

- **Pickup**: the event enters a pickup column from outside the pickup set,
  the origin rule holds, and the trigger has no live or parked work record for
  the ticket. The result is a new work record.
- **Re-entry**: the event enters a pickup column, a work record is live or
  parked, and the origin rule holds. The result is a follow wake with reason
  `ticket_moved` on the same record and thread, never a second pickup. A
  re-entry that fails the origin rule leaves the record as it is and writes a
  skip with its reason. T1 tests that a token or agent move back into a
  pickup column does not wake a parked record.
- **Follow**: the event kind is in `follow.kinds`, a work record is live, and
  the origin rule holds. The result is a follow wake.
- **End**: the event enters an `endOn` column. Teardown is platform-owned and
  runs inside the move transaction, not here
  ([ticket-work.md](ticket-work.md#teardown-is-the-platforms)). The dispatcher
  only sends the agent a machine-less `ticket_moved` wake so it can comment.

Each outcome, including every skip or refusal that has a reason, writes an
`AgentTriggerDelivery` row. It reuses `upsertDelivery`, with dedupe key
`ticket:<triggerId>:<taskEventId>` on the existing
`@@unique([triggerId, dedupeKey])`, plus `recordTriggerRunFailure` and the
health fields. The row carries `source: pickup | follow | session | reminder |
dequeue | quiet`, the `workId`, and a reason from a closed vocabulary. A skip
the person should know about also appears on the ticket (see
[ticket-work.md](ticket-work.md#what-the-project-sees)). Nothing is dropped
with a bare `continue`, which is what `trigger-events.ts` does today.

Runs start through a new `queueTicketWorkRun`, not `queueTriggerRun`. It
takes the work record's thread, sets purpose `ticket.work`, and admits the run
under [the ticket-work authority](ticket-work.md#authority-of-a-ticketwork-run).

### Fixes to the existing trigger path (T1)

- `dispatchEventTriggers` drops `config` (prompt and launch origin). Pass it.
- `buildTriggerPrompt` drops the payload when `config.prompt` is set. Fix
  this **only** for `ticket_changed` and `document_changed`, whose payloads
  are metadata. Existing webhook triggers must not start feeding untrusted
  external payloads into the model, and a test pins that their prompts are
  unchanged.
- The Triggers editor gains an instructions field and the new types'
  pickers.

## `document_changed`

For "editing a tech document of the project wakes the agent" (T2).

- **Config** (in the same union): `targetChannelId` (public, same project),
  `spaceId?`, `folderPageId?`, `pageIds?`, `labels?`, `kinds: ['document',
  'file']`, `fireOn: 'save' | 'publish'` (default `save`, because the product
  has no live collaborative text editing, so a save is a deliberate version),
  `quietSeconds` (default 180), `includeAgentEdits` (default false) and
  `instructions`. The trigger's creator **and** its agent must be able to
  read the space at creation. The space's visibility must not be narrower
  than the target channel's audience.
- **Hook.** A clean `onVersionCreated(tx, {pageId, versionId, versionNumber,
  authorType, authorId, origin})` is called from `createPage`, `updatePage`,
  `addFileVersion` and `restoreVersion`. It is extracted into
  `packages/knowledge/src/version-events.ts` first, because
  `native-version-writer.ts` is at 498 of 500 lines. Copy (`transfer/copy.ts`)
  and migration origins are skipped. Spreadsheets are excluded.
- **Coalescing** uses the existing queue: `enqueueQueueJob` with
  `delayMs = quietSeconds` and idempotency `doc:<triggerId>:<pageId>:pending`.
  When the job fires it reads the page's latest version. The delivery dedupe
  is `doc:<triggerId>:<pageId>:<toVersionId>`, and `fromVersionId` is the last
  delivered `toVersionId`. The agent's own versions advance the marker and
  never fire.
- **Payload** is metadata only: page, space, `taskId?`, kind, from and to
  version ids and numbers, how many versions were coalesced, author kinds and
  body size. The kickoff names the page by title only when every reader of the
  target channel can read the page; otherwise it names it by id.
- **Where it lands**, in this order:
  1. The page's ticket (its `taskId`, or a live work record that links the
     page) has a live work record **for this trigger's agent**. The change goes
     to that record's work thread as a follow wake with reason
     `document_changed`. That is how a spec edit reaches the coding agent
     mid-work. Only that agent's record is woken, even when several
     `ticket_changed` triggers cover the board.
  2. Otherwise the change goes to one thread per page, created and titled like
     a ticket thread, never the channel's General thread. A ticket that was
     never picked up, or whose work ended, lands here, and the kickoff names
     the ticket.

  T2 tests both cases, plus a board with two ticket triggers.
- **`kb_page_diff(pageId, fromVersionId, toVersionId)`**: a new tool in
  `worker/src/run/pa-tools/knowledge-diff.ts`, with `kb_page_read`'s gates. It
  records both versions in the consumed-source sink and returns hunks of at
  most 12k characters. It needs `admin/src/lib/line-diff.ts` moved to a
  shared package (`packages/schemas`), and the admin keeps importing it from
  there.
- **Access lost** at fire time pauses the trigger with a health reason; it
  does not skip silently.

## Board watchers

Agent watchers were a second way to configure the same wake. They had
different authority, and their wakes landed in the adder's DM with no tools.
In T1:

- `BoardWatchersEditor` and its API stop offering agent recipients. People
  watchers keep their alerts.
- Existing agent watcher rows become **disabled** `ticket_changed` triggers
  with follow-only config, and nobody is notified. A person reviews and
  enables them from the Triggers page, and the migration names each one in
  its summary.
- Inbound board-source changes emit TaskEvents with origin `source:<id>`.
  They can wake a follow only if the trigger opts in with
  `follow.includeSourceEvents`, and they never pick up work. The
  `ticket_changed` editor and the tool result say so for mirrored boards.
- `docs/plans/2026-09-06-board-watchers.md` and the watcher editor's copy are
  updated in the same PR.
