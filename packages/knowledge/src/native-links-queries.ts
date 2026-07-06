import { Prisma, type PrismaClient } from '@prisma/client'
import { readableSpaceIdsSqlForViewer } from './native-search-access.js'
import type { SpaceViewer } from './access.js'

const DEFAULT_BACKLINKS_LIMIT = 50
const DEFAULT_MENTIONS_LIMIT = 20
// Below this length a title is too common a substring to be a meaningful
// "unlinked mention" signal (e.g. a one/two-letter page title would ILIKE-match
// almost every chunk in the org).
const MIN_MENTION_TITLE_LENGTH = 3

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

export type MentionRow = {
  pageId: string
  title: string
  spaceId: string
}

export type ListUnlinkedMentionsInput = {
  organizationId: string
  pageId: string
  viewer?: SpaceViewer
  limit?: number
}

// Pages whose latest-version content mentions the target page's title in
// plain text but do not yet carry a wikilink to it — the "you might want to
// link this" surface. Only the latest version's chunks are considered
// (mirrors the latest-version join in native-search-hybrid.ts); pages that
// already link to the target are excluded so this never duplicates backlinks.
export const listUnlinkedMentions = async (
  prisma: PrismaClient,
  input: ListUnlinkedMentionsInput,
): Promise<MentionRow[]> => {
  const page = await prisma.knowledgePage.findFirst({
    where: { id: input.pageId, organizationId: input.organizationId, deletedAt: null },
    select: { title: true },
  })
  const title = page?.title.trim() ?? ''
  if (title.length < MIN_MENTION_TITLE_LENGTH) return []

  const limit = input.limit ?? DEFAULT_MENTIONS_LIMIT
  const likeTitle = `%${title}%`
  const spaceFilter = input.viewer
    ? readableSpaceIdsSqlForViewer(input.organizationId, input.viewer)
    : null
  return prisma.$queryRaw<MentionRow[]>(Prisma.sql`
    SELECT p.id AS "pageId", p.title, p.space_id AS "spaceId"
    FROM knowledge_page_chunks c
    JOIN knowledge_pages p ON p.id = c.page_id
    JOIN LATERAL (
      SELECT id FROM knowledge_page_versions v
      WHERE v.page_id = c.page_id
      ORDER BY v.version_number DESC
      LIMIT 1
    ) lv ON lv.id = c.version_id
    WHERE c.organization_id = ${input.organizationId}::uuid
      AND p.id <> ${input.pageId}::uuid
      AND p.deleted_at IS NULL
      AND p.status <> 'archived'::"KnowledgePageStatus"
      AND c.content ILIKE ${likeTitle}
      ${spaceFilter ? Prisma.sql`AND p.space_id IN (${spaceFilter})` : Prisma.empty}
      AND NOT EXISTS (
        SELECT 1 FROM knowledge_page_links l
        WHERE l.source_page_id = p.id AND l.target_page_id = ${input.pageId}::uuid
      )
    GROUP BY p.id, p.title, p.space_id
    LIMIT ${limit}
  `)
}
