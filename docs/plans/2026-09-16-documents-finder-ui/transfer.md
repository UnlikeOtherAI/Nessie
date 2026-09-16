# Documents as a Finder — moving and copying between root folders

Part of [the Finder plan](overview.md). The owner overturned the first
draft's refusal of cross-root moves: "If we're moving between spaces, we
need to ask if it's a copy or move." This file is that design — the prompt,
the two operations to the row and the byte, the refusals that stay, the
bound past which a request becomes a job, and the cases that pin it.

Vocabulary: a **transfer** is a move or a copy of one or more pages from one
`KnowledgeSpace` to another. A move or copy *inside* one space is the
existing `POST /pages/:id/move` and is not a transfer.

## 1. The prompt

### Drag and drop

A row dragged onto a folder row or column body whose `spaceId` differs from
the source is a candidate transfer. The target highlights as any drop target
does. On release, **the drop-point menu** opens — the `ContextMenu`
primitive ([menus-and-dialogs.md](menus-and-dialogs.md) §1) with a point
anchor at the pointer, `label` "Move or copy":

```
  Move or copy 3 items to Marketing?           ← kind: 'heading'
  Everyone in the organisation will see them.  ← kind: 'heading' (the audience line, §4)
  Sharing with 2 people ends.                  ← kind: 'heading', only when shares exist (move only)
  ──────────────────────────────────────────
  Move here                                    ← default focus
  Copy here
  ──────────────────────────────────────────
  Cancel
```

Escape, outside press and Cancel all abort with nothing sent. Enter on the
focused item runs it. *Rejected:* a `ConfirmDialog` — it has one confirm
action and this is a three-way choice at the point of the gesture;
Finder's own answer is a menu at the cursor. *Rejected:* asking nothing and
always moving — the owner's instruction is to ask.

**Modifier.** Holding Alt (⌥ on macOS) while releasing copies without
asking, the way Finder's ⌥-drag does; the drag ghost shows a small `+` badge
while Alt is held so the intent is visible before release. No other
modifier is taken. A drag inside one root never asks and never copies
(⌥ is ignored there: an in-space duplicate is a separate feature this plan
does not add).

### Move to… (menu and F2-less keyboard path)

`MoveToDialog` ([menus-and-dialogs.md](menus-and-dialogs.md) §7) now lists
**every root folder the person can write**, each expandable to its folders.
Picking a target in the same root keeps the one primary "Move". Picking a
target in another root swaps the footer to two secondaries and no primary —
"Copy here" · "Move here" — under the same audience and sharing lines as the
menu; a footer with two filled buttons would name no decision (design-system),
and here there genuinely are two. The dialog title becomes "Move or copy
{n} {item|items}…" the moment a foreign root is selected.

## 2. What a move does

`POST /api/knowledge-base/transfers` (new file `api/src/routes/knowledge-transfers.ts`):

```ts
export const TransferPagesBodySchema = z.object({
  operation: z.enum(['move', 'copy']),
  pageIds: z.array(UuidSchema).min(1).max(50),   // the selection; descendants are implied
  target: z.object({
    spaceId: UuidSchema,
    parentPageId: UuidSchema.nullable(),         // null = the target root
  }),
  // True after the client has shown the audience/sharing lines; the server
  // refuses without it so no API caller can widen an audience blind.
  acknowledged: z.literal(true),
})

export const TransferResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('done'),
    operation: z.enum(['move', 'copy']),
    // Source id → id in the target (identical for a move, new for a copy).
    pages: z.array(z.object({ sourcePageId: UuidSchema, pageId: UuidSchema })),
    descendants: z.number().int().nonnegative(),
    sharesEnded: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('queued'),
    operation: z.enum(['move', 'copy']),
    transferId: UuidSchema,                        // the queue job id
    descendants: z.number().int().nonnegative(),
  }),
])
// 200 done | 202 queued
// 403 TRANSFER_TARGET_NOT_WRITABLE, 403 TRANSFER_AGENT_CORE_DOCUMENT, 403 TRANSFER_TASK_BOUND,
// 403 TRANSFER_WIDENS_BASIS, 400 TRANSFER_INTO_SELF, 400 TRANSFER_NOT_ACKNOWLEDGED,
// 409 KNOWLEDGE_MUTATION_CONFLICT (a page is already in a queued transfer), 507 STORAGE_QUOTA_EXCEEDED (copy only)
// GET /api/knowledge-base/transfers/:transferId → { status: 'queued'|'running'|'done'|'failed', done: number, total: number, error: string|null }
```

Server steps for a **move**, in one transaction for the synchronous case
(§5 says when it is not):

1. **Load and check.** Every `pageId` through `getMutablePage`; all must be
   in one source space (400 `TRANSFER_MIXED_SOURCES` otherwise — the
   selection model already guarantees this). `accessSpace(source, 'write')`
   and `accessSpace(target, 'write')`. Run the refusals in §4. Take
   `lockKnowledgeTreeMoves` on **both** spaces, lower id first, so two
   concurrent transfers cannot deadlock or interleave.
2. **Collect the subtree.** The recursive descendant CTE from
   [data-and-api.md](data-and-api.md) §5 over the selected roots, depth ≤ 64,
   `deleted_at IS NULL`. Its size decides §5.
3. **Rewrite the pages.** One `UPDATE knowledge_pages SET space_id = $target,
   project_id = s.project_id, team_id = s.team_id, channel_id = s.channel_id,
   thread_id = s.thread_id, user_id = s.user_id, visibility = s.visibility,
   sensitivity_tier = s.sensitivity_tier, private_to_agent_id = s.private_to_agent_id,
   revision = revision + 1 FROM knowledge_spaces s WHERE s.id = $target AND
   knowledge_pages.id IN (subtree)`. `task_id` is untouched (a task-bound
   page never gets here — §4). The selected roots also get
   `parent_page_id = $parentPageId` and `position = max(position)+1…` in the
   target parent; descendants keep their parents. `metadata.folder`/`taskId`
   keys are not touched (they are gone after the backfill anyway).
4. **Rewrite the chunk mirrors in the same statement family.**
   `UPDATE knowledge_page_chunks SET project_id, team_id, channel_id,
   thread_id, user_id, visibility, sensitivity_tier, private_to_agent_id
   FROM knowledge_spaces s WHERE page_id IN (subtree)` — every mirrored scope
   column, from the destination space, `task_id` untouched. Retrieval reads
   the chunk row alone, so a chunk left on the old scope would keep answering
   the old audience; this is why the rewrite is in the same transaction as
   step 3 and why the chunk update is the load-bearing line of this file.
5. **Annotations.** `UPDATE knowledge_page_annotations SET space_id = $target
   WHERE page_id IN (subtree)` — the model denormalises `spaceId`.
6. **Shares.** A share is valid only on a page in its owner's personal space.
   Moving out of a personal space deletes every `KnowledgePageShare` on the
   subtree and emits one `kb.page.unshared` per row with `by: 'moved'`
   (`sharesEnded` in the result, and the prompt said so first). Moving into
   a personal space creates none. Moving between two non-personal spaces
   touches none (there are none).
7. **Versions and attachments.** Rows are untouched: a version's
   `attachmentId` still points at the same bytes; `publishedVersionId`,
   `status`, `revision` (incremented once) stay. Basis scopes and disclosure
   sources stay with their versions — they are provenance, and §4 has
   already checked the destination audience can satisfy them.
8. **Storage ledger.** The bytes did not move but their scope did: the
   ledger is what `GET /storage-usage?scopeType=project|space` and the quota
   read, so a move must re-home the accounted bytes. New `FileService`
   operation `reassignScope(attachmentIds, { from: FileScope, to: FileScope, attribution })`
   writes, per attachment, one `StorageUsageEvent` with `operation: 'move.out'`
   and `deltaBytes: -size` in the old `(projectId, teamId, spaceId)` and one
   `'move.in'`/`+size` in the new — thumbnails included, the same pairing
   `delete.thumbnail`/`store.thumbnail` already uses. `StorageStoreOperation`
   gains the two values. Organisation totals are unchanged by construction
   (the pair sums to zero), so no quota check runs for a move. It is a
   `FileService` method because `file-storage.md` makes accounting part of
   the file operation and forbids ledger writes anywhere else. Attachments
   in the subtree = every `KnowledgePageVersion.attachmentId` plus every
   `Attachment.knowledgePageId IN (subtree)`.
9. **Links.** `KnowledgePageLink` rows key on page ids, which do not change;
   nothing to do. Wikilinks by title keep resolving through the existing
   resolver.
10. **Audit.** One `kb.page.moved` per selected root with
    `metadata: { fromSpaceId, toSpaceId, parentPageId, position, descendants }`,
    plus the `kb.page.unshared` rows from step 6.
11. **Answer** `{ status: 'done', pages: [{ sourcePageId, pageId: same }], … }`.

The admin invalidates `knowledgeKeys.pages(source)`, `pages(target)`,
`root`, `latest`, `sharedWithMe` and every `pageInfo` in the subtree.

## 3. What a copy does

Same checks and locks as §2 steps 1–2, then, per page in the subtree in
parent-before-child order (a `WITH RECURSIVE` ordered by depth):

1. **A new page row.** New id; `spaceId` and every scope column from the
   destination; `parentPageId` mapped through the old-id → new-id table
   (roots to `target.parentPageId`); `kind`, `title`, `summary`, `labels`
   (via `PageLabel` rows), `metadata` minus the keys `transfer`, `taskId`,
   `folder`; `documentRole: 'knowledge'` (never the source role — see
   below); `taskId: null`; `status` as the source (a published document
   copies as published, a draft as a draft); `createdBy` the actor;
   `position` appended.
2. **One version, the current one.** `publishedVersion ?? latestVersion`
   becomes version 1 of the copy with `authorType: 'user'`, `authorId` the
   actor, `origin: 'user_authored'`, `trust` copied, `changeComment:
   "Copied from {source space name}"`. `body`, `bodyRef`, `sourceContentHash`
   copied. **Basis scopes and disclosure sources are copied onto the new
   version** — provenance travels with content (§4 has verified the
   destination can satisfy them, but the rows must still exist so a later
   move of the copy is judged on the truth). *Rejected:* copying the whole
   history — a copy is a new document with a known origin, and carrying
   another space's edit trail (with other authors' names) into a project
   folder is a disclosure of who worked on what that nobody asked for.
3. **Bytes are re-stored, never referenced.** For a file version, or a
   drawer attachment, `FileService.copy(attachmentId, { organizationId,
   uploaderId: actor, scope: targetScope, knowledgePageId: newPageId,
   attribution })` streams `openStream` into `store`: a new `Attachment` row,
   a `store` ledger event in the destination scope, the quota checked
   (507 `STORAGE_QUOTA_EXCEEDED` aborts the whole copy — the transaction
   rolls back the rows already written and the bytes already stored are
   deleted through `FileService.delete` in the same failure path, so a
   half-copy leaves nothing), a fresh thumbnail from the same store
   chokepoint. *Rejected:* pointing the copy's version at the source
   `Attachment` row — `purgeKnowledgePageFiles` on either page would delete
   bytes the other still shows, the ledger would count one blob in one
   scope while two pages claim it, and `Attachment` carries no reference
   count to make that safe. Re-storing costs storage; that is what a copy is.
4. **No chunks are copied.** The copy re-enters the pipeline exactly as a
   new page would: a file version → `enqueueKnowledgeExtract`; a published
   document → `indexVersionChunks` inside the transaction (it runs
   `onVersionChunksReplaced`, so `knowledge.embed` is enqueued). The embed
   job's copy-by-`content_hash` step then reuses the source's vectors, so a
   copy of an indexed page is searchable within seconds without a provider
   call. *Rejected:* copying chunk rows — they would carry the source's
   scope until rewritten, and the pipeline already does this correctly.
5. **What a copy does not carry**, decided one by one:

   | Thing | Copy? | Why |
   |---|---|---|
   | `KnowledgePageShare` rows | no | a share belongs to the owner of the source; the copy has a new owner and lives where the destination's audience already decides readers |
   | Annotations (comments, notes) | no | they were conversations about the source; Finder copies a file, not its comment thread. *Rejected:* copying them — they name people in a place they never wrote |
   | Backlinks (`KnowledgePageLink` targets) | no | links point at the source page id; the copy has none pointing at it until someone links to it |
   | Outgoing wikilinks in the body | yes, as text | the body is copied; the link indexer re-parses it on the copy's first save exactly as it does for any new body |
   | `taskId` / task binding | no | a ticket's documents live in its project; the copy is a plain page |
   | `AgentCoreDocument` role | no | refused outright for the source (§4); a copy of an ordinary agent page is `documentRole: 'knowledge'` |
   | Labels | yes | descriptive metadata of the content |
   | `metadata` | yes minus the three keys above | |
   | Versions beyond the current | no | step 2 |
   | Publication state | yes | a published source copies as published (its copied version is `publishedVersionId`) |

6. **Audit.** `kb.page.created` per new page with
   `metadata: { copiedFromPageId, fromSpaceId, kind }`.
7. **Answer** with the id map, so the admin can select the copies in the
   target column.

## 4. Refusals that stay

Every one is checked before any write, in this order, and each names its
sentence (the dialog/menu shows it in place of the operation items, with
only "OK"):

| Code | When | Sentence |
|---|---|---|
| `TRANSFER_TARGET_NOT_WRITABLE` | `canWriteSpace(target)` is false | "You can't add items to {target}." |
| `TRANSFER_INTO_SELF` | the target is the selected folder or one of its descendants | "A folder can't be moved into itself." |
| `TRANSFER_AGENT_CORE_DOCUMENT` | any page in the subtree has an `AgentCoreDocument` row | "“{title}” is {Agent}'s active instructions and stays with the agent." |
| `TRANSFER_TASK_BOUND` | any page in the subtree has `taskId` and the target space's `projectId` differs from the source's — a task folder and its documents may move within the project's Documents space, not out of it | "“{title}” belongs to a ticket in {project} and can't leave that project." |
| `TRANSFER_WIDENS_BASIS` | §4.1 fails for any retained version in the subtree | "“{title}” contains material that not everyone in {target} may see." |
| `TRANSFER_NOT_ACKNOWLEDGED` | `acknowledged` missing | (never shown; the client always sends it after the prompt) |

### 4.1 The widening rule

A move or copy changes who can read a page from the source space's
audience to the destination's. Ordinary widening — a private document moved
into a project folder — is **allowed**, said out loud in the prompt's
audience line, because it is the reason people move things into a project.
What is refused is widening past a version's **basis**: a page whose
retained versions carry `KnowledgePageVersionBasisScope` rows describes
material an agent read from somewhere its new audience cannot reach
(`docs/standards/disclosure-boundaries.md`). The rule is deterministic and
needs no viewer:

```
destination scope D = scopeForVisibility(target space)     // user | channel | team | project | organization
for every retained version v of every page in the subtree:
  if v.disclosureSources.some(s => s.sourceAuthorUserId === null)  → refuse   (unknown author: nobody may read it anyway)
  for every basis scope B in v.basisScopes:
    satisfied when
      B.scopeType === 'organization'                                          (everyone)
      or B == D                                                               (same audience)
      or (B.scopeType === 'user' and D is that user's personal space)
      or (B.scopeType === 'agent' and target.ownerAgentId === B.scopeId)
    otherwise → refuse
```

`project → project` with a different id refuses (a different project's
people); `channel`/`team` bases refuse unless the destination is that
channel's or team's own space. *Rejected:* evaluating with the actor's own
`DisclosureViewer` — the actor can read it; the question is whether the
*destination's audience* can. *Rejected:* stripping the basis on move
(laundering by drag).

The audience line in the prompt is derived from `D`:

| Destination | Line |
|---|---|
| personal (yours) | "Only you will see {it\|them}." |
| project Documents | "Everyone in the project {name} will see {it\|them}." |
| shared, `organization` | "Everyone in the organisation will see {it\|them}." |
| shared, `project` | "Everyone in the project {name} will see {it\|them}." |
| shared, `team` / `channel` / `private` | "People added to {space} will see {it\|them}." |
| agent home | "People who can see the agent {name} will see {it\|them}." |

## 5. The bound: when a request becomes a job

The server counts the subtree first (step 2). **Up to 500 pages** the
transfer runs synchronously in one transaction (the pages, chunks,
annotations and shares are set-based `UPDATE`s; a copy of 500 pages with
files is ≤ 500 `FileService.copy` streams, which is the expensive path, and
that is why 500 and not 5 000). **Above 500** the route:

1. Stamps every selected root with `metadata.transfer = { transferId, operation, targetSpaceId, startedAt }`
   in one write, which the pages list surfaces as `transfer` on the record
   so the rows read "Moving…"/"Copying…" and refuse edits, moves and
   deletes (409 `KNOWLEDGE_MUTATION_CONFLICT` "This item is being moved").
2. Enqueues `knowledge.transfer` (`KNOWLEDGE_TRANSFER_TOPIC`, payload
   `{ organizationId, transferId, operation, pageIds, target, actor, acknowledgedAudience }`,
   idempotency key `kb-transfer:{transferId}`) and answers 202 `queued`.
3. The worker (`worker/src/control/knowledge-transfer.ts`) takes the same
   two tree locks, re-runs §4 (the world may have changed), and processes
   the subtree in batches of 200 pages, each batch its own transaction in
   parent-before-child order, writing `done/total` into the job's
   `payload.progress` after each batch. A batch failure marks the job
   `failed` with `error_message`, clears `metadata.transfer`, and — for a
   copy — deletes everything the earlier batches created (the id map is in
   the job payload) so a partial copy never lingers; for a move, the batches
   already committed stand (they are internally consistent: each batch
   rewrote its pages *and* their chunks) and the rows that did not move stay
   where they were, which the status bar reports as "Moved 1,200 of 1,800 —
   {error}. The rest stayed in {source}." with a Retry that re-enqueues the
   remainder.
4. The admin polls `GET /transfers/:id` every 2 s while a transfer it
   started is `queued|running`, shows "Moving 3 folders… 600 of 1,800" in
   the status-bar tray (the upload tray's sibling row), and on `done`
   invalidates the same keys as §2 and shows "Moved 1,800 items to
   {target}".

*Rejected:* always a job — a two-page drag would show a spinner and poll
for something that takes 40 ms. *Rejected:* always synchronous — a 20 000-
page copy of files holds a transaction and a request open for minutes.

## 6. Row and menu consequences

- A row with `transfer` set renders its name at `opacity-60` with the
  trailing text "Moving…"/"Copying…"; its menu offers Get Info only.
- After a synchronous move the moved rows are selected in the target column
  (the Finder reveals what you moved); after a copy the copies are.
- Virtual rows (Latest, Shared with me) may be dragged and may use Move
  to…; their source space is `home.spaceId`. A grantee in Shared with me
  cannot move or copy (no write on the source) — the items are absent.
- Multi-selection transfers as one request (`pageIds` ≤ 50; the menu's
  select-all in a column of more than 50 shows "Select up to 50 items to
  move them together").

## 7. Cases (added to the suite in [verification-and-waves.md](verification-and-waves.md) §1)

| Id | Steps | Asserts | Screenshot |
|---|---|---|---|
| F-XFER-01 | drag `Plan` (My Documents › Contracts) onto the `P` root row | the drop-point menu opens with the heading "Move or copy “Plan” to P?", the line "Everyone in the project P will see it.", items Move here / Copy here / Cancel; the first item has focus | `transfer-menu.png` |
| F-XFER-02 | choose Move here | `POST /transfers` with `operation: 'move'`, `acknowledged: true`; 200 `done`; `Plan` is gone from Contracts and selected in `P`'s column; the API page has `spaceId` = P's space and `visibility: 'project'`; every `knowledge_page_chunks` row for the page has `project_id` = P and `visibility = 'project'` (SQL assert); a `kb.page.moved` audit row carries `fromSpaceId`/`toSpaceId` | `transfer-moved.png` |
| F-XFER-03 | share `Ideas` with the second user, then move `Ideas` to `P` | the menu shows "Sharing with 1 person ends."; after the move the share row is gone, `kb.page.unshared` has `by: 'moved'`, the recipient's Shared with me no longer lists it | — |
| F-XFER-04 | upload `lease.pdf` into Contracts; move Contracts (the folder) to `P` | two ledger events for the attachment: `move.out` with `space_id` = My Docs and `delta_bytes` negative, `move.in` with `space_id` = P's space and the positive delta; `GET /storage-usage?scopeType=space&scopeId=<P space>` grew by the file's bytes, the My Docs scope shrank by the same, the organisation total is unchanged; the annotations on `lease.pdf` (seed one comment) have `space_id` = P's space | — |
| F-XFER-05 | drag `Plan` from `P` back onto My Documents holding Alt | no menu; `POST /transfers` with `operation: 'copy'`; the ghost showed the `+` badge (screenshot during drag) | `transfer-alt-copy.png` |
| F-XFER-06 | copy `lease.pdf` (published, indexed) into `P` via Move to… → Copy here | a new page id; its single version is v1 with `changeComment` "Copied from My Documents" and the actor as author; a **new** `attachments` row with a new `storage_key` and a `store` ledger event in P's scope; the source attachment untouched; within 60 s the copy's `indexing.state` is `indexed` and its chunks' `embedding` equal the source's (copied by `content_hash`); the copy has no `knowledge_page_shares`, no annotations, no backlinks | `transfer-copied.png` |
| F-XFER-07 | copy a folder with three children | the copy's children have the copy as parent (id map applied); the source is untouched | — |
| F-XFER-08 | set the org quota to just above current usage; copy a folder holding two files | 507; no new page rows, no new attachment rows, no orphan objects in storage (list the bucket/filesystem prefix and compare before/after); the menu shows "Not copied — storage is full" | — |
| F-XFER-09 | seed a version on a document with a basis scope `channel:<private channel id>` (write the row directly); move it to Marketing (organisation) | 403 `TRANSFER_WIDENS_BASIS`; the menu shows "“{title}” contains material that not everyone in Marketing may see."; nothing changed | `transfer-widen-refused.png` |
| F-XFER-10 | move the same page into My Documents (the actor's personal space) when the basis is `user:<actor>` | allowed (the personal-space arm) | — |
| F-XFER-11 | move a task folder (seeded through `ensureTaskFolder`) from `P`'s Documents to Marketing | 403 `TRANSFER_TASK_BOUND` with the sentence; moving it into a sibling folder inside `P`'s space is the ordinary in-space move and succeeds | — |
| F-XFER-12 | (if an agent with a core document exists) move that page | 403 `TRANSFER_AGENT_CORE_DOCUMENT` | — |
| F-XFER-13 | as the read-only second user, drag a Marketing document onto their My Documents | allowed (they can write the target and copy from a readable source) as a **copy**; Move here is `aria-disabled` with `title` "You can't remove items from Marketing" (no write on the source) | `transfer-copy-only.png` |
| F-XFER-14 | seed 600 pages under one folder; move it to `P` | 202 `queued`; the folder row reads "Moving…" and its menu offers Get Info only; the tray shows progress; within the suite's timeout `GET /transfers/:id` is `done` and every page and chunk carries P's scope | `transfer-queued.png` |
| F-XFER-15 | force a failure mid-job (make the third batch's target parent archived through the DB after the job starts) | the job is `failed`; for a move, the batches that committed are in `P` with consistent chunks and the rest stayed; the tray sentence names the counts and the Retry re-enqueues the remainder, which completes | `transfer-partial.png` |
| F-XFER-16 | in the transfer menu press Escape | nothing sent; focus returns to the dragged row | — |
| F-XFER-17 | Move to… on a Latest row | the dialog opens with the row's real home preselected as current; a cross-root target shows the two-button footer | `transfer-move-to-cross.png` |

## 8. Files (feeds the wave lists)

API: `api/src/routes/knowledge-transfers.ts` (route, refusals, sync path,
enqueue), `packages/knowledge/src/transfer/{collect,move,copy,basis-check}.ts`
(the provider-level operations, each a function of a `Prisma.TransactionClient`
so the route and the worker share them), `packages/runtime/src/files/index.ts`
(`FileService.copy`, `FileService.reassignScope`), `packages/runtime/src/storage-usage-ledger.ts`
(`move.in`/`move.out`), `packages/schemas/src/jobs.ts` (`KNOWLEDGE_TRANSFER_TOPIC`
and payload), `worker/src/control/knowledge-transfer.ts`,
`worker/src/worker-subscriptions-core.ts` (one `subscribe`). Admin:
`finder/TransferPrompt.tsx` (the drop-point menu items and the dialog footer
variant, built on `ContextMenu`), `finder/useFinderDrag.ts` (cross-root
branch, Alt), `finder/MoveToDialog.tsx` (all roots, two-button footer),
`facades/knowledge/finder-hooks.ts` (`useTransferPages`, `useTransferStatus`).
