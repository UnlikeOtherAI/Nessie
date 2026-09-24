# Ticket activity — comments, files, labels and the Markdown description

Authoritative standard. `AGENTS.md` → "Architecture" carries the one-line
summary and points here; **this file is the rule.** The design and its
rejected alternatives are in
[docs/plans/2026-09-21-ticket-comments-attachments-labels/overview.md](../plans/2026-09-21-ticket-comments-attachments-labels/overview.md);
where that plan and the code differ, the code and this file win.

Every write below is **one function in `@nessie/team-admin`**
(`task-access.ts`, `task-labels.ts`, `task-comments.ts`, `task-attachments.ts`,
`task-activity-realtime.ts`). The REST route, the MCP tool and the worker
builtin each build a `TaskActor` and call that function; none of them decides a
refusal. A route maps the typed result to a status
(`api/src/routes/task-activity-gate.ts` → `sendTaskActivityError`), a tool
turns it into words. A fourth surface that re-implements a check is the bug
this layout exists to prevent.

## Access: one predicate, asked everywhere

- **`findAccessibleTask` / `isTaskAccessibleToUser` (`task-access.ts`) is the
  only answer to "may this actor touch this ticket".** It is `getTask`'s
  visibility rule lifted into the shared package: the viewer's accessible
  projects (`listAccessibleProjectIds`, `'all'` for an organisation
  owner/admin), projectless work, and whatever the viewer owns or is assigned;
  a task whose project is soft-deleted is gone for admins too. A path id that
  is not a UUID names nothing (`isUuid`) rather than reaching a `uuid` cast.
  "No such task" and "not yours" are the same `NOT_FOUND`, so an id never
  confirms a ticket exists. The route gate additionally runs `getTask` itself
  so a run-derived ticket the viewer may not read is a 404 before the shared
  function is reached; the shared function asks again because MCP and the
  worker reach it without that gate.
- **`TaskActor.userId` is always a person** — the signed-in member, the person
  a Personal Assistant acts for, or the person who asked a shared agent. It is
  whose reach is checked and whose uploads may be linked. `agentId` is set only
  when an agent writes *as itself*; `taskEventBy` then records the person
  (`by`), or `agent:<id>` for a run with no person behind it (`unattended`).
  `origin` is the door the write came through (below); absent, it is
  `system`.

## History: who changed a ticket, and through which door

A ticket trigger decides from a `TaskEvent` alone whether a change may start
or steer an agent's work ([ticket work](ticket-work.md)), so the events it
reads say who made the change and how the call was authenticated.

- **Every event an actor writes carries `by` and `origin`**
  (`taskEventAuthorship`, `task-access.ts`). `origin` is the allowlist
  `TaskEventOriginSchema` (`@nessie/schemas`), stamped by the layer that
  authenticated the call, never by the caller:
  - `session`: the global auth hook verified a person's own session token and
    set `request.authenticatedWith`; `taskEventOriginFor`
    (`api/src/lib/task-event-origin.ts`) reads it for the task routes and the
    comment, attachment and label routes' `TaskActor`.
  - `token { keyId }`: an agent access credential (the MCP surface, which the
    endpoint hands its tools as `taskEventOrigin`) or a voice credential,
    naming that credential.
  - `agent { agentId, runId }`: the worker's ticket tools
    (`ticketEventAuthorFor`). A Personal Assistant's or a shared agent's write
    is an agent's even when a person asked for it; `by` still names that
    person, and names `agent:<id>` only when no person is behind the run. A
    `ticket.work` run has none: its tools write through an `AgentTaskActor`
    (`task-access.ts`, `userId: null`), whose reach is the agent's live
    binding to a channel of the project (`agentBoundProjectWhere`) rather than
    a member's entitlement, which links no uploads, and whose events and
    comments are the agent's ([ticket work](ticket-work.md)).
  - `source { boardSourceId }`: an inbound board-source change
    (`sourceEventAuthorship`, `board-source-apply-events.ts`), with
    `by: source:<id>`.
  - `system`: anything else, including a writer that named no origin.
- **`column_entered { fromColumnId, toColumnId }` is written on every column
  change** (`recordColumnEntered`), a move between two columns of the same
  category included, which changes no status and so writes no
  `status_changed`. A drag or `ticket_move` writes it; so do a status
  transition and an inbound source status change, on the ticket's home board.
  A reorder within one column writes nothing.
- **`priority_changed { from, to }`** is written when `updateProjectTask`
  changes the priority, and not when it is set to what it already was.
- **`created` names where the ticket landed** (`boardId`, `columnId`, its home
  board's placement when it was written), and a ticket a board source creates
  now writes one too, as the source's.
- **The event and its dispatch job are one transaction.** `recordTaskEvent`
  (`task-event-dispatch.ts`) writes the event and, for the types a ticket
  trigger acts on (`TICKET_TRIGGER_EVENT_TYPES`: `created`, `column_entered`,
  `comment_added`, `detail_edited`, `priority_changed`, `labels_changed`,
  `assigned`, `unassigned`), enqueues `trigger.ticket.dispatch` in the same
  transaction when the ticket's project has an enabled `ticket_changed`
  trigger — the way `project-task-attention.ts` enqueues its alert. A
  rolled-back write leaves neither behind. `status_changed`, attachment and
  checklist events are history only.
- **A column change also settles the ticket's agent work, in the same
  transaction.** `recordColumnEntered` ends a live work record in an end
  column or parks it in a review column (`applyTicketWorkColumnEntry`), and a
  change that leaves the ticket in no column — archived — ends it
  (`applyTicketWorkLeftBoard`), so every door that moves a ticket tears its
  work down alike — the trigger's own agent included — each under the
  ticket's work lock (`lockTicketForWork`).
- **`detail_edited` records the new description's hash** (`detailSha256`,
  `taskDetailSha256`), never the text, so a wake can tell whether the ticket
  still says what that author wrote.
- **The work an agent does on a ticket is history too**: `work_started`,
  `work_paused`, `work_resumed` and `work_ended`
  (`TICKET_WORK_ACTIVITY_EVENT_TYPES`, `TicketWorkActivityPayloadSchema`),
  each with `system` origin, the work record, its status and reason, `by`
  naming whoever caused it and `causeEventId` for the move that did. They
  are not dispatched; the ticket dialog's work chip lists them.
- **An unassigned ticket a person starts an agent's work on goes to that
  agent.** A qualifying move, status transition or create into a start-work
  column of a trigger that assigns on pickup writes an `assigned` event of
  `system` origin with reason `assign_on_pickup` instead of the mover's
  `moved_to_in_progress` ([ticket work](ticket-work.md) → "The work record,
  its thread, and what every wake says").

## Files: one upload door, several link doors

- **Bytes enter only through `POST /api/uploads`** (25 MiB, secret scan,
  thumbnail job, readable by the uploader alone until linked) and leave only
  through `FileService.delete` — the [file-storage](file-storage.md)
  chokepoint. There is no ticket multipart route. Tickets **link** uploads:
  `POST /api/tasks` and `PATCH /api/tasks/:taskId` (`attachmentIds`),
  `POST /api/tasks/:taskId/attachments`, and `POST /api/tasks/:taskId/comments`
  (which sets `taskCommentId` too). All four go through `linkUploadsToTask`,
  which links **only the actor's own still-unlinked uploads** (no `messageId`,
  `knowledgePageId`, `emailMessageId`, `taskId` or `taskCommentId`) and
  returns the ids that actually linked; anything else is skipped silently, as
  the message composer's link does. Each link writes one `attachment_added`
  `TaskEvent`.
- The two agent callers store and then link through the same door:
  `nessie_task_attachment_add` stores base64 (≤ 10 MiB, the upload route's
  secret scan) and calls `linkTaskAttachments`, deleting the stored file if the
  link does not take; `ticket_attachment_add` links a file the run already
  uploaded with `attachment_upload`. The only other writer of
  `Attachment.taskId` is the sync's provider-file store (below).
- **`Attachment.taskId` / `taskCommentId` are app-enforced, like `messageId`.**
  `canAccessAttachment` (`api/src/services/attachments.ts`) has a `taskId` arm,
  after `messageId` and `emailMessageId` and before the knowledge-page denial
  and the uploader fallback: a ticket's file is readable by exactly whoever
  `isTaskAccessibleToUser` admits — nobody else, the uploader included once
  they lose the ticket. Comment files carry `taskId` too, so the one arm covers
  them. `DELETE /api/attachments/:id` (discard my unused upload) keeps refusing
  a linked file; a ticket's file is removed through
  `DELETE /api/tasks/:taskId/attachments/:attachmentId` (optional `reason` in
  the body), the door that marks, audits and publishes.
- **Removing a file is a mark, not a delete, and anyone who can see the
  ticket may do it** (`removeTaskAttachment`). The row keeps its bytes and
  gains `removedAt`, the remover (`removedByUserId`, or `removedByAgentId`
  alone for an unattended agent run — `attachmentRemover`) and an optional
  `removedReason` (`normalizeRemovalReason`: trimmed, capped, null when
  empty); one `attachment_removed` `TaskEvent` is written. A removed file stays
  in the Attachments list in its place — the dialog shows who uploaded it, who
  removed it, when and why — and **still downloads** through the same `taskId`
  arm. There is **no restore door**; the row keeps everything one would need.
  A second removal is `ATTACHMENT_ALREADY_REMOVED` and never overwrites the
  first remover or reason; a provider-stored copy is the provider's file and is
  `ATTACHMENT_NOT_REMOVABLE`. The card's paperclip counts live files only.
- **Deleting a comment marks its files removed** (`deleteTaskComment`), with
  the deleter as remover and `COMMENT_REMOVAL_REASON`, one
  `attachment_removed` each; a file somebody already removed keeps its first
  remover. No path deletes a ticket file's bytes short of deleting the task.
- The unlinked-upload gap (nothing reaps an upload that was never linked) is
  pre-existing and shared with chat. Every client path links or discards; do
  not widen it.

## The inline-image URL form

- **An image in a description or comment is Markdown
  `![alt](/api/attachments/<id>)`**, exactly `INLINE_ATTACHMENT_PATH` /
  `inlineAttachmentPath` in `@nessie/schemas`. No `nessie://` scheme, no data
  URIs, no unauthenticated image route: the bytes stay behind the ticket's ACL,
  and the admin resolves the path through its authed blob hook because a bare
  `<img src>` would get a 401.
- **An inline image is a ticket attachment**, not a separate kind of file.
  `inlineAttachmentIds` finds the references (ignoring fenced and inline code)
  and the Attachments list marks those rows `inline`; a URL in any other form —
  a provider URL still pending import, an external image — is left alone.
- `Task.detail` and comment bodies are **stored as Markdown**. The editor
  (Tiptap + `@tiptap/markdown`) round-trips it and HTML never leaves the
  browser, so agents, search and import all read the same text.
- Written back upstream, a description goes through `rewriteForProvider`: a
  stored provider file returns to the provider's own URL, and a Nessie-born
  image becomes an absolute link to this deployment when `appOrigin` is known
  (it still needs a Nessie sign-in to open — the stated v1 gap).

## Comments belong to their author

- **A comment is edited or deleted by its author alone** — the
  `softDeleteMessage` rule. `isTaskCommentAuthor`: when the actor carries an
  `agentId`, the comment must have that `authorAgentId`; otherwise
  `authorUserId` must be the actor's person. There is no admin override.
  Deletion is soft (body blanked, `deletedAt` set), with `comment_added`,
  `comment_edited` and `comment_deleted` `TaskEvent`s.
- Who the author is depends on the surface, and is decided in one place per
  surface: a person in the dialog writes as themselves; an MCP credential
  resolves as the person who approved it, so its comment is that person's;
  a Personal Assistant is its person's delegate and writes as them; **a shared
  agent in a project channel writes as itself** (`ticketActorFor` sets
  `agentId`), with the asking person as the event's `by`.
- An imported comment has an author only as provider data
  (`externalAuthorExternalId`, `externalAuthorDisplay`) unless a
  `BoardSourceIdentityLink` resolves that provider user to a person or agent —
  then no provider display name is kept, the `remoteAssigneeDisplay` rule. A
  provider user never becomes a `User`: UOA owns identity. A Nessie comment
  whose author row is gone has no expressible author and is left out of the
  list rather than shown as nobody's.

## Labels: board-scoped, source-owned and Nessie-only

- A `TaskLabel` **belongs to a board** (`boardId`, with `projectId`
  denormalised and pinned to the board's project by a composite FK), unique on
  that board by `normalizeLabelName`, with a hex colour that is data.
  `sourceId`/`externalId` set means a board source owns it; neither set means
  it is **Nessie-only**. The same name on two boards is two labels.
- **A ticket's labels are its home board's**: `Task.boardId ?? the project's
  default board` (`resolveTaskHomeBoard`; `resolveHomeBoardId` in the admin).
  A requested id that is not a label of that board is refused
  `LABEL_NOT_ON_BOARD`. Labels are managed in Board → Settings → Labels; the
  dialog's *Manage labels…* links to the ticket's home board's tab, and the old
  Project → Settings `?section=labels` redirects to the default board's.
- **Labels follow a moved ticket by name.** A move to another board runs
  `rehomeTaskLabels` in the move's transaction: each link is re-pointed to the
  destination board's label with the same normalised name (a source-owned one
  also by `(sourceId, externalId)`), creating it with the same name, colour and
  ownership when missing, and one `labels_rehomed` event records the mapping.
  Deleting a board runs `rehomeBoardLabels` onto the board its tasks fall back
  to first, so no label or link is lost to the cascade.
- **Sync replaces only the source-owned subset** (`syncTaskSourceLabels`, when
  the source maps `native:labels`): a label a person added in Nessie survives
  every sync. `upsertSourceLabels` works on the ticket's home board: it keeps
  each provider label's name and colour, **adopts** a same-named Nessie-only
  label of that board rather than duplicating it, never takes a name another
  source owns there, and keeps the old name (still taking the colour) when an
  upstream rename would collide on that board. The same provider label on two
  boards is two rows, and a webhook rename recolours both.
- **`setTaskLabels` / `planTaskLabels` partitions a requested set by
  ownership.** Nessie-only changes are always written locally. A changed
  source-owned subset is written upstream first through the
  `BoardSourceWriteBack` collaborator and the mirror follows the provider's
  echo; a `read_only` source refuses it `SOURCE_READ_ONLY`. A label owned by a
  *different* source than the ticket's is refused
  `LABEL_NOT_IN_TASK_SOURCE` — it cannot mean anything upstream and the next
  sync would drop it silently. `updateProjectTask` runs the same plan inside
  its own write, so `labelIds` on a task update and the label tools agree.
- Renaming or recolouring a source-owned label in Nessie is local; the next
  sync restores the provider's name, and the record's `external: true` is how
  a caller says so.

## Import: who may read an upstream comment

- **A comment is imported only if its audience is its issue's audience.**
  Linear, GitHub and Trello comments are; they are stored under the ticket's
  project. **A Jira comment with a role/group `visibility`, or a Service
  Management internal note (`jsdPublic === false`), is never imported.** The
  adapter flags it `restricted` and carries no body past itself
  (`isRestrictedJiraComment`); `applyInboundComments` is the one place that
  drops it. This is why comments were kept out of the mirror in the boards
  design (§5.3 there): the objection is real for exactly this provider feature,
  and it is detectable. A new adapter whose provider has narrower-audience
  comments must set `restricted` rather than let them through.
- Comments upsert by `(sourceId, externalId)`, change only when the provider's
  `updatedAt` is newer, keep their upstream `createdAt`, and a comment deleted
  in Nessie stays deleted. A deletion upstream arrives only by webhook
  (`removeInboundComments`) — polling sees an absence, which is
  indistinguishable from "not read".

## Provider files

- An adapter that can fetch files declares **`assetHosts`** — the only hosts
  `fetchAsset` may dial — and may add a path-aware **`isAssetUrl`** when its
  upload host also serves ordinary pages. The shared inline scanner
  (`inlineAssetUrls`, `packages/board-sources/src/inline-assets.ts`) sees hosts
  only, so without the predicate every linked pull request or card in a
  comment would become a "file" to download: GitHub declares
  `user-images.githubusercontent.com` and matches `github.com/user-attachments/…`
  by path; Trello declares no `assetHosts` and matches its
  `/1/cards/…/attachments/…/download/` URLs; Linear declares
  `uploads.linear.app`; Jira `api.atlassian.com`. Only `https:` URLs count.
- **Fetching streams end to end** (`sourceFetchStream`,
  `packages/board-sources/src/http.ts`): the SSRF-vetted envelope, no redirect
  followed while a credential rides on the request, identity encoding, and a
  **25 MiB cap** (`SOURCE_ASSET_LIMIT_BYTES`, the upload route's own limit)
  enforced on the stream, never by buffering. A provider that answers with a
  redirect to a signed URL (GitHub) takes that hop by hand, credential-free, and
  only onto hosts the adapter names.
- `fetchPendingAssets` stores up to 20 files per sync job through
  `FileService.store` (uploader `null`, attributed to the connection owner) and
  rewrites the description and comments to the stored path. A retryable
  failure counts an attempt; **the third attempt, a file gone upstream, or one
  over the cap marks the asset `failed` and the provider URL stays in the
  text** — the renderer shows it as an ordinary remote image and the
  Attachments list names the problem. A link attachment is recorded as `link`
  and never fetched. A file removal upstream is not detected; the stored copy
  stays.

## Comment write-back: one collaborator, built once

- **`createTaskCommentWriteBackFromSource` (`board-source-writeback.ts`) is the
  only builder** of the `TaskCommentWriteBack` the comment functions take. The
  API (`api/src/services/task-comments.ts`, used by the routes and the MCP
  tools) and the worker (`ticket-comments.ts`) both call it, so a comment an
  agent posts reaches the provider exactly as a person's does. Do not hand-roll
  a second one.
- It is asked **before** the local transaction and the row is written from the
  provider's echo, carrying the `externalId` that stops the next sync importing
  it twice (an upsert, because the webhook for our own post can land first).
  A new comment on a `read_only` source, an unmirrored ticket, or a provider
  with no comment write **stays Nessie-only** (`propagated: false`; the MCP
  result says why in words). Editing or deleting an *imported* comment on a
  `read_only` source is refused `SOURCE_READ_ONLY`; where the adapter has no
  such write, `COMMENT_NOT_WRITABLE`. Files do not go upstream in v1.

## Realtime is content-free

- `task.activity { taskId, projectId }` (`publishTaskActivity`) after every
  comment and attachment change — routes, MCP tools, worker builtins — and once
  per sync job that touched comments or files. `task.updated` from the task
  routes. `board.updated { projectId }` (`publishProjectBoardUpdated`) when a
  label is created, renamed, recoloured or deleted, because cards repaint.
- All three are ids only, on the organisation scope, inside the unchanged
  envelope: the client's refetch is the entitlement check, and a replica or
  client that predates a name ignores it — the
  [inert-notification rule](horizontal-scaling/storage-and-realtime.md). Never
  put a comment body, filename or label name in the payload. A projectless task
  publishes no `task.activity`.

## The three agent surfaces mirror one function

| Surface | Tools | Reaches |
|---|---|---|
| MCP (`POST /mcp`, `api/src/mcp/tools/`) | `nessie_task_comment_{list,add,update,delete}`, `nessie_task_attachment_{list,add,get,remove}`, `nessie_label_{list,create,update,delete}`, `labelIds` on `nessie_task_create`/`nessie_task_update` | `boards_read` / `boards_write` |
| Personal Assistant builtins (`packages/runtime/src/builtin-ticket-tools.ts`, `worker/src/run/pa-tools/ticket-*.ts`) | `ticket_labels_read`, `ticket_label_create`, `ticket_comment_{list,add,update,delete}`, `ticket_attachment_{list,add,remove}`, `labelIds` on `ticket_create`/`ticket_update` | `personalAssistantOnly` |
| Peer subset (`PEER_PROJECT_TOOL_IDS`, `worker/src/run/execute/run-setup.ts`) | `ticket_labels_read`, `ticket_label_create`, `ticket_comment_list`, `ticket_comment_add`, `ticket_attachment_list`, `ticket_attachment_add` | a shared agent in a project channel, per explicit grant |

- **Each tool calls the same `@nessie/team-admin` function the route calls**,
  with a `TaskActor` built the way the route builds one, and publishes the same
  event. Adding a capability to one surface without the others, or giving a
  tool its own query, is a defect. Label rename, recolour and delete are
  deliberately MCP-only among agents: they are board administration, which the
  Personal Assistant leaves to the settings page.
- Worker reads stamp the project on the consumed-source basis
  (`recordProjectRead`) and worker writes pass `assertProjectWriteDestination`,
  as the other ticket tools do ([global agents](../global-agents.md) → "Project
  tickets from the Personal Assistant"). Comment bodies are not searched in v1:
  search fails closed on anything carrying a basis, and comment text has not
  been given one.
- MCP tool definitions carry no category ([tool-categories.md](tool-categories.md));
  the builtins are `category: 'projects'`.
