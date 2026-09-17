import { Prisma, type PrismaClient } from '@prisma/client'

import { indexingStatesFor } from './native-indexing-status.js'
import type { KnowledgePageRecord } from './types.js'

/**
 * The four row fields the Finder shows next to a name — mime, size, how many
 * people it is shared with, and whether it is searchable — computed for a whole
 * listing in four queries rather than per row.
 *
 * They are derived, never stored: the size is the current version's attachment
 * (or the document body's `octet_length`), the share count is the
 * `knowledge_page_shares` rows, and the indexing state is
 * `native-indexing-status.ts`'s read of chunks, embeddings and the queue.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §6.
 *
 * `transfer` is deliberately not filled here: a page's in-flight move or copy
 * belongs to the transfer subsystem, which owns that field.
 */

type CurrentVersionRow = {
  pageId: string
  attachmentId: string | null
  bodyBytes: number | null
}

export type PageRowFacts = {
  mime: string | null
  sizeBytes: string | null
  shareCount: number
}

/**
 * The size/mime/share facts for a set of pages, keyed by page id. Exposed on its
 * own because Get Info needs the same three numbers for one item without going
 * through a listing.
 */
export const pageRowFactsFor = async (
  prisma: PrismaClient,
  pages: readonly Pick<KnowledgePageRecord, 'id' | 'kind'>[],
): Promise<Map<string, PageRowFacts>> => {
  const facts = new Map<string, PageRowFacts>()
  const pageIds = pages.filter((page) => page.kind !== 'folder').map((page) => page.id)
  for (const page of pages) {
    facts.set(page.id, { mime: null, sizeBytes: null, shareCount: 0 })
  }
  if (pages.length === 0) return facts

  // The "current" version is the published one where there is one, else the
  // newest — the same version the document pane opens, so the size on the row
  // is the size of what a reader gets.
  const versions = pageIds.length === 0 ? [] : await prisma.$queryRaw<CurrentVersionRow[]>(Prisma.sql`
    SELECT DISTINCT ON (p.id)
           p.id AS "pageId",
           v.attachment_id AS "attachmentId",
           octet_length(coalesce(v.body, '')) AS "bodyBytes"
    FROM knowledge_pages p
    JOIN knowledge_page_versions v ON v.page_id = p.id
    WHERE p.id = ANY(${pageIds}::uuid[])
    ORDER BY p.id, (v.id = p.published_version_id) DESC, v.version_number DESC
  `)
  const attachmentIds = Array.from(new Set(
    versions.map((row) => row.attachmentId).filter((id): id is string => id !== null),
  ))
  const attachments = attachmentIds.length === 0 ? [] : await prisma.attachment.findMany({
    where: { id: { in: attachmentIds } },
    select: { id: true, mime: true, sizeBytes: true },
  })
  const attachmentById = new Map(attachments.map((row) => [row.id, row]))
  const shares = pageIds.length === 0 ? [] : await prisma.knowledgePageShare.groupBy({
    by: ['pageId'],
    where: { pageId: { in: pageIds } },
    _count: { _all: true },
  })
  const shareCountByPage = new Map(shares.map((row) => [row.pageId, row._count._all]))

  const versionByPage = new Map(versions.map((row) => [row.pageId, row]))
  for (const page of pages) {
    if (page.kind === 'folder') continue
    const version = versionByPage.get(page.id)
    const attachment = version?.attachmentId
      ? attachmentById.get(version.attachmentId)
      : undefined
    facts.set(page.id, {
      // A file's bytes and type are its attachment's; a document's are its
      // body's, and a document has no mime of its own.
      //
      // A spreadsheet has both: the `.xlsx` rendition on the version, and the
      // text projection in `body`. Its size is the rendition's — that is what a
      // reader downloads, and it is what `sizesFor` already counts for Get
      // Info, so a row and the panel above it agree. Its mime stays null: the
      // rendition is a rendition, and a spreadsheet is not a file node.
      mime: page.kind === 'file' ? attachment?.mime ?? null : null,
      sizeBytes: page.kind === 'file' || page.kind === 'spreadsheet'
        ? attachment?.sizeBytes.toString() ?? null
        : String(version?.bodyBytes ?? 0),
      shareCount: shareCountByPage.get(page.id) ?? 0,
    })
  }
  return facts
}

/**
 * Fills `mime`, `sizeBytes`, `shareCount` and `indexing` on a listing's records.
 * Returns new objects; the input is not mutated.
 */
export const enrichKnowledgePageRecords = async <T extends KnowledgePageRecord>(
  prisma: PrismaClient,
  pages: readonly T[],
): Promise<T[]> => {
  if (pages.length === 0) return []
  const [facts, indexing] = await Promise.all([
    pageRowFactsFor(prisma, pages),
    indexingStatesFor(prisma, pages.map((page) => ({
      id: page.id,
      kind: page.kind,
      status: page.status,
      publishedVersionId: page.publishedVersionId,
    }))),
  ])
  return pages.map((page) => {
    const row = facts.get(page.id)
    return {
      ...page,
      mime: row?.mime ?? null,
      sizeBytes: row?.sizeBytes ?? null,
      shareCount: row?.shareCount ?? 0,
      indexing: indexing.get(page.id) ?? { state: 'not_indexed' as const, reason: 'empty' as const },
    }
  })
}
