# Documents as a Finder — data and API

Part of [the Finder plan](overview.md). Two schema changes, nine new or
changed endpoints, and the derivations behind Get Info and indexing status.
Every shape is the contract the admin codes against; the zod lives in
`packages/schemas/src/knowledge-finder.ts` (new, shared by API and admin so a
field cannot drift the way `kind` did) and the API re-exports it from
`api/src/contracts/knowledge-base.ts`.

Conventions the reader should hold: every response is the `createApiResponse`
envelope (`{ data, meta? }`); every error is `{ error: { code, message } }`
through `sendApiError`; `BigInt` byte counts cross the wire as decimal
strings (`docs/standards/file-storage.md`); timestamps are ISO strings; ids
are uuids. Every new route builds its viewer through
`createKnowledgeAccess(deps).buildViewer` and gates on `requireKnowledgePolicy`
exactly as `knowledge-base.ts` does, so the two-layer access model (policy,
then per-space read/write) is never bypassed.

## 1. `folder` becomes a `KnowledgePageKind`

### Why

Today a folder is `metadata.folder === true || childrenOf(page).length > 0`
(`KnowledgeFilesystemRows.tsx`), and the schema comment says "Folders stay
virtual: a `document` page with child pages". The rule has three costs the
Finder cannot carry:

- Any document that gains a sub-page turns into a folder on screen and loses
  its document icon, its status pill and its Get Info shape.
- Latest and Shared with me are server listings that must exclude folders;
  the server cannot evaluate `childrenOf` without loading the space.
- Sort by kind, the row icon, the context menu, and Get Info all branch on
  "what is this row" before the children are known.

The enum was never going to stay closed at two values; adding one deliberate
value with a backfill is cheaper than every consumer carrying the convention.

*Rejected:* keeping the convention and adding `childCount` to the record. It
answers the third cost only; a document with children would still render as a
folder, which is the defect. *Rejected:* backfilling every document that has
children into a folder. A folder has no body; those documents have one.

### Migration (one new file under `api/prisma/migrations/`, existing ones are immutable)

```sql
-- 1. The kind.
ALTER TYPE "KnowledgePageKind" ADD VALUE IF NOT EXISTS 'folder';
-- (Postgres refuses to use a new enum value in the same transaction that
--  added it; Prisma runs each migration file in its own transaction, so the
--  backfill is a second migration file, immediately after this one.)
```

```sql
-- 2. Backfill, second file. Every page the convention flagged is a folder.
UPDATE knowledge_pages
   SET kind = 'folder'
 WHERE kind = 'document'
   AND deleted_at IS NULL
   AND metadata->>'folder' = 'true';

-- A folder has no content: drop the empty versions createPage made for it.
-- Guarded so a flagged page that somehow has a real body keeps it and is
-- reported instead of silently emptied.
DELETE FROM knowledge_page_versions v
 USING knowledge_pages p
 WHERE v.page_id = p.id
   AND p.kind = 'folder'
   AND (v.body IS NULL OR length(v.body) = 0)
   AND v.attachment_id IS NULL;

-- Folders are never published and never indexed.
UPDATE knowledge_pages
   SET published_version_id = NULL, status = 'published'
 WHERE kind = 'folder';
DELETE FROM knowledge_page_chunks c USING knowledge_pages p
 WHERE c.page_id = p.id AND p.kind = 'folder';
```

Rows under the old convention that are **not** flagged but have children stay
`document` and keep rendering as documents whose sub-pages are reached from
the open document's Sub-pages section (`PagePreview`) — the column browser
does not open a column for them. A verification query the migration PR must
run and paste into its description:

```sql
SELECT count(*) FROM knowledge_pages p
 WHERE p.kind = 'folder'
   AND EXISTS (SELECT 1 FROM knowledge_page_versions v
                WHERE v.page_id = p.id AND (v.body <> '' OR v.attachment_id IS NOT NULL));
-- must be 0; any row here is a flagged page with real content and is listed
-- in the PR for a human decision, never emptied.
```

### Code consequences (Wave 0 and Wave 2C)

- `KnowledgePageKind` in `packages/knowledge/src/types.ts`,
  `packages/schemas`, and `admin/src/facades/knowledge/hooks.ts` gains
  `'folder'`. The schema comment is rewritten: "A folder is a page of kind
  `folder`: no versions, never published, never indexed; its children are the
  pages whose `parentPageId` is it."
- `createPage` with `kind: 'folder'` writes **no** version and forces
  `status: 'published'` (a folder has no draft state). `CreateKnowledgePageBodySchema`
  gains `kind: z.enum(['document', 'folder']).optional()` (default
  `document`); files keep their own upload route.
- `ensureTaskFolder` creates `kind: 'folder'` and looks up by
  `(kind: 'folder', metadata.taskId)`; it still writes `metadata.taskId` and
  `taskId`. It stops writing `metadata.folder`.
- `movePage` requires the new parent to be `kind IN ('folder', 'document')`
  — a document may still parent sub-pages (wikilinks and `PagePreview`'s
  Sub-pages depend on it), but the Finder's Move to… dialog offers folders
  only.
- `publishPage`, `indexVersionChunks`, `enqueueKnowledgeExtract`,
  `listNativeRecentPages` and the search candidate queries exclude
  `kind = 'folder'`.
- The worker/agent tools that create folders through `metadata.folder`
  (`grep -rn "folder: true" worker/src packages/*/src api/src`) switch to
  `kind: 'folder'`; the `kb_file` tool's "move into folder" target check reads
  `kind`. Listed as Wave 2C.
- `KnowledgeRecentPageRecordSchema.kind` becomes the full kind enum.
- `isFolderPage(page)` is `page.kind === 'folder'`, and the
  `childrenOf`-based sort helper is deleted with it.

## 2. Person-to-person sharing: `KnowledgePageShare`

### Model

```prisma
/// `view`: read, download, follow links. `edit`: also write new versions,
/// upload file versions, add attachments, rename. Never: publish, move,
/// delete, re-share — those stay the owner's (§2, "What an edit grant is").
enum KnowledgePageShareAccess {
  view
  edit
}

/// One person granted access to one page at one level. For a folder the
/// grant covers every descendant at read (and write) time through a
/// recursive ancestor walk, never by copying rows. Only pages in the
/// sharer's own personal space may carry a share; the route enforces that,
/// the schema does not.
model KnowledgePageShare {
  id              String                   @id @default(uuid()) @db.Uuid
  organizationId  String                   @map("organization_id") @db.Uuid
  pageId          String                   @map("page_id") @db.Uuid
  // Denormalised from the page for the grantee's listing and for the
  // per-space invariant checks; a page never changes space (movePage keeps it).
  spaceId         String                   @map("space_id") @db.Uuid
  granteeUserId   String                   @map("grantee_user_id") @db.Uuid
  grantedByUserId String                   @map("granted_by_user_id") @db.Uuid
  access          KnowledgePageShareAccess @default(view)
  createdAt       DateTime                 @default(now()) @map("created_at")
  updatedAt       DateTime                 @updatedAt @map("updated_at")

  organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  page         KnowledgePage @relation(fields: [pageId], references: [id], onDelete: Cascade)
  grantee      User          @relation("KnowledgePageSharesReceived", fields: [granteeUserId], references: [id], onDelete: Cascade)

  @@unique([pageId, granteeUserId])
  @@index([granteeUserId, createdAt(sort: Desc)], map: "knowledge_page_shares_grantee_created_idx")
  @@index([organizationId, spaceId], map: "knowledge_page_shares_org_space_idx")
  @@map("knowledge_page_shares")
}
```

Revocation is a hard delete — the audit trail is the history; a level
change is an `UPDATE` of `access`. `User` gains the back-relation
`knowledgePageSharesReceived KnowledgePageShare[] @relation("KnowledgePageSharesReceived")`;
`KnowledgePage` gains `shares KnowledgePageShare[]`.

Migration: one `CREATE TYPE "KnowledgePageShareAccess" AS ENUM ('view', 'edit')`,
one `CREATE TABLE` with `access … DEFAULT 'view'`, the two indexes and the
unique. No backfill: nothing has ever been shared this way (the table is
born with both values, so no row ever needs re-levelling).

### What an edit grant is, and is not

An edit grant is **on the page**, never on the space. It changes exactly one
predicate — may this person write *this page* (or a page under this shared
folder) — and nothing about who may write the owner's other pages, create
pages in the owner's space, or see the owner's tree. Concretely:

| Act | `view` | `edit` | Owner only | Why edit stops there |
|---|---|---|---|---|
| open, download, versions, zip, attachments list, comments | yes | yes | | reading |
| `PATCH /pages/:id` body, summary, labels, **title** | no | yes | | content, and a name is part of a document; a rename is visible to the owner in their own tree, which is what they granted |
| `POST /pages/:id/file-version`, `POST /pages/:id/attachments`, `DELETE /attachments/:id` (own uploads) | no | yes | | content |
| comments and notes | yes | yes | | already open to readers |
| `POST /pages/:id/publish` | no | no | yes | publication is the owner's statement of "this is current"; *rejected:* letting editors publish — the owner would find their document's published version replaced without an act of theirs |
| `POST /pages/:id/move`, transfers, `DELETE /pages/:id` | no | no | yes | the tree and the bytes are the owner's; *rejected:* allowing move within the shared folder — it is still the owner's structure |
| `POST /pages/:id/shares` (re-share), `PATCH`/`DELETE` other people's shares | no | no | yes | *rejected:* transitive sharing — the owner's "Has access" list would stop being the truth |
| create a child page or folder inside a shared **folder** | no | yes | | writing inside the grant's subtree; the new page inherits the folder's share reach by the ancestor walk, and is created by the recipient (`createdBy`), in the owner's space with the owner's scope columns |
| `DELETE /pages/:id/shares/:me` (leave) | yes | yes | | anyone may decline |

**How it reaches the write path without becoming a space grant.**
`accessPageSpace(mode: 'write')` gains the mirror of the read arm: when
`canWriteSpace` is false **and** the actor is a user **and**
`pageSharedWithUser(…, { minimum: 'edit' })` is true, the write proceeds
*for that page id*. `pageSharedWithUser` takes a `minimum` and the recursive
walk stops at the first ancestor share, so a `view` share on a folder and an
`edit` share on a document inside it grant edit on the document and view on
its siblings. `canWriteSpace` itself is untouched; `POST /spaces/:id/pages`
(create at the space root) never consults shares; creating *under* a shared
folder goes through a new check in the create route: when the space is not
writable but `parentPageId` is set and `pageSharedWithUser(parent, edit)`
holds, the create is allowed with `createdBy: actor`. Publish, move,
transfer, archive and the share routes call a stricter helper
`requirePageOwnerWrite` that ignores shares entirely.

**`writeRestricted`.** A personal space has no settings dialog and the flag
is never set on it; if it were, an edit share is *exactly* the explicit
per-person grant `writeRestricted` reserves writing for, scoped to a page,
so the share arm is honoured regardless of the flag. Stated so nobody adds a
second check.

**Versions written by a recipient.** `KnowledgePageVersion.authorType =
'user'`, `authorId = recipient`, `origin: 'user_authored'`, trust as any
human edit. Version history names them through `ActorName` — "{Name}
(person)" — exactly as it names the owner; no "guest" pill (*rejected:* the
author is a person either way, and the marker would outlive the share). The
page's `updatedAt` moves, so it rises in the owner's Latest; the page's
scope columns and chunk mirrors are unchanged (it is still the owner's
page in the owner's space), so the owner's search sees the edit once the
owner publishes.

**Disclosure.** Read paths are unchanged: every retained version's basis is
still checked against the recipient (`canReadPageVersion`), so an edit grant
never opens a version the recipient could not read. A version the recipient
writes carries an empty basis of its own (a human edit consumed no agent
source) merged with the inherited one by `mergeVersionDisclosure`, so it
can never *loosen* the page's boundary either. Search for the recipient
still excludes shared pages (overview → left out).

### Who may share what

The route (§2 below) refuses unless **all** hold, and the admin hides the
Share item unless the client-visible subset holds (so a person never clicks
into a refusal):

| Condition | Server checks | Client can tell from |
|---|---|---|
| The actor is a person | `actor.actorType === 'user'` | always true in the admin |
| The page's space is the actor's personal space | `space.metadata.personal === true && space.userId === actor.actorId` | `space.metadata.personal && space.userId === me.user.id` (the root's My Documents row) |
| The page is not archived or deleted | `status <> 'archived' && deletedAt IS NULL` | row present |
| The grantee is an active member of the organisation and not the actor | `OrganizationMember`/UOA roster read the way `SpaceSettingsDialog` builds `userOptions` (`useUsers` locally, `useTeamMembers` under UOA) | the picker lists only those |
| The page's versions carry no basis the grantee cannot read | `canReadKnowledgePageVersion(version, disclosureViewerFor(grantee))` for every retained version — `docs/standards/disclosure-boundaries.md` | not knowable; the server answers `SHARE_SOURCE_RESTRICTED` and the dialog shows it |

*Rejected:* letting anyone who can write a page share it. A project member
could then hand a project document to someone outside the project, which is
exactly what the owner said must be a read-out of the project's permissions
instead. *Rejected:* sharing pages of agent homes (their audience is the
agent's visibility, `agent-documents.md` §4.1) and of ad-hoc spaces (those
already have `KnowledgeSpaceMember` through Sharing & settings).

### How the grantee reads

`packages/knowledge/src/access.ts` gains one function and one SQL helper:

```ts
// True when `userId` holds a share at or above `minimum` on `pageId` or on
// the nearest ancestor carrying one, in the same space. Depth-capped at 64
// like the info walk; a deeper tree is a data error, not a case.
export const pageSharedWithUser = (
  prisma: PrismaClient,
  input: { organizationId: string; pageId: string; userId: string; minimum: 'view' | 'edit' },
): Promise<boolean>

// The SQL arm for listings: pages readable through a share.
export const sharedPageIdsSql = (organizationId: string, userId: string): Prisma.Sql
```

```sql
WITH RECURSIVE chain AS (
  SELECT id, parent_page_id, 0 AS depth FROM knowledge_pages
   WHERE id = $pageId AND organization_id = $org AND deleted_at IS NULL
  UNION ALL
  SELECT p.id, p.parent_page_id, chain.depth + 1
    FROM knowledge_pages p JOIN chain ON p.id = chain.parent_page_id
   WHERE chain.depth < 64 AND p.deleted_at IS NULL
)
SELECT EXISTS (
  SELECT 1 FROM knowledge_page_shares s JOIN chain ON s.page_id = chain.id
   WHERE s.grantee_user_id = $userId
);
```

`createKnowledgeAccess.accessPageSpace(mode: 'read')` changes in one place:
when `canReadSpace` is false **and** the actor is a user **and**
`pageSharedWithUser(…, { minimum: 'view' })` is true, the read proceeds. The
version-basis check that follows (`canReadPageVersion`) is unchanged and
still applies, so a shared page whose newer version acquired a restricted
basis stops opening for the grantee rather than leaking. Write mode consults
shares only through the `edit` arm described above.

Read paths that go through `accessPageSpace('read')` and therefore open for a
grantee without further change: `GET /pages/:pageId`, `/versions`,
`/versions/:versionId/download`, `/zip`, `/zip/entry`, `/attachments`,
`/attachments/:attachmentId/download`, the comments list. Two do **not** go
through it and must gain the share arm explicitly: `GET /spaces/:spaceId/pages`
(a grantee of a folder needs the folder's children: the route accepts
`?sharedRootPageId=` and, when the space is unreadable, returns the subtree of
that page if the share holds — see §4) and the `KnowledgePageChunk` retrieval
path, which deliberately does not (overview → left out).

### Routes (new file `api/src/routes/knowledge-shares.ts`, registered after `registerKnowledgeBaseFileRoutes`)

```ts
// GET /api/knowledge-base/pages/:pageId/shares
// Who this page is shared with. Only the sharer (or an org owner) sees it;
// a grantee asking gets the same 403 as a stranger, so the list never
// discloses the other recipients.
export const KnowledgePageShareAccessSchema = z.enum(['view', 'edit'])
export const KnowledgePageShareRecordSchema = z.object({
  id: UuidSchema,
  pageId: UuidSchema,
  granteeUserId: UuidSchema,
  grantedByUserId: UuidSchema,
  access: KnowledgePageShareAccessSchema,
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
})
// 200 → KnowledgePageShareRecord[]
// 403 POLICY_DENIED (not the sharer), 404 KNOWLEDGE_PAGE_NOT_FOUND

// POST /api/knowledge-base/pages/:pageId/shares
export const CreateKnowledgePageShareBodySchema = z.object({
  granteeUserId: UuidSchema,
  access: KnowledgePageShareAccessSchema.optional(),   // default 'view'
})
// 201 → KnowledgePageShareRecord          (idempotent: an existing share returns 200 with the row; a different `access` in the body is applied — this is the "change level" path too)
// 400 SHARE_SELF                          "You already have access to your own document"
// 403 SHARE_NOT_PERSONAL                  "Only documents in My Documents can be shared with a person"
// 403 SHARE_SOURCE_RESTRICTED             "This document contains material {name} cannot be shown"
// 404 KNOWLEDGE_PAGE_NOT_FOUND, 404 USER_NOT_FOUND (grantee not an active member)
// 409 KNOWLEDGE_MUTATION_CONFLICT         (archived page)

// PATCH /api/knowledge-base/pages/:pageId/shares/:granteeUserId
export const UpdateKnowledgePageShareBodySchema = z.object({
  access: KnowledgePageShareAccessSchema,
})
// 200 → KnowledgePageShareRecord. Sharer (or org owner) only; a grantee asking gets 403.

// DELETE /api/knowledge-base/pages/:pageId/shares/:granteeUserId
// 204. The sharer may revoke any; a grantee may revoke their own (that is
// "Remove from Shared with me" in the menu). Anyone else: 403.
```

Every successful call emits an audit event (`emitAuditEvent`,
`resourceType: 'knowledge_page'`): `kb.page.shared` with
`metadata: { granteeUserId, access, spaceId }`, `kb.page.share_changed`
with `metadata: { granteeUserId, from, to, spaceId }`, and
`kb.page.unshared` with `metadata: { granteeUserId, spaceId, by: 'sharer' | 'grantee' | 'moved' }`.

**The gate this bypasses, by design.** The agent publication approval
(`knowledge.page.publish`, `api/src/services/approval-effects.ts`,
`ReviewPanel`, "Needs review") exists because agents draft and a person
publishes. A person sharing their own document with another person is a
different act: the share row is written on the request and takes effect on
the next read. It must never be routed into the approval queue, must not
create an `Approval` row, and the `AgentDraftBadge` never appears on it.
The e2e case `share-no-approval` pins this.

**What the recipient sees.** A `UserAlert` of kind `knowledge_shared` — a new
value in the alert kind enum at `packages/schemas/src/realtime.ts` (today
`'mention' | 'task_assigned' | 'knowledge_published'`) — with the sharer as
actor, the page title as subject and `href: /knowledge-base/shared-with-me?pageId=<id>`.
Because a NOTIFY payload with a kind an older replica does not know can crash
it during a blue-green swap, the publish carries `scopes: []` and the consumer
side lands one deploy before the producer side (Wave 1B ships the enum and
the reader; the writer is enabled by Wave 2A after 1B is on `main`). Copy:
"{Name} shared “{Title}” with you".

**Move and delete.** `movePage` never changes `spaceId`, so a share survives
any move within My Documents; a page moved *out from under* a shared folder
simply stops inheriting. A transfer out of the personal space ends every
share on the subtree ([transfer.md](transfer.md) §2 step 6). Archiving
hides the page from Shared with me (`status <> 'archived'` in §4) and makes
`GET /pages/:id` answer 404 to the grantee (the archived check runs before
the share arm); a hard delete cascades the rows. Un-archiving (restore)
brings the shares back untouched.

## 3. Latest — `GET /api/knowledge-base/latest`

```ts
export const KnowledgeLatestQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(), // default 50
  // Project scope (the project's Docs tab) narrows to that project's spaces.
  projectId: UuidSchema.optional(),
})

// Where a virtual row lives. `rootKind` decides the row's home line.
export const KnowledgeHomeSchema = z.object({
  spaceId: UuidSchema,
  spaceName: NonEmptyStringSchema,
  rootKind: z.enum(['personal', 'project', 'shared', 'agent']),
  projectId: UuidSchema.nullable(),
  projectName: z.string().nullable(),
  ownerAgentId: UuidSchema.nullable(),
  // Ancestors from the space root down to the parent, empty at the root.
  parentPath: z.array(z.object({ id: UuidSchema, title: NonEmptyStringSchema })),
})

export const KnowledgeVirtualRowSchema = z.object({
  id: UuidSchema,
  kind: z.enum(['document', 'file']),   // never folder
  title: NonEmptyStringSchema,
  status: KnowledgePageStatusSchema,
  mime: z.string().nullable(),          // file: current version's attachment mime
  sizeBytes: z.string().nullable(),     // file: current version's attachment bytes; document: octet_length(body); folder never here
  createdBy: NonEmptyStringSchema,
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
  indexing: KnowledgeIndexingStateSchema, // §6
  home: KnowledgeHomeSchema,
})
// 200 → { data: KnowledgeVirtualRow[], meta: PaginationMeta }   (keyset on (updated_at, id) desc; `total` omitted — a count over every readable space per keystroke is the cost the cap exists to avoid)
// 404 PROJECT_NOT_FOUND when projectId is not reachable (same as recent-pages)
```

Provider: `packages/knowledge/src/native-latest-pages.ts`,
`listNativeLatestPages`. One query over `knowledge_pages p JOIN knowledge_spaces s`
with `p.space_id IN (readableSpaceIdsSql(org, viewer))`, `p.kind <> 'folder'`,
`p.status <> 'archived'`, both `deleted_at IS NULL`, the same
`readableVersionSql(disclosureViewer)` clause `native-recent-pages.ts` uses,
ordered `p.updated_at DESC, p.id DESC`, keyset cursor
`base64url({ updatedAt, id })`, `LIMIT limit + 1`. The route then runs the
rows through `filterReadablePages` exactly as `knowledge-recent-pages.ts`
does (space membership alone is not sufficient for a private-derived
version). `parentPath` is one extra recursive query over the page's ancestor
chain for the returned rows only (≤ 100). `rootKind` derives from the space
row: `personal` when `metadata.personal`, `project` when
`metadata.projectDocuments`, `agent` when `owner_agent_id IS NOT NULL`, else
`shared`.

*Rejected:* widening `GET /recent-pages`. It is the project Overview's
five-row read with a 20 cap and a required `projectId`; two callers with two
caps on one route is how caps get raised for the wrong reader.

## 4. Shared with me — `GET /api/knowledge-base/shared-with-me`

```ts
export const KnowledgeSharedWithMeQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(), // default 50
})

export const KnowledgeSharedRowSchema = KnowledgeVirtualRowSchema.omit({ kind: true }).extend({
  kind: KnowledgePageKindSchema,          // folders may be shared
  access: KnowledgePageShareAccessSchema, // what the viewer may do; the row's subtitle
  sharedAt: NonEmptyStringSchema,
  sharedByUserId: UuidSchema,
})
// 200 → { data: KnowledgeSharedRow[], meta: PaginationMeta }  ordered by shares.created_at DESC, id DESC
```

One query: `knowledge_page_shares s JOIN knowledge_pages p JOIN knowledge_spaces sp`
where `s.grantee_user_id = viewer.userId`, `p.status <> 'archived'`, both
`deleted_at IS NULL`, then `filterReadablePages`. A shared **folder** is one
row; opening it lists its children through
`GET /spaces/:spaceId/pages?sharedRootPageId=<folderId>`, which the grantee
may call although the space is private to the sharer: the route, when
`accessSpace('read')` fails for a user, checks `pageSharedWithUser` on the
named root and, if it holds, returns the subtree of that root (the recursive
descendant CTE, capped at 10 000 rows with `meta.truncated: true`) instead of
the whole space. Without the param the 403 stands.

`home` for a shared row says where it lives *for the sharer* — "{Sharer}'s
documents › Contracts" — because the grantee has no root folder of their own
to stand in; the row's `rootKind` is `personal` and the admin renders the
sharer's name from `sharedByUserId` through `ActorName`.

## 5. Get Info — `GET /api/knowledge-base/pages/:pageId/info` and `GET /api/knowledge-base/spaces/:spaceId/info`

```ts
export const KnowledgeAccessSummarySchema = z.discriminatedUnion('mode', [
  // A page in the viewer's own personal space (or the space itself).
  z.object({ mode: z.literal('personal'), shareCount: z.number().int().nonnegative(), canShare: z.boolean() }),
  // A page in somebody else's personal space, reached through a share.
  z.object({ mode: z.literal('shared_to_me'), sharedByUserId: UuidSchema, access: KnowledgePageShareAccessSchema }),
  // Project Documents: access follows project membership.
  z.object({ mode: z.literal('project'), projectId: UuidSchema, projectName: NonEmptyStringSchema, memberCount: z.number().int().nonnegative() }),
  // An ad-hoc space: visibility + explicit members.
  z.object({ mode: z.literal('space'), spaceId: UuidSchema, spaceName: NonEmptyStringSchema, visibility: KnowledgeVisibilitySchema, memberUserCount: z.number().int(), memberAgentCount: z.number().int(), writeRestricted: z.boolean(), canManageAccess: z.boolean() }),
  // An agent's documents home.
  z.object({ mode: z.literal('agent'), agentId: UuidSchema, agentName: NonEmptyStringSchema, memberUserCount: z.number().int() }),
])

export const KnowledgeItemInfoSchema = z.object({
  id: UuidSchema,                         // page id, or space id for a root folder
  target: z.enum(['page', 'space']),
  kind: z.enum(['folder', 'document', 'file', 'space']),
  title: NonEmptyStringSchema,
  mime: z.string().nullable(),            // files only
  // "Size": what a person means — current bytes of every file inside, plus
  // octet_length of every document body. Strings: BigInt sums.
  sizeBytes: z.string(),
  // "On disk": what the quota charges — every retained version's attachment
  // plus every drawer attachment. Equals sizeBytes for a document; for a space
  // it is the StorageUsageEvent ledger (exact) rather than a sum.
  storageBytes: z.string(),
  retainedVersions: z.number().int().nonnegative(), // file versions beyond the current one, whole subtree
  counts: z.object({
    folders: z.number().int().nonnegative(),
    documents: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
  }),
  // True when the walk hit the 10 000-row cap: counts and sizes are lower bounds.
  truncated: z.boolean(),
  indexing: z.object({
    indexed: z.number().int().nonnegative(),      // items whose current version is searchable
    pending: z.number().int().nonnegative(),
    notIndexed: z.number().int().nonnegative(),   // unsupported / too large / draft / failed
  }),
  createdBy: NonEmptyStringSchema,
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,       // max(updated_at) over the subtree
  home: KnowledgeHomeSchema,
  access: KnowledgeAccessSummarySchema,
  taskId: UuidSchema.nullable(),         // a task folder names its ticket
})
// 200 → KnowledgeItemInfo
// 403 POLICY_DENIED / 404 KNOWLEDGE_PAGE_NOT_FOUND | KNOWLEDGE_SPACE_NOT_FOUND
```

**Computed on read, bounded.** One recursive CTE from the page (or every root
page of the space) down through `parent_page_id`, `deleted_at IS NULL`,
`status <> 'archived'`, `LIMIT 10001` (the 10 001st row sets `truncated`).
Joined once to the current version (`publishedVersion ?? latestVersion`) and
its attachment for `sizeBytes`; a second aggregate over **all** versions'
attachments plus `attachments.knowledge_page_id IN (subtree)` for
`storageBytes`. Documents contribute `octet_length(v.body)` to both. The
indexing triple reuses §6's derivation as a grouped query. For a **space**
target `storageBytes` comes from `fileService.usageForScope({ spaceId })`
because the ledger is exact there and already paid for; the subtree sum is
still computed for `sizeBytes`. Index support: `knowledge_pages_space_parent_position_idx`
serves the walk; `knowledge_page_versions_attachment_id_idx` and
`attachments(knowledge_page_id)` serve the joins. On a 10 000-item subtree
this is three queries and well under a second; the cap keeps it there.

*Rejected:* a maintained `subtreeSizeBytes` on every folder. Every upload,
version, move and archive would have to walk up and adjust it in the same
transaction, and the `StorageUsageEvent` ledger would be a second truth beside
it. *Rejected:* reusing `GET /storage-usage?scopeType=space` alone — it is
per space, not per subtree, and knows nothing of item counts.

## 6. Page records gain size, mime, indexing, shares

`KnowledgePageRecordSchema` (API) and `KnowledgePageRecord` (admin) gain:

```ts
kind: KnowledgePageKindSchema,            // was missing from the API contract (drift; fixed here)
revision: z.number().int().nonnegative(), // was missing too
mime: z.string().nullable(),              // file: current version's attachment.mime; else null
sizeBytes: z.string().nullable(),         // file: attachment.sizeBytes; document: octet_length(body); folder: null
shareCount: z.number().int().nonnegative(), // KnowledgePageShare rows on this page (0 outside personal spaces)
indexing: KnowledgeIndexingStateSchema,
```

```ts
export const KnowledgeIndexingStateSchema = z.discriminatedUnion('state', [
  // A folder; nothing to index.
  z.object({ state: z.literal('not_applicable') }),
  // The current version's chunks exist and every one has an embedding.
  z.object({ state: z.literal('indexed'), versionId: UuidSchema }),
  // Work is queued or running. `stage` names which job.
  z.object({ state: z.literal('pending'), stage: z.enum(['extract', 'embed']) }),
  // Honest "never will be", with the reason the UI spells out.
  z.object({ state: z.literal('not_indexed'), reason: z.enum(['draft', 'unsupported', 'too_large', 'empty']) }),
  // The queue job exhausted its attempts. Retry is POST …/reindex.
  z.object({ state: z.literal('failed'), stage: z.enum(['extract', 'embed']) }),
])
```

**Derivation** (`packages/knowledge/src/native-indexing-status.ts`,
`indexingStatesFor(prisma, pages)` — batched, two grouped queries for a whole
listing, never per row):

1. `kind === 'folder'` → `not_applicable`.
2. `kind === 'document'`: `status !== 'published'` → `not_indexed/draft`
   (documents are chunked on publish — `publishPage` → `indexVersionChunks`;
   overview → contradiction 10). Published with no body → `not_indexed/empty`.
   Otherwise fall through to 4 with the published version.
3. `kind === 'file'`: `!isExtractableUpload(filename, mime)` →
   `not_indexed/unsupported`; `attachment.sizeBytes > 20 MiB`
   (`MAX_ATTACHMENT_BYTES`, exported from `@nessie/schemas` as
   `KNOWLEDGE_EXTRACT_MAX_ATTACHMENT_BYTES` so the API and the worker agree)
   → `not_indexed/too_large`; else look up `queue_jobs` by
   `idempotency_key = 'kb-extract:{pageId}:{versionId}'`: status
   `pending|processing` → `pending/extract`; `failed` → `failed/extract`;
   else fall through to 4 with the latest version.
4. Chunks for the version: none → (a file whose extract job completed but
   wrote no chunks, i.e. empty text) `not_indexed/empty`; some with
   `embedding IS NULL` → look up `knowledge.embed` job by
   `knowledgeEmbeddingJobKey(pageId, versionId, model)`: `failed` →
   `failed/embed`, else `pending/embed`; all embedded → `indexed`.

The derivation is an exhaustive `switch` over `KnowledgePageKind`; a kind
added later (a spreadsheet, say) fails to compile until its branch is
written, rather than silently reading as a document.

`isExtractableUpload` moves from `api/src/routes/knowledge-base-file-extract.ts`
to `packages/knowledge/src/extractable.ts` so the provider, the route and the
worker share it (the worker keeps its defensive re-check by importing the same
function).

**Reindex** — `POST /api/knowledge-base/pages/:pageId/reindex` (in
`knowledge-finder.ts`): write access required; for a file re-enqueues
`knowledge.extract` with a fresh idempotency key suffix
`kb-extract:{pageId}:{versionId}:retry:{n}` (n = prior attempts + 1, read
from the failed job's `attempt`); for a published document re-runs
`indexVersionChunks`. 202 with the new `indexing` state; 400
`REINDEX_NOT_APPLICABLE` for folders, drafts, unsupported and too-large.
Audit `kb.page.reindexed`.

## 7. The root — `GET /api/knowledge-base/root`

```ts
export const KnowledgeRootSpaceSchema = z.object({
  spaceId: UuidSchema,
  name: NonEmptyStringSchema,
  canWrite: z.boolean(),
  canManageAccess: z.boolean(),
  visibility: KnowledgeVisibilitySchema,
  writeRestricted: z.boolean(),
  ownerAgentId: UuidSchema.nullable(),
  projectId: UuidSchema,
  projectName: z.string().nullable(),
  updatedAt: NonEmptyStringSchema,
})

export const KnowledgeRootSchema = z.object({
  // Always present for a user actor: provisioned by the same
  // ensureMyDocsSpace call POST /my-docs makes, emitting kb.space.created once.
  myDocuments: KnowledgeRootSpaceSchema,
  // Every project the viewer belongs to (viewer.projectIds), alphabetical.
  // `space` is null until somebody opens the folder for the first time.
  projects: z.array(z.object({
    projectId: UuidSchema,
    projectName: NonEmptyStringSchema,
    space: KnowledgeRootSpaceSchema.nullable(),
  })),
  // Readable spaces that are neither personal nor projectDocuments, alphabetical, capped.
  shared: z.array(KnowledgeRootSpaceSchema),
  sharedTruncated: z.boolean(), // more than 200 — the status bar says so
  sharedWithMeCount: z.number().int().nonnegative(), // badge on the virtual row; 0 hides it
})
// 200 → KnowledgeRoot. Agents (actorType 'agent') get 403 ACTOR_TYPE_NOT_ALLOWED: the root is a person's view.
```

One route, four reads: `ensureMyDocsSpace`; `project` rows for
`viewer.projectIds` with their `projectDocuments` space by a single
`IN` query; `provider.listSpaces` with the readable predicate,
`limit: 201`, filtered in memory by the two flags; a `count` on
`knowledge_page_shares` for the badge. *Rejected:* assembling the root from
`GET /spaces` (paged, personal excluded), `POST /my-docs` and `GET /projects`
on the client — three round trips and a paged list under a tree that must
not page.

**Opening a project folder that has no space yet** —
`POST /api/knowledge-base/projects/:projectId/documents` (in
`knowledge-finder.ts`): `canViewerReachProject` required (404
`PROJECT_NOT_FOUND` otherwise, matching `recent-pages`); calls
`ensureProjectDocumentsSpace` and emits `kb.space.created` when `created`;
returns the `KnowledgeSpaceResponse` envelope. The admin calls it when a
project row with `space: null` is opened and then navigates to
`/knowledge-base/spaces/:spaceId`. *Rejected:* provisioning every project's
space inside `GET /root` — a read that writes N rows for projects nobody has
opened.

## 8. Rename — reuse, not new

Rename in place is `PATCH /api/knowledge-base/pages/:pageId` with
`{ title }` and `If-Match: <revision>` (the existing optimistic-concurrency
header `readIfMatchRevision` reads). A 409
`KNOWLEDGE_PAGE_REVISION_CONFLICT` reverts the row's name and shows the
existing conflict copy. A root folder that is a space renames through
`PATCH /spaces/:spaceId { name }` (write access; personal and project spaces
refuse with 403 `SPACE_NAME_MANAGED`: "My Documents" and a project's folder
take their names from what they are).

## 9. Audit actions, complete list touched

| Action | When | Metadata |
|---|---|---|
| `kb.page.created` | existing; now carries `kind` for folders too | `{ spaceId, title, kind, parentPageId }` |
| `kb.page.shared` | §2 | `{ granteeUserId, access, spaceId }` |
| `kb.page.share_changed` | §2 | `{ granteeUserId, from, to, spaceId }` |
| `kb.page.unshared` | §2, transfer | `{ granteeUserId, spaceId, by: 'sharer' \| 'grantee' \| 'moved' }` |
| `kb.page.reindexed` | §6 | `{ versionId, stage }` |
| `kb.page.moved` | existing; a transfer adds `fromSpaceId`, `toSpaceId`, `descendants` | see [transfer.md](transfer.md) §2 |
| `kb.page.created` (copy) | a copied page carries `copiedFromPageId`, `fromSpaceId` | [transfer.md](transfer.md) §3 |
| `kb.space.created` | existing; also from `/root` (My Docs) and `/projects/:id/documents` | `{ name, personal? , projectDocuments? }` |
| `kb.page.updated`, `kb.page.moved`, `kb.page.archived` | existing, unchanged | |

Every actor is named on `/audit` through `ActorName`; no new resource types.

## 10. Errors the admin must render

| Code | HTTP | Where the person sees it |
|---|---|---|
| `STORAGE_QUOTA_EXCEEDED` | 507 | the upload row: "Not uploaded — storage is full"; queued siblings: "Skipped — storage is full" |
| `FILE_TOO_LARGE` | 413 | the upload row: "Too large — the limit is {formatBytes(limit)}" |
| `KNOWLEDGE_PAGE_REVISION_CONFLICT` | 409 | rename reverts; toast "This item changed since you opened it. Refresh and try again." |
| `SHARE_NOT_PERSONAL`, `SHARE_SELF`, `SHARE_SOURCE_RESTRICTED`, `USER_NOT_FOUND` | 403/400/403/404 | the Share dialog's `FormError` with the server message |
| `REINDEX_NOT_APPLICABLE` | 400 | Get Info: the Retry button is never shown in these states, so only a stale panel can hit it — toast with the message |
| `PROJECT_NOT_FOUND` | 404 | root row disappears on refetch; toast "You no longer have access to this project" |
| `POLICY_DENIED` (`NOT_A_SPACE_MEMBER`) | 403 | the column body: "You don't have access to this folder." with a Back |
| `TRANSFER_*` (five codes) | 400/403 | the move-or-copy prompt shows the refusal sentence in place of its items — [transfer.md](transfer.md) §4 |
| `STORAGE_QUOTA_EXCEEDED` on a copy | 507 | the prompt: "Not copied — storage is full" |

## 11. Transfers

Cross-root move and copy — `POST /api/knowledge-base/transfers`,
`GET /api/knowledge-base/transfers/:transferId`, the two new `FileService`
operations and the `knowledge.transfer` job — are specified in full in
[transfer.md](transfer.md); their schemas live in the same
`knowledge-finder.ts` file as the rest of this contract.
