import { Prisma, type PrismaClient } from '@prisma/client'
import { readableSpaceIdsSqlForViewer } from './native-search-access.js'
import type { SpaceViewer } from './access.js'

const DEFAULT_BACKLINKS_LIMIT = 50

export type BacklinkRow = {
  pageId: string
  title: string
  spaceId: string
  snippet: string | null
}

export type ListBacklinksInput = {
  organizationId: string
  pageId: string
  viewer?: SpaceViewer
  limit?: number
}

// Pages that explicitly link to `pageId` via a resolved wikilink. ACL is
// enforced the same way native search scopes results: a `space_id IN (...)`
// pre-filter built from the viewer, skipped entirely for bypass viewers.
export const listBacklinks = async (
  prisma: PrismaClient,
  input: ListBacklinksInput,
): Promise<BacklinkRow[]> => {
  const limit = input.limit ?? DEFAULT_BACKLINKS_LIMIT
  const spaceFilter = input.viewer
    ? readableSpaceIdsSqlForViewer(input.organizationId, input.viewer)
    : null
  return prisma.$queryRaw<BacklinkRow[]>(Prisma.sql`
    SELECT p.id AS "pageId", p.title, p.space_id AS "spaceId", p.summary AS snippet
    FROM knowledge_page_links l
    JOIN knowledge_pages p ON p.id = l.source_page_id
    WHERE l.organization_id = ${input.organizationId}::uuid
      AND l.target_page_id = ${input.pageId}::uuid
      AND p.deleted_at IS NULL
      AND p.status <> 'archived'::"KnowledgePageStatus"
      ${spaceFilter ? Prisma.sql`AND p.space_id IN (${spaceFilter})` : Prisma.empty}
    ORDER BY p.updated_at DESC
    LIMIT ${limit}
  `)
}
