import { Prisma, type PrismaClient } from '@prisma/client'
import {
  KNOWLEDGE_EMBED_TOPIC,
  KNOWLEDGE_EXTRACT_MAX_ATTACHMENT_BYTES,
  KNOWLEDGE_EXTRACT_TOPIC,
  type KnowledgeIndexingState,
} from '@nessie/schemas'

import { isExtractableUpload } from './extractable.js'
import type { KnowledgePageKind, KnowledgePageStatus } from './types.js'

/**
 * What a row may honestly say about being searchable, derived on read from the
 * three things that actually decide it: the chunks, their embeddings, and the
 * queue job. Nothing is stored — a status column would be a second truth beside
 * the rows the pipeline writes, and it would go stale exactly when the pipeline
 * fails, which is the case the screen exists to show.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §6 and
 * uploads-and-indexing.md §4 (the sentence each state renders).
 *
 * Batched on purpose: a whole listing costs a fixed handful of grouped queries,
 * never one per row.
 *
 * Deviation from the design, forced by the code: the design names the queue's
 * exhausted state `failed`. `PgQueueProvider` (packages/runtime/src/queue.ts)
 * writes `pending`, `processing`, `done`, `dead` and `deleted` — there is no
 * `failed` row to read, and `dead` is what "exhausted its attempts" is called.
 * `dead` therefore maps to the wire's `failed`.
 */

export type IndexingStatusPage = {
  id: string
  kind: KnowledgePageKind
  status: KnowledgePageStatus
  publishedVersionId: string | null
}

type VersionFacts = {
  versionId: string
  attachmentId: string | null
  bodyBytes: number
}

type AttachmentFacts = {
  filename: string
  mime: string
  sizeBytes: bigint
}

type ChunkFacts = {
  total: number
  unembedded: number
}

type VersionRow = {
  pageId: string
  versionId: string
  attachmentId: string | null
  bodyBytes: number | null
}

/** The `knowledge.extract` job key for exactly this (page, version). */
export const knowledgeExtractJobKey = (pageId: string, versionId: string): string =>
  `kb-extract:${pageId}:${versionId}`

/**
 * A retry cannot reuse the exhausted row's key — the unique index would swallow
 * it — so it lands under a suffixed key that still shares the base prefix the
 * status read matches on.
 */
export const knowledgeExtractRetryJobKey = (
  pageId: string,
  versionId: string,
  attempt: number,
): string => `${knowledgeExtractJobKey(pageId, versionId)}:retry:${attempt}`

/** The prefix every `knowledge.embed` key for a (page, version) starts with. */
export const knowledgeEmbedJobKeyPrefix = (pageId: string, versionId: string): string =>
  `kb-embed:${pageId}:${versionId}:`

/**
 * The newest `knowledge.extract` job for a (page, version), across the base key
 * and every retry suffix. The reindex route reads `attempt` from it to number
 * the next retry.
 */
export const latestKnowledgeExtractJob = async (
  prisma: PrismaClient,
  pageId: string,
  versionId: string,
): Promise<{ status: string; attempt: number } | null> => {
  const rows = await prisma.$queryRaw<Array<{ status: string; attempt: number }>>(Prisma.sql`
    SELECT j.status, j.attempt
    FROM queue_jobs j
    WHERE j.topic = ${KNOWLEDGE_EXTRACT_TOPIC}
      AND j.idempotency_key LIKE ${`${knowledgeExtractJobKey(pageId, versionId)}%`}
    ORDER BY j.enqueued_at DESC, j.id DESC
    LIMIT 1
  `)
  return rows[0] ?? null
}

// One row per prefix: the newest job whose idempotency key starts with it. Page
// and version ids are uuids, so neither `%` nor `_` can reach the LIKE pattern
// from anything a caller supplies.
const jobStatusByPrefix = async (
  prisma: PrismaClient,
  topic: string,
  prefixes: string[],
): Promise<Map<string, string>> => {
  if (prefixes.length === 0) return new Map()
  const rows = await prisma.$queryRaw<Array<{ prefix: string; status: string }>>(Prisma.sql`
    SELECT DISTINCT ON (k.prefix) k.prefix AS "prefix", j.status AS "status"
    FROM unnest(${prefixes}::text[]) AS k(prefix)
    JOIN queue_jobs j
      ON j.topic = ${topic}
     AND j.idempotency_key LIKE k.prefix || '%'
    ORDER BY k.prefix, j.enqueued_at DESC, j.id DESC
  `)
  return new Map(rows.map((row) => [row.prefix, row.status]))
}

const loadVersionFacts = async (
  prisma: PrismaClient,
  latestForPageIds: string[],
  byVersionIds: string[],
): Promise<Map<string, VersionFacts>> => {
  const facts = new Map<string, VersionFacts>()
  const remember = (rows: VersionRow[]): void => {
    for (const row of rows) {
      facts.set(row.pageId, {
        versionId: row.versionId,
        attachmentId: row.attachmentId,
        bodyBytes: Number(row.bodyBytes ?? 0),
      })
    }
  }
  if (latestForPageIds.length > 0) {
    remember(await prisma.$queryRaw<VersionRow[]>(Prisma.sql`
      SELECT DISTINCT ON (v.page_id)
             v.page_id AS "pageId",
             v.id AS "versionId",
             v.attachment_id AS "attachmentId",
             octet_length(coalesce(v.body, '')) AS "bodyBytes"
      FROM knowledge_page_versions v
      WHERE v.page_id = ANY(${latestForPageIds}::uuid[])
      ORDER BY v.page_id, v.version_number DESC
    `))
  }
  if (byVersionIds.length > 0) {
    remember(await prisma.$queryRaw<VersionRow[]>(Prisma.sql`
      SELECT v.page_id AS "pageId",
             v.id AS "versionId",
             v.attachment_id AS "attachmentId",
             octet_length(coalesce(v.body, '')) AS "bodyBytes"
      FROM knowledge_page_versions v
      WHERE v.id = ANY(${byVersionIds}::uuid[])
    `))
  }
  return facts
}

const loadChunkFacts = async (
  prisma: PrismaClient,
  versionIds: string[],
): Promise<Map<string, ChunkFacts>> => {
  if (versionIds.length === 0) return new Map()
  // `embedding` is an Unsupported("vector") column, so "how many are still
  // missing one" cannot be asked through the Prisma client.
  const rows = await prisma.$queryRaw<Array<{
    versionId: string
    total: bigint
    unembedded: bigint
  }>>(Prisma.sql`
    SELECT c.version_id AS "versionId",
           count(*) AS "total",
           count(*) FILTER (WHERE c.embedding IS NULL) AS "unembedded"
    FROM knowledge_page_chunks c
    WHERE c.version_id = ANY(${versionIds}::uuid[])
    GROUP BY c.version_id
  `)
  return new Map(rows.map((row) => [row.versionId, {
    total: Number(row.total),
    unembedded: Number(row.unembedded),
  }]))
}

// Step 4 of the derivation: the chunks of the current version decide between
// indexed, an embedding still in flight, and "there was no text in it".
const stateFromChunks = (
  versionId: string,
  chunks: ChunkFacts | undefined,
  embedJobStatus: string | undefined,
): KnowledgeIndexingState => {
  if (!chunks || chunks.total === 0) return { state: 'not_indexed', reason: 'empty' }
  if (chunks.unembedded === 0) return { state: 'indexed', versionId }
  if (embedJobStatus === 'dead') return { state: 'failed', stage: 'embed' }
  return { state: 'pending', stage: 'embed' }
}

/**
 * A spreadsheet is indexed like neither sibling, which is why it is collected
 * with `file`'s latest-version lookup and answered by its own function.
 *
 * `createSpreadsheetSnapshot` writes the workbook's text projection into the
 * version's `body`, and `addFileVersion` → `indexVersionChunks` writes the
 * chunks and enqueues the embed inside that same transaction. Neither of the
 * two steps the other arms wait on ever happens here:
 *
 * - `fileState` asks `isExtractableUpload` and then waits for a
 *   `knowledge.extract` job. The attachment on the version is the `.xlsx`
 *   rendition, which is not an extractable upload, so that arm would report
 *   every spreadsheet in the building as "Not indexed — unsupported" — and the
 *   text it would have been judging is not in the attachment anyway.
 * - `documentState` gates on `status === 'published'`, because a document is
 *   chunked on publish. Nothing publishes a spreadsheet: it stays `draft` and
 *   is searchable regardless, so that arm would report "Not indexed — draft"
 *   about a page whose chunks are embedded.
 *
 * What is left is the part both share: the chunks of the newest saved version.
 * Search is honestly stale between versions (docs/standards/spreadsheets.md →
 * "Versions, compaction and the sweeps"); this state answers for the version
 * that exists, which is exactly what is searchable.
 */
const spreadsheetState = (
  page: IndexingStatusPage,
  version: VersionFacts | undefined,
  chunks: Map<string, ChunkFacts>,
  embedJobs: Map<string, string>,
): KnowledgeIndexingState => {
  // A page created but never compacted has no durable version yet — the first
  // one is deferred to the first snapshot — so there is no text to find. That
  // is not "no text found": nothing has been saved yet, and saying so keeps a
  // new sheet as quiet as a draft document.
  if (!version || version.bodyBytes === 0) return { state: 'not_indexed', reason: 'unsaved' }
  return stateFromChunks(
    version.versionId,
    chunks.get(version.versionId),
    embedJobs.get(knowledgeEmbedJobKeyPrefix(page.id, version.versionId)),
  )
}

const documentState = (
  page: IndexingStatusPage,
  version: VersionFacts | undefined,
  chunks: Map<string, ChunkFacts>,
  embedJobs: Map<string, string>,
): KnowledgeIndexingState => {
  // Documents are chunked on publish (`publishPage` → `indexVersionChunks`), so
  // a draft is honestly unsearchable and says why rather than spinning forever.
  if (page.status !== 'published' || !version) return { state: 'not_indexed', reason: 'draft' }
  if (version.bodyBytes === 0) return { state: 'not_indexed', reason: 'empty' }
  return stateFromChunks(
    version.versionId,
    chunks.get(version.versionId),
    embedJobs.get(knowledgeEmbedJobKeyPrefix(page.id, version.versionId)),
  )
}

const fileState = (
  page: IndexingStatusPage,
  version: VersionFacts | undefined,
  attachments: Map<string, AttachmentFacts>,
  chunks: Map<string, ChunkFacts>,
  extractJobs: Map<string, string>,
  embedJobs: Map<string, string>,
): KnowledgeIndexingState => {
  if (!version) return { state: 'not_indexed', reason: 'empty' }
  const attachment = version.attachmentId ? attachments.get(version.attachmentId) : undefined
  if (!attachment) return { state: 'not_indexed', reason: 'empty' }
  if (!isExtractableUpload(attachment.filename, attachment.mime)) {
    return { state: 'not_indexed', reason: 'unsupported' }
  }
  if (attachment.sizeBytes > BigInt(KNOWLEDGE_EXTRACT_MAX_ATTACHMENT_BYTES)) {
    return { state: 'not_indexed', reason: 'too_large' }
  }
  const extract = extractJobs.get(knowledgeExtractJobKey(page.id, version.versionId))
  if (extract === 'pending' || extract === 'processing') {
    return { state: 'pending', stage: 'extract' }
  }
  if (extract === 'dead') return { state: 'failed', stage: 'extract' }
  return stateFromChunks(
    version.versionId,
    chunks.get(version.versionId),
    embedJobs.get(knowledgeEmbedJobKeyPrefix(page.id, version.versionId)),
  )
}

/**
 * A spreadsheet. Its searchable text is the projection written into the
 * `body` of each durable version (`spreadsheet/snapshot.ts`), so it is judged
 * on the same chunks as a document — but never on `status`: a spreadsheet is
 * not published, it is saved.
 *
 * No version, and a version whose projection is empty, are the same answer on
 * purpose: they are indistinguishable to a reader (a new workbook is created
 * with no snapshot, and a blank one projects to nothing) and they are cured by
 * the same act. `empty` would say "no text found", which reads as a verdict on
 * a grid that may simply not have been saved yet.
 */

/**
 * The indexing state of every page in one listing, keyed by page id.
 *
 * The switch over `KnowledgePageKind` is exhaustive on purpose: a kind added
 * later fails to compile here until its branch says what it does, rather than
 * silently reading as a document.
 */
export const indexingStatesFor = async (
  prisma: PrismaClient,
  pages: readonly IndexingStatusPage[],
): Promise<Map<string, KnowledgeIndexingState>> => {
  const states = new Map<string, KnowledgeIndexingState>()
  const latestForPageIds: string[] = []
  const publishedVersionIds: string[] = []
  const considered: IndexingStatusPage[] = []
  for (const page of pages) {
    switch (page.kind) {
      case 'folder':
        states.set(page.id, { state: 'not_applicable' })
        continue
      case 'document':
        considered.push(page)
        // A published document is judged on the version it published, not on a
        // newer draft nobody has searched yet.
        if (page.status === 'published' && page.publishedVersionId) {
          publishedVersionIds.push(page.publishedVersionId)
        }
        continue
      // Both are judged on their newest version rather than a published one: a
      // file has no draft state, and nothing publishes a spreadsheet. They part
      // company at the state function — see `spreadsheetState`.
      case 'file':
      // A spreadsheet is judged on its latest saved version, like a file node
      // — there is no `publishedVersionId` on this kind at all.
      case 'spreadsheet':
        considered.push(page)
        latestForPageIds.push(page.id)
        continue
      default: {
        const unhandled: never = page.kind
        throw new Error(`Unhandled knowledge page kind: ${String(unhandled)}`)
      }
    }
  }
  if (considered.length === 0) return states

  const versions = await loadVersionFacts(prisma, latestForPageIds, publishedVersionIds)
  const attachmentIds = Array.from(new Set(
    Array.from(versions.values())
      .map((version) => version.attachmentId)
      .filter((id): id is string => id !== null),
  ))
  const attachmentRows = attachmentIds.length > 0
    ? await prisma.attachment.findMany({
        where: { id: { in: attachmentIds } },
        select: { id: true, filename: true, mime: true, sizeBytes: true },
      })
    : []
  const attachments = new Map<string, AttachmentFacts>(
    attachmentRows.map((row) => [row.id, {
      filename: row.filename,
      mime: row.mime,
      sizeBytes: row.sizeBytes,
    }]),
  )
  const versionIds = Array.from(new Set(
    Array.from(versions.values()).map((version) => version.versionId),
  ))
  const chunks = await loadChunkFacts(prisma, versionIds)
  const extractPrefixes: string[] = []
  const embedPrefixes: string[] = []
  for (const page of considered) {
    const version = versions.get(page.id)
    if (!version) continue
    embedPrefixes.push(knowledgeEmbedJobKeyPrefix(page.id, version.versionId))
    if (page.kind === 'file') {
      extractPrefixes.push(knowledgeExtractJobKey(page.id, version.versionId))
    }
  }
  const [extractJobs, embedJobs] = await Promise.all([
    jobStatusByPrefix(prisma, KNOWLEDGE_EXTRACT_TOPIC, extractPrefixes),
    jobStatusByPrefix(prisma, KNOWLEDGE_EMBED_TOPIC, embedPrefixes),
  ])

  for (const page of considered) {
    const version = versions.get(page.id)
    if (page.kind === 'document') {
      states.set(page.id, documentState(page, version, chunks, embedJobs))
    } else if (page.kind === 'spreadsheet') {
      states.set(page.id, spreadsheetState(page, version, chunks, embedJobs))
    } else {
      states.set(
        page.id,
        fileState(page, version, attachments, chunks, extractJobs, embedJobs),
      )
    }
  }
  return states
}

/** One page's state, for the routes that answer about a single item. */
export const indexingStateFor = async (
  prisma: PrismaClient,
  page: IndexingStatusPage,
): Promise<KnowledgeIndexingState> => {
  const states = await indexingStatesFor(prisma, [page])
  return states.get(page.id) ?? { state: 'not_indexed', reason: 'empty' }
}
