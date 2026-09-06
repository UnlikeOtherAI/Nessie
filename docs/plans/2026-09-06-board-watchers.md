# Board watchers: telling somebody a ticket moved

**Date:** 2026-09-06 · **Status:** built (§10 records the as-built deltas)
**Owning surface:** Project → **Settings → Boards → <board> → Watchers**
(`/projects/:projectId/settings?section=boards&board=<id>`)
**Doorways:** the board header's Configure menu; the `SourceStatusStrip`'s
read-only pill; a watcher's own card in chat links back to the board.
**Builds on:** [2026-09-05 project boards](2026-09-05-project-boards-external-sources-and-custom-fields/overview.md)
and [2026-09-05 API-key connectors](2026-09-05-api-key-board-source-connectors/overview.md).

The owner asked for three things: a switch that makes a mirrored board
read-only; a picker on any board that names agents or people to tell when a
ticket changes; and for those people to see the ticket in chat as the card they
already know from the board — with the picker looking like the New-message
address bar, so there is one way to choose recipients in this product.

## 0. The one-paragraph version

A board gains **watchers**: rows of `(boardId → agent | user)` chosen in the
same address bar the New-message screen uses, extracted from
`ChannelConversationComposePage` into one `RecipientBar` rather than drawn
twice. `applyInboundItem` already classifies every inbound item as `created`,
`updated`, `echo` or `unchanged` — the echo arm is our own write coming back —
so the notify point is the `updated`/`created` arm and nothing else, which is
why a write-back never notifies anybody about itself. A change fans out through
the machinery that already exists for this: an **agent** watcher is woken the
way an event trigger wakes one (`queueTriggerRun`), and a **person** watcher
gets a durable `UserAlert` plus a message in their Personal Assistant DM
carrying an **AgentCard** whose body is the closed block vocabulary — with one
new block, `task`, that renders the extracted `KanbanCardContent`, so the card
in chat *is* the card on the board rather than a second drawing of it. The
read-only switch the owner asked for **already exists** as
`BoardSource.writeMode`; what is missing is that it is per source, invisible
from the board, and named for the source rather than the board.

## 1. What is true today

Established by reading code, not assumed.

**T1 — read-only already exists, one level down and out of sight.**
`BoardSource.writeMode` (`read_only | read_write`, default `read_only`,
`api/prisma/schema.prisma` 1711) is edited by a `TabBar` radiogroup in
`admin/src/pages/project/settings/SourceMappingPanel.tsx` 275–301, with the copy
*"Read only: Jira decides. Moving a card here that would change its stage is
refused."* It is a property of a **source**, reachable only at
`?section=sources&source=<id>`. A board that mixes a Linear source with native
tasks has no single answer to "is this board read-only", and nothing on the
board says which it is beyond the source pills in `SourceStatusStrip`.

**T2 — the apply path already separates a real change from our own echo.**
`applyInboundItem` (`packages/team-admin/src/board-source-apply.ts` 142)
returns `ApplyOutcome` = `created | updated | echo | unchanged | unmapped_state`
(30–34). The `echo` arm is matched on `outboundFingerprint`, so a write we made
that comes back is already distinguishable from a change somebody made
upstream. Two callers: `worker/src/control/board-source-sync.ts` 146 and
`board-source-webhook.ts` 103.

**T3 — the address bar exists, as a model plus 200 lines of inline UI.**
`admin/src/lib/channel-compose-recipients.ts` is already a shared, tested model:
`Recipient`, `RecipientOption`, `recipientKey`, `matchesRecipientQuery`,
`buildRecipientOptions`, `selectAddressableAgents`. The **chips + input +
autocomplete listbox** that render it live inline in
`ChannelConversationComposePage.tsx` (492 lines, near the 500-line cap) and are
not exported. A second picker built beside it is precisely the fork Rule zero §4
names.

**T4 — the board card has a drag-free inner component already.**
`admin/src/components/kanban/KanbanCard.tsx` splits `KanbanCard` (the
`useSortable` wrapper) from `KanbanCardContent`, which takes
`{ task, showProject, projectName, archived }` and no drag context. It draws the
external-key pill, priority signal, excerpt, field chips and assignees.

**T5 — agent chat cards are one system with a deliberately closed vocabulary.**
`docs/standards/agent-cards.md`: the body is `text | fields | image | link |
input | secret` plus ≤4 actions, and the standard says in as many words that
"a ticket, an email overview and a form share one renderer — a `kind` per
integration is the eighth look-alike Rule zero names". Any ticket card in chat
must answer to this, not route around it.

**T6 — waking an agent on an event is built.**
`AgentTrigger` with `type: 'event'` (`schema.prisma` 3207) and
`dispatchEventTriggers` (`worker/src/control/trigger-events.ts` 31) already
select enabled event triggers for an organisation and run them;
`queueTriggerRun` (`trigger-run.ts` 156) is the enqueue.
`AgentTriggerDelivery` (3265) records the fan-out, and
`trigger-delivery-retry.ts` and `trigger-health.ts` already own the failure story.

**T7 — telling a person is built, in two halves that belong together.**
`UserAlertKind` (`schema.prisma` 2062) is the durable bell, and its comments
state the rule this design inherits: *"a push is missable, the bell is not"*.
`worker/src/control/attention-dispatch.ts` fans a payload to push and writes the
`UserAlert`, honouring per-person push preferences.

**T8 — a board is a view, and watchers must not contradict that.**
From the parent design: `Board` owns name, style, columns and a closed filter;
`Task.status` is the lifecycle truth. A board does not own its tasks, so a
watcher on a board is a statement about *a view of a pool*, not about the tasks.
Two boards over the same source both watching means two notifications about one
change unless the fan-out de-duplicates per recipient.

**T9 — a first sync is a `created` for every row.**
`board-source-apply.ts` 277 returns `{ applied: existing ? 'updated' : 'created' }`,
and on a first sync no `TaskExternalLink` exists, so every item is a create.
Connecting the Linear team this was tested against produced **543** of them in
one run. Any per-item notification on the `created` arm is therefore a flood on
the day a source is connected, and again whenever a sweep reconciles a backlog.

## 2. Decisions at a glance

| Question | Decision | Rejected | Why |
|---|---|---|---|
| What to call it | **Watchers.** The board setting is *Watchers*; the row reads *"Tell Ana and @Triage when a ticket changes"* | "Delegation of change"; "Subscribers"; "Routing" | Every tracker the audience already uses calls this a watcher, so it needs no explaining. "Delegation" promises the watcher can *act on your behalf*, which is not what this does; "routing" names the mechanism rather than the decision. |
| Where the switch for read-only lives | Keep `BoardSource.writeMode` as the truth; **surface it on the board** as a read-only pill in `SourceStatusStrip` that links to the control | A second `Board.readOnly` column | Two switches for one question is the defect. A board is a view (T8); the authority over whether Linear accepts a write belongs to the source, not to one of several views over it. |
| What a watcher is attached to | The **board** | The project; the source | The owner asked per board, and a board is where a person already reasons about a slice of work. A project-wide watcher cannot say "only the release board". |
| What counts as a change | `ApplyOutcome.created` and `updated` only, plus a **local** move on a native task | Every apply; field-level diffing in v1 | `echo` is our own write and `unchanged` is a no-op (T2); notifying on either is how this feature becomes noise on day one. |
| A sweep vs a webhook | **A webhook notifies per item; a sync sweep coalesces into one summary per (board, run).** An initial sync notifies nobody. | Per-item from both callers | T9: a first sync is `created` for every row — 543 of them on the board this was tested against. Per-item from a sweep is a mailbox flood on day one and again after any outage backlog. The two callers are already separate files, so the distinction costs an argument. |
| Notifying somebody who may not read the task | **Filtered before anything is written**, in the fan-out, against the same entitlement the task read uses | Refuse at render time | The alert row, the DM message and the **push** are all written before a renderer runs, and push lands on a lock screen. `docs/standards/disclosure-boundaries.md` puts the check at the read for exactly this reason. Render-time refusal stays, as defence in depth, never as the mechanism. |
| Idempotency of a notification | Claimed on `(taskId, inboundFingerprint)` | Per fan-out call only | A sweep page and a webhook can both miss the fingerprint, both apply, and both return `updated`; the notify happens after the apply commits, so nothing else claims it. The fingerprint is already computed. |
| A watcher who leaves, or an agent that is deleted | Rows cascade with the board; fan-out **skips** a recipient who is no longer entitled, and says so in the delivery record | Leave the row and keep writing | A watcher list that outlives its subjects writes alerts into the void, and combined with the entitlement filter it is the same check in the same place. |
| A watcher who wants out | A watcher may **remove themselves** without being a project administrator | Administrator-only | Adding somebody costs their attention, which is why adding is gated; making them find an administrator to stop is not a defensible asymmetry. |
| Waking an agent on every change | One wake per `(agent, board)` per **coalescing window**, carrying the tasks that changed | One `queueTriggerRun` per change | An agent woken per item on a busy mirrored board is hundreds of runs a day against the run-budget standard. The window makes it a digest the agent can act on once. |
| How an agent watcher is told | `queueTriggerRun` through a synthetic **event trigger payload**, reusing `AgentTriggerDelivery`, its retry and its health | A new agent-wake path | T6 exists, and forking it would fork the delivery record, the retry ladder and the health story with it. |
| How a person watcher is told | A durable `UserAlert` (new kind `board_ticket_changed`) **and** a card in their Personal Assistant DM | Push only; a message in the project channel | The bell rule in T7 is explicit. The project channel would tell everybody about a change three people asked to hear about. |
| How the ticket renders in chat | **One new card block, `task`**, carrying a `taskId`; the renderer mounts the extracted `KanbanCardContent` | A bespoke ticket-card component; `fields` blocks approximating a card | The owner wants the card they know, and T4 makes that a component move rather than a redraw. Adding one block that works for **every** provider and for native tasks is the opposite of the per-integration `kind` T5 forbids — but it *is* an amendment to a closed vocabulary, so `docs/standards/agent-cards.md` changes in the same turn (§6). |
| Whether the card is interactive | v1 renders and links out; **no actions** | Approve/move buttons on the card | The card system already supports actions, so this is a later addition rather than a shape change — and on a `read_only` source every action would be refused anyway. |
| Recipient picker | Extract the chips/input/listbox from `ChannelConversationComposePage` into `admin/src/components/shared/RecipientBar.tsx`; both screens use it | A second picker for boards | T3, and Rule zero §4. The compose page also drops back under the line cap. |
| De-duplication | One notification per `(recipient, taskId, change)` per fan-out, keyed before delivery | Per board | T8: two boards watching one source must not tell Ana twice about one move. |
| Who may edit watchers | `canAdministerProject` — the predicate boards, columns, fields and sources already use | Org owner; anyone who can see the board | Watching is board administration, and a watcher costs somebody else's attention. |
| Watching an agent you cannot address | Refused, reusing `selectAddressableAgents` | Offer every agent | The picker must offer only what the server will accept, which is the rule that model already encodes. |

## 3. The model

```prisma
/// Who to tell when a ticket on this board changes. A board is a view, so a
/// watcher is a statement about a slice of the pool — never about the tasks.
model BoardWatcher {
  id             String   @id @default(uuid()) @db.Uuid
  boardId        String   @map("board_id") @db.Uuid
  organizationId String   @map("organization_id") @db.Uuid
  /// Exactly one of these two is set, enforced by a CHECK.
  userId         String?  @map("user_id") @db.Uuid
  agentId        String?  @map("agent_id") @db.Uuid
  addedByUserId  String   @map("added_by_user_id") @db.Uuid
  createdAt      DateTime @default(now()) @map("created_at")

  board Board @relation(fields: [boardId], references: [id], onDelete: Cascade)

  @@unique([boardId, userId])
  @@unique([boardId, agentId])
  @@index([organizationId])
  @@map("board_watchers")
}
```

`UserAlertKind` gains `board_ticket_changed`. Nothing is added to `Board`
itself: a board with no watcher rows has no watchers, which is the state
every board is in today.

## 4. What fires, and what it carries

`applyInboundItem` stays a pure apply and gains no notification duty — it
already returns the outcome the caller needs. The two worker callers (T2) hand
`{ outcome, taskId, sourceId, fingerprint, delivery: 'webhook' | 'sweep' }` to
one new `packages/team-admin/src/board-watch-notify.ts`, which:

1. **claims** the notification on `(taskId, inboundFingerprint)` and stops if it
   is already claimed — a sweep page and a webhook can both apply the same
   change, and the claim is what makes two applies one telling;
2. resolves the boards the task is visible on (a task hidden by a board's
   filter notifies nobody on that board);
3. loads their watchers, collapses to a unique recipient set, and **drops every
   recipient not entitled to read the task** — before any row is written, per
   the decision table and `docs/standards/disclosure-boundaries.md`;
4. for agents, joins the open coalescing window for `(agent, board)` or opens
   one, and on close enqueues a single `queueTriggerRun` naming the tasks;
5. for people, writes one `UserAlert` and posts one PA-DM message carrying an
   `AgentCard` whose body is `[{ kind: 'task', taskId }, { kind: 'link', … }]`.

**A sweep does not notify per item.** `board-source-sync.ts` accumulates its
outcomes and, at the end of the run, produces one summary per `(board, run)` —
*"12 tickets changed on Release board"* — with the same card for a single
change and a list for several. **An initial sync notifies nobody at all**: every
row is `created` because no link exists yet (T9), and nobody asked to be told
that a board they just connected has tickets on it.
`board-source-webhook.ts` keeps per-item delivery, which is the case the owner
actually described.

**What "changed" says.** The payload carries `status` and `assignee` only. The
fingerprint already knows about more, but no consumer branches on more, and
§8 defers field-level rules — a wider vocabulary now is speculative.

A native drag calls the same function from `moveProjectTaskToColumn`. It has no
fingerprint, so two rapid drags are two tellings; acceptable in v1 and named
here so it is a decision rather than a surprise.

## 5. Surfaces

**Watchers editor** — `?section=boards&board=<id>`, under the column editor:
a `RecipientBar` with the chips a person already knows from New message, and
one line of copy naming the consequence: *"They hear about every ticket that
moves or changes on this board."* Empty is the default and reads as such.

**The read-only pill** — `SourceStatusStrip` already renders one pill per
source; it gains the word `read-only` where `writeMode === 'read_only'`, linking
to the control in T1. That is the whole of the owner's "switch to make a remote
board read-only", plus the discoverability it was missing.

**The card in chat** — a PA-DM message rendering `KanbanCardContent` inside the
existing card shell, with a link back to `/projects/:id/board?board=<id>` and,
for a mirrored task, the `ExternalKeyPill` that already links to Linear.

## 6. The standard this amends

`docs/standards/agent-cards.md` says the block vocabulary is closed. This design
adds `task`, and the standard changes in the same turn to say so in **narrow**
terms: *"`task` renders the platform's own `Task` entity, mounting the component
the board draws. It sets no precedent for per-integration blocks."* The broader
phrasing — "it works for every provider" — is the sentence the next
`pull_request` or `calendar_event` proposal will quote back, so it is
deliberately not the justification. The exception is that a Task is Nessie's own
central entity, not somebody's integration. If that argument is not accepted, the fallback
is a `fields` block plus a `link`, which loses the visual parity the owner asked
for; it is a smaller change and worth naming as the alternative.

## 7. Delivery

**Phase 1 — `RecipientBar`.** Extract chips/input/listbox out of
`ChannelConversationComposePage` into `components/shared/RecipientBar.tsx`;
compose page reuses it and drops under the line cap.
*Accept:* existing compose tests pass untouched; a new render test covers
filtering, keyboard selection and removal.

**Phase 2 — model and routes.** `BoardWatcher`, the migration, the
`board_ticket_changed` alert kind, and `GET/PUT /api/projects/:projectId/boards/:boardId/watchers`
gated by `canAdministerProject` — plus `DELETE …/watchers/me`, which a watcher
may call for themselves without that gate.
*Accept:* route tests for each cell of the authority table; a non-addressable
agent is refused; a watcher can remove themselves and cannot remove anybody
else.

**Phase 3 — fan-out.** `board-watch-notify.ts`, wired into both worker callers
and into `moveProjectTaskToColumn`; the `(taskId, inboundFingerprint)` claim;
the entitlement filter; the sweep summary and the agent coalescing window.
*Accept:* DB-backed tests that an `echo` notifies nobody; that an **initial
sync of 500 items writes zero notifications**; that a sweep with 12 changes
writes one summary per watcher, not 12; that a webhook writes one per item;
that two boards watching one source notify one recipient once; that a task
filtered off a board notifies that board's watchers not at all; and that a
recipient who cannot read the task **has no alert, no message and no push
written** — asserted on the rows, not on the rendered output.

**Phase 4 — the `task` block.** Schema, renderer mounting
`KanbanCardContent`, the standard updated.
*Accept:* a card with a `task` block renders the same markup the board does; a
`taskId` the viewer may not read renders a refusal. The refusal is defence in
depth — Phase 3 is what proves nothing was written in the first place.

**Phase 5 — surfaces.** The watchers editor, the read-only pill, the alert row
and its deep link.
*Accept:* Playwright against `localhost:5455`.

## 8. Not in v1

Field-level watch rules ("only tell me about status"); per-watcher quiet hours;
watchers on a source or a project; actions on the ticket card; watching from the
card itself; notifying on comments (nothing mirrors Linear comments yet);
back-filling a notification for a change that happened before a watcher was
added.

## 9. Open questions for the owner

1. **Is the Personal Assistant DM the right home** for a person's card, or
   should a watcher name a channel?
2. **Should an agent watcher run, or only be told?** This plan wakes it, on the
   grounds that an agent that cannot act on the news is a mailing list.
3. **Native boards stay in v1.** The review argued for cutting them to save the
   `moveProjectTaskToColumn` wiring and a second dedup regime. Kept, because the
   owner's ask was explicitly *"any board needs to have a dropdown"* — narrowing
   a stated requirement is the owner's call, not the design's. Flagged here so
   it can be overruled cheaply.

## 10. As built

Three things the build settled differently. Read this before treating a section
above as a description of the code.

- **§6 amends no standard, because there is no card.** The design added a
  `task` block to the agent-card vocabulary. It did not need to: that system is
  for cards a person *presses*, and a watcher notification has no press. The
  ticket in chat is an ordinary message carrying
  `TaskPresentationMessageMetadataSchema` — a pointer, exactly as
  `DashboardPresentationMessageMetadataSchema` already does it — and
  `TaskPresentation` mounts the board's own `KanbanCardContent`. Same one
  drawing, closed vocabulary untouched. §6's fallback was the wrong second
  option; this was the right first one.
- **§2's de-duplication answers a case that cannot arise.** Two boards cannot
  both show one task: `boardTaskPoolWhere` gives the default board every task
  with a null `board_id` and a non-default board only its own, so a task is in
  exactly one board's pool. The recipient collapse is still correct and still
  earns its place for the *concurrency* case — a sweep page and a webhook
  applying one change — which is what `BoardWatchNotification` claims on.
- **The agent half is built, and not the way §2 said.** That decision was to
  wake an agent through `queueTriggerRun`. It cannot be: that function needs an
  `AgentTrigger` row to hang its delivery, retry and health off, so a watcher
  would have to mint one per agent — rows on the Triggers page nobody created
  and nobody can edit. What the trigger path and the wake actually share is the
  layer *underneath* it, and that is reused verbatim: a `system` kickoff
  message, `claimThreadRunOrPend`, and a new `startAgentRun` that both call.
  Extracting that trio is what makes this reuse rather than a second copy.
- **The destination and the identity are captured when the watcher is added,
  not worked out at wake time.** `BoardWatcher` carries `channelId`, `threadId`
  and a `launchOrigin` for agent rows. Both halves were review findings, and
  both were the same mistake — the worker reconstructing something only the
  adder's session knew. `agentDmKey` includes a team: the interactive route
  takes it from the session, so the worker choosing "the project's oldest team"
  opened a *second* DM for the same pair and woke the agent where nobody was
  reading. And a wake has no session, so with no captured `uoaIdentity` the
  Ledger signer has nothing to verify and the run dies at its first inference —
  unattended, posting nothing to say why. A trigger solves both with
  `launchOrigin`; a watcher now does the same.
- **The entitlement rule reaches the agent's reader.** An agent is woken in a DM
  a *person* opens, and the kickoff carries ticket titles, so the check the user
  branch applies had to reach whoever is on the other side of the agent —
  otherwise the agent branch is a way around it.
- **A wake needs a conversation, so the picker now refuses an agent without
  one.** `resolveAgentConversation` returns a private agent's own home DM and a
  shared agent's DM with the person who added the watcher; a system-managed
  agent and the personal assistant have neither, for the same reason
  `createAgentTrigger` refuses them. `setBoardWatchers` refuses such a watcher
  with `AGENT_HAS_NO_CONVERSATION` at the point somebody adds it, rather than
  accepting one that could never fire.
- **The kickoff is `system`, never `user`.** A `user` role would sign "a ticket
  moved" with the name of whoever added the watcher and fill their DM with
  plumbing — the defect the trigger path documents at length. The run still
  receives the content as its prompt.
- **A hidden kickoff can never own a reply, on either path.** The drain that
  batches a pended wake keyed its placement on `triggerId`, so a wake landing
  while the slot was busy would have replied under a `system` message nobody can
  see and dropped out of the feed. That rule was always about the kickoff being
  hidden rather than about triggers, and it now reads the role. Only the latest
  pended kickoff drives the follow-up's prompt, so the wake tells the agent to
  check the board rather than trusting the list it carries.
- **A busy board costs one run at a time per agent.** The wake takes the same
  per-(agent, thread) claim a chat reply does, so a ticket that moves mid-run is
  batched into the follow-up instead of racing it. That is the coalescing §2
  asked for, provided by machinery that already existed rather than a window of
  its own.
