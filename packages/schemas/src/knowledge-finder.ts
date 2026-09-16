import { z } from 'zod'

import { PaginationMetaSchema } from './api.js'
import {
  KnowledgePageKindSchema,
  KnowledgePageStatusSchema,
  KnowledgeVisibilitySchema,
} from './knowledge.js'
import { NonEmptyStringSchema } from './schema-primitives.js'

/**
 * The Documents Finder's wire contract, shared by the API and the admin so a
 * field cannot drift between them the way `kind` did — the API's page record
 * omitted it for months while the provider record and the admin type both
 * carried it, because the route spread the record onto the wire unparsed.
 *
 * Conventions, which every schema here obeys rather than restating:
 * every response travels in the `createApiResponse` envelope; `BigInt` byte
 * counts cross the wire as decimal strings (docs/standards/file-storage.md);
 * timestamps are ISO strings; ids are uuids.
 *
 * Designed in docs/plans/2026-09-16-documents-finder-ui/ — `data-and-api.md`
 * for the listings, info and sharing, `transfer.md` for move and copy.
 */

const UuidSchema = z.string().uuid()

// ---------------------------------------------------------------------------
// Indexing status (data-and-api.md §6)
// ---------------------------------------------------------------------------

/**
 * What a row may honestly say about being searchable. Derived server-side from
 * chunks, embeddings and the queue job — never from a status column, which
 * would be a second truth beside the chunks that the pipeline actually writes.
 *
 * `not_indexed` is the honest "never will be", with the reason the row spells
 * out; `draft` is a real one, because documents are chunked on publish.
 */
export const KnowledgeIndexingStateSchema = z.discriminatedUnion('state', [
  // A folder; there is nothing to index.
  z.object({ state: z.literal('not_applicable') }),
  // The current version's chunks exist and every one has an embedding.
  z.object({ state: z.literal('indexed'), versionId: UuidSchema }),
  // Work is queued or running. `stage` names which job.
  z.object({ state: z.literal('pending'), stage: z.enum(['extract', 'embed']) }),
  // `unsaved`: a spreadsheet nobody has saved a version of. Its searchable
  // text is the projection written with each durable version, so there is
  // genuinely nothing to index yet — which is a different sentence from
  // "no text found" and from "draft", and reads as neither.
  z.object({
    state: z.literal('not_indexed'),
    reason: z.enum(['draft', 'unsupported', 'too_large', 'empty', 'unsaved']),
  }),
  // The queue job exhausted its attempts. Retry is POST …/pages/:id/reindex.
  z.object({ state: z.literal('failed'), stage: z.enum(['extract', 'embed']) }),
])
export type KnowledgeIndexingState = z.infer<typeof KnowledgeIndexingStateSchema>

// ---------------------------------------------------------------------------
// Where an item lives
// ---------------------------------------------------------------------------

/**
 * A row's home: the root folder it lives in and the path under it. A virtual
 * row (Latest, Shared with me) renders this as its subtitle because it is
 * standing somewhere else; an ordinary row is already standing in its home.
 *
 * `rootKind` decides the home line's wording and is derived from the space, not
 * stored: `personal` when `metadata.personal`, `project` when
 * `metadata.projectDocuments`, `agent` when the space has an owner agent, else
 * `shared`. There is deliberately no `KnowledgeSpace.kind` column — it would
 * restate what the two metadata flags and `ownerAgentId` already say.
 */
export const KnowledgeHomeSchema = z.object({
  spaceId: UuidSchema,
  spaceName: NonEmptyStringSchema,
  rootKind: z.enum(['personal', 'project', 'shared', 'agent']),
  projectId: UuidSchema.nullable(),
  projectName: z.string().nullable(),
  ownerAgentId: UuidSchema.nullable(),
  // Ancestors from the space root down to the parent; empty at the root.
  parentPath: z.array(z.object({ id: UuidSchema, title: NonEmptyStringSchema })),
})
export type KnowledgeHome = z.infer<typeof KnowledgeHomeSchema>

/** A page's live cross-space transfer, surfaced so a row can refuse edits. */
export const KnowledgePageTransferStateSchema = z.object({
  transferId: UuidSchema,
  operation: z.enum(['move', 'copy']),
  targetSpaceId: UuidSchema,
  startedAt: NonEmptyStringSchema,
})
export type KnowledgePageTransferState = z.infer<typeof KnowledgePageTransferStateSchema>

// ---------------------------------------------------------------------------
// Latest (data-and-api.md §3) and Shared with me (§4)
// ---------------------------------------------------------------------------

export const KnowledgeLatestQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(), // default 50
  // Project scope (the project's Docs tab) narrows to that project's spaces.
  projectId: UuidSchema.optional(),
})
export type KnowledgeLatestQuery = z.infer<typeof KnowledgeLatestQuerySchema>

/** A row in a virtual folder: a real page that lives somewhere else. */
export const KnowledgeVirtualRowSchema = z.object({
  id: UuidSchema,
  // Latest excludes folders; every other kind is a change somebody made, and
  // a spreadsheet reaches this listing exactly as its siblings do.
  kind: z.enum(['document', 'file', 'spreadsheet']),
  title: NonEmptyStringSchema,
  status: KnowledgePageStatusSchema,
  // file: the current version's attachment mime.
  mime: z.string().nullable(),
  // file: the current version's attachment bytes; document: octet_length(body).
  sizeBytes: z.string().nullable(),
  createdBy: NonEmptyStringSchema,
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
  indexing: KnowledgeIndexingStateSchema,
  home: KnowledgeHomeSchema,
})
export type KnowledgeVirtualRow = z.infer<typeof KnowledgeVirtualRowSchema>

export const KnowledgeLatestResponseSchema = z.object({
  data: z.array(KnowledgeVirtualRowSchema),
  // `total` is omitted: a count over every readable space per keystroke is the
  // cost the keyset cap exists to avoid.
  meta: PaginationMetaSchema,
})
export type KnowledgeLatestResponse = z.infer<typeof KnowledgeLatestResponseSchema>

export const KnowledgeSharedWithMeQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(), // default 50
})
export type KnowledgeSharedWithMeQuery = z.infer<typeof KnowledgeSharedWithMeQuerySchema>

/**
 * What a page-level share grants. `view`: read, download, follow links.
 * `edit`: also write new versions, upload file versions, add attachments and
 * rename. Never publish, move, delete or re-share — the tree and the audience
 * stay the owner's.
 */
export const KnowledgePageShareAccessSchema = z.enum(['view', 'edit'])
export type KnowledgePageShareAccess = z.infer<typeof KnowledgePageShareAccessSchema>

export const KnowledgeSharedRowSchema = KnowledgeVirtualRowSchema.omit({ kind: true }).extend({
  kind: KnowledgePageKindSchema, // folders may be shared
  access: KnowledgePageShareAccessSchema, // what the viewer may do; the subtitle
  sharedAt: NonEmptyStringSchema,
  sharedByUserId: UuidSchema,
})
export type KnowledgeSharedRow = z.infer<typeof KnowledgeSharedRowSchema>

export const KnowledgeSharedWithMeResponseSchema = z.object({
  data: z.array(KnowledgeSharedRowSchema),
  meta: PaginationMetaSchema,
})
export type KnowledgeSharedWithMeResponse = z.infer<typeof KnowledgeSharedWithMeResponseSchema>

// ---------------------------------------------------------------------------
// Shares (data-and-api.md §2)
// ---------------------------------------------------------------------------

export const KnowledgePageShareRecordSchema = z.object({
  id: UuidSchema,
  pageId: UuidSchema,
  granteeUserId: UuidSchema,
  grantedByUserId: UuidSchema,
  access: KnowledgePageShareAccessSchema,
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
})
export type KnowledgePageShareRecord = z.infer<typeof KnowledgePageShareRecordSchema>

/**
 * Creating a share is idempotent and is also the change-level path: an
 * existing row comes back with the body's `access` applied. It is written on
 * the request and takes effect on the next read — a person sharing their own
 * document with another person is never routed into the agent publication
 * approval queue.
 */
export const CreateKnowledgePageShareBodySchema = z.object({
  granteeUserId: UuidSchema,
  access: KnowledgePageShareAccessSchema.optional(), // default 'view'
})
export type CreateKnowledgePageShareBody = z.infer<typeof CreateKnowledgePageShareBodySchema>

export const UpdateKnowledgePageShareBodySchema = z.object({
  access: KnowledgePageShareAccessSchema,
})
export type UpdateKnowledgePageShareBody = z.infer<typeof UpdateKnowledgePageShareBodySchema>

// ---------------------------------------------------------------------------
// Get Info (data-and-api.md §5)
// ---------------------------------------------------------------------------

/** Who can reach an item, read out in the terms that actually decide it. */
export const KnowledgeAccessSummarySchema = z.discriminatedUnion('mode', [
  // A page in the viewer's own personal space (or the space itself).
  z.object({
    mode: z.literal('personal'),
    shareCount: z.number().int().nonnegative(),
    canShare: z.boolean(),
  }),
  // A page in somebody else's personal space, reached through a share.
  z.object({
    mode: z.literal('shared_to_me'),
    sharedByUserId: UuidSchema,
    access: KnowledgePageShareAccessSchema,
  }),
  // Project Documents: access follows project membership, nothing else.
  z.object({
    mode: z.literal('project'),
    projectId: UuidSchema,
    projectName: NonEmptyStringSchema,
    memberCount: z.number().int().nonnegative(),
  }),
  // An ad-hoc space: visibility plus explicit members.
  z.object({
    mode: z.literal('space'),
    spaceId: UuidSchema,
    spaceName: NonEmptyStringSchema,
    visibility: KnowledgeVisibilitySchema,
    memberUserCount: z.number().int(),
    memberAgentCount: z.number().int(),
    writeRestricted: z.boolean(),
    canManageAccess: z.boolean(),
  }),
  // An agent's documents home.
  z.object({
    mode: z.literal('agent'),
    agentId: UuidSchema,
    agentName: NonEmptyStringSchema,
    memberUserCount: z.number().int(),
  }),
])
export type KnowledgeAccessSummary = z.infer<typeof KnowledgeAccessSummarySchema>

/**
 * Get Info, computed on read with one bounded recursive walk. There is no
 * maintained `subtreeSizeBytes`: every upload, version, move and archive would
 * have to walk up and adjust it in the same transaction, and the
 * `StorageUsageEvent` ledger would be a second truth beside it.
 */
export const KnowledgeItemInfoSchema = z.object({
  id: UuidSchema, // page id, or space id for a root folder
  target: z.enum(['page', 'space']),
  kind: z.enum(['folder', 'document', 'file', 'spreadsheet', 'space']),
  title: NonEmptyStringSchema,
  mime: z.string().nullable(), // files only
  // "Size": what a person means — current bytes of every file inside, plus
  // octet_length of every document body.
  sizeBytes: z.string(),
  // "On disk": what the quota charges — every retained version's attachment
  // plus every drawer attachment. For a space this is the StorageUsageEvent
  // ledger (exact) rather than a sum.
  storageBytes: z.string(),
  // File versions beyond the current one, whole subtree.
  retainedVersions: z.number().int().nonnegative(),
  counts: z.object({
    folders: z.number().int().nonnegative(),
    documents: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    // Counted apart from documents: "3 documents" over a folder of workbooks
    // names the wrong thing, and "Contains" is the one line that says what is
    // actually in there.
    spreadsheets: z.number().int().nonnegative(),
  }),
  // True when the walk hit its row cap: counts and sizes are lower bounds.
  truncated: z.boolean(),
  indexing: z.object({
    indexed: z.number().int().nonnegative(), // current version is searchable
    pending: z.number().int().nonnegative(),
    // unsupported / too large / draft / failed
    notIndexed: z.number().int().nonnegative(),
  }),
  createdBy: NonEmptyStringSchema,
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema, // max(updated_at) over the subtree
  home: KnowledgeHomeSchema,
  access: KnowledgeAccessSummarySchema,
  taskId: UuidSchema.nullable(), // a task folder names its ticket
})
export type KnowledgeItemInfo = z.infer<typeof KnowledgeItemInfoSchema>

// ---------------------------------------------------------------------------
// The root column (data-and-api.md §7)
// ---------------------------------------------------------------------------

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
export type KnowledgeRootSpace = z.infer<typeof KnowledgeRootSpaceSchema>

/**
 * One read for the whole root column. Assembling it on the client would take
 * three round trips and put a paged list (`GET /spaces`) under a tree that must
 * not page.
 */
export const KnowledgeRootSchema = z.object({
  // Always present for a user actor, provisioned by the same ensureMyDocsSpace
  // call POST /my-docs makes.
  myDocuments: KnowledgeRootSpaceSchema,
  // Every project the viewer belongs to, alphabetical. `space` is null until
  // somebody opens the folder for the first time — a read must not write N
  // rows for projects nobody has opened.
  projects: z.array(z.object({
    projectId: UuidSchema,
    projectName: NonEmptyStringSchema,
    space: KnowledgeRootSpaceSchema.nullable(),
  })),
  // Readable spaces that are neither personal nor projectDocuments.
  shared: z.array(KnowledgeRootSpaceSchema),
  sharedTruncated: z.boolean(), // the status bar says so
  sharedWithMeCount: z.number().int().nonnegative(), // 0 hides the badge
})
export type KnowledgeRoot = z.infer<typeof KnowledgeRootSchema>

// ---------------------------------------------------------------------------
// Transfers (transfer.md §2–5)
// ---------------------------------------------------------------------------

/**
 * A move or a copy of pages from one root folder (space) to another.
 *
 * `acknowledged` is not ceremony: the client has to have shown the audience
 * and sharing consequences before it can be true, so no API caller can widen
 * an audience blind.
 */
export const TransferPagesBodySchema = z.object({
  operation: z.enum(['move', 'copy']),
  // The selection; descendants are implied.
  pageIds: z.array(UuidSchema).min(1).max(50),
  target: z.object({
    spaceId: UuidSchema,
    parentPageId: UuidSchema.nullable(), // null = the target root
  }),
  acknowledged: z.literal(true),
})
export type TransferPagesBody = z.infer<typeof TransferPagesBodySchema>

/**
 * 200 `done` up to 500 pages, 202 `queued` above it. Always a job would make a
 * two-page drag poll for something that takes 40 ms; never a job would hold a
 * transaction open for minutes on a 20 000-page copy of files.
 */
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
    transferId: UuidSchema, // the queue job id
    descendants: z.number().int().nonnegative(),
  }),
])
export type TransferResult = z.infer<typeof TransferResultSchema>

/**
 * Polled every 2 s while a transfer the viewer started is queued or running.
 * A failed move keeps the batches that committed — each rewrote its pages
 * *and* their chunks, so they are internally consistent — and `done`/`total`
 * are what the status bar names when it offers to retry the remainder.
 */
export const TransferStatusSchema = z.object({
  transferId: UuidSchema,
  operation: z.enum(['move', 'copy']),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  error: z.string().nullable(),
})
export type TransferStatus = z.infer<typeof TransferStatusSchema>

/**
 * The refusals a transfer keeps. Rendered in place of the move-or-copy
 * prompt's items, so each code must have a sentence a person can act on.
 */
export const TRANSFER_REFUSAL_CODES = [
  'TRANSFER_TARGET_NOT_WRITABLE',
  'TRANSFER_AGENT_CORE_DOCUMENT',
  'TRANSFER_TASK_BOUND',
  'TRANSFER_WIDENS_BASIS',
  'TRANSFER_INTO_SELF',
  'TRANSFER_NOT_ACKNOWLEDGED',
  'TRANSFER_MIXED_SOURCES',
] as const
export type TransferRefusalCode = (typeof TRANSFER_REFUSAL_CODES)[number]

/**
 * Where a transfer stops being one request. 500 because a copy of 500 pages
 * with files is ≤ 500 `FileService.copy` streams, which is the expensive path.
 */
export const TRANSFER_SYNCHRONOUS_MAX_PAGES = 500
