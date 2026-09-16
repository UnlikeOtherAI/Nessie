import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import {
  listSharesForGrantee,
  mapPage,
  pageAncestorPaths,
  pageInclude,
  type KnowledgePageRecord,
} from '@nessie/knowledge'
import {
  KnowledgeSharedRowSchema,
  KnowledgeSharedWithMeQuerySchema,
  buildPage,
  decodeKeysetCursor,
  resolvePageLimit,
  type KnowledgeIndexingState,
  type KnowledgeSharedRow,
} from '@nessie/schemas'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  createKnowledgeAccess,
  requireKnowledgePolicy,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'

/**
 * The Shared with me virtual folder: pages other people shared with the viewer,
 * newest share first.
 *
 * Deliberately *not* spaces somebody added the viewer to — those are already
 * folders in the root's shared group, and listing them here too would show the
 * same thing twice under two different names.
 *
 * A shared folder is one row; opening it lists its children through
 * `GET /spaces/:spaceId/pages?sharedRootPageId=<folderId>`, which the grantee
 * may call although the space is private to the sharer. Without the param the
 * 403 stands.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §4.
 */

type IndexingFacts = {
  chunks: number
  unembedded: number
}

/**
 * What a shared row may honestly say about being searchable, derived from the
 * chunk mirror alone.
 *
 * Wave 1A owns the full derivation (`indexingStatesFor`), which additionally
 * reads the extract/embed queue jobs and can therefore distinguish `failed`
 * from `pending` and `unsupported` from "not extracted yet". This is the subset
 * that needs no queue read; swapping it for that function is a one-line change
 * once both waves are integrated, and every state it does produce is one that
 * function also produces.
 *
 * The caveat that matters to a recipient is elsewhere and unconditional: a
 * shared page is never in *their* search, whatever this says. The chunk scope
 * mirror has no per-person arm and this wave deliberately does not add one.
 */
const indexingStateFor = (
  page: KnowledgePageRecord,
  facts: IndexingFacts | undefined,
): KnowledgeIndexingState => {
  if (page.kind === 'folder') return { state: 'not_applicable' }
  // Documents are chunked on publish, not on save, so a draft has no chunks and
  // never will until somebody publishes it.
  if (page.kind === 'document' && page.status !== 'published') {
    return { state: 'not_indexed', reason: 'draft' }
  }
  const versionId = page.publishedVersion?.id ?? page.latestVersion?.id ?? null
  if (!facts || facts.chunks === 0) {
    return page.kind === 'file'
      ? { state: 'pending', stage: 'extract' }
      : { state: 'not_indexed', reason: 'empty' }
  }
  if (facts.unembedded > 0) return { state: 'pending', stage: 'embed' }
  return versionId ? { state: 'indexed', versionId } : { state: 'not_indexed', reason: 'empty' }
}

const indexingFacts = async (
  prisma: PrismaClient,
  organizationId: string,
  versionIds: readonly string[],
): Promise<Map<string, IndexingFacts>> => {
  const facts = new Map<string, IndexingFacts>()
  if (versionIds.length === 0) return facts
  // `embedding` is an unsupported vector column, so the null count cannot be
  // expressed through the Prisma client. One grouped raw query for the whole
  // page, never one per row.
  const rows = await prisma.$queryRaw<{
    version_id: string
    chunks: bigint
    unembedded: bigint
  }[]>`
    SELECT version_id,
           COUNT(*) AS chunks,
           COUNT(*) FILTER (WHERE embedding IS NULL) AS unembedded
      FROM knowledge_page_chunks
     WHERE organization_id = ${organizationId}::uuid
       AND version_id = ANY(${versionIds}::uuid[])
     GROUP BY version_id
  `
  for (const row of rows) {
    facts.set(row.version_id, { chunks: Number(row.chunks), unembedded: Number(row.unembedded) })
  }
  return facts
}

export const registerKnowledgeSharedWithMeRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
): void => {
  const { prisma, requireActorContext } = deps
  const { buildViewer, filterReadablePages } = createKnowledgeAccess(deps)

  app.get('/api/knowledge-base/shared-with-me', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const query = parseInput(KnowledgeSharedWithMeQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'view')
    if (!decision) return reply
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(
        reply,
        403,
        'ACTOR_TYPE_NOT_ALLOWED',
        'Only a person can be shared a document',
      )
      return reply
    }
    const viewer = await buildViewer(actorContext)
    // A viewer without a live organization proof holds nothing: a share can
    // narrow an entitlement, never stand in for one.
    if (viewer.baseEntitled === false || viewer.userId === null) {
      return createApiResponse([], { hasMore: false, nextCursor: null, prevCursor: null })
    }
    const { organizationId } = actorContext.tenant
    const limit = resolvePageLimit(query.limit)
    const cursor = decodeKeysetCursor(query.cursor)
    const shares = await listSharesForGrantee(prisma, {
      organizationId,
      userId: viewer.userId,
      cursor,
      take: limit + 1,
    })
    const page = buildPage({ hasCursor: cursor !== null, limit, rows: shares })
    if (page.data.length === 0) return createApiResponse([], page.meta)

    const pageRows = await prisma.knowledgePage.findMany({
      where: { id: { in: page.data.map((share) => share.pageId) }, organizationId },
      include: pageInclude,
    })
    const pages = new Map(pageRows.map((row) => [row.id, mapPage(row)]))
    // The same version-basis check every read path applies: a shared page whose
    // retained versions acquired a basis the recipient cannot read stops being
    // listed rather than leaking its title.
    const readable = new Set(
      (await filterReadablePages(viewer, [...pages.values()])).map((record) => record.id),
    )

    const spaceIds = [...new Set([...pages.values()].map((record) => record.spaceId))]
    const spaces = await prisma.knowledgeSpace.findMany({
      where: { id: { in: spaceIds }, organizationId },
      select: {
        id: true,
        name: true,
        projectId: true,
        ownerAgentId: true,
        metadata: true,
        project: { select: { name: true } },
      },
    })
    const spacesById = new Map(spaces.map((space) => [space.id, space]))
    const paths = await pageAncestorPaths(prisma, {
      organizationId,
      pageIds: [...pages.keys()],
    })
    const versionIds = [...pages.values()]
      .map((record) => record.publishedVersion?.id ?? record.latestVersion?.id ?? null)
      .filter((id): id is string => id !== null)
    const facts = await indexingFacts(prisma, organizationId, versionIds)
    const attachmentIds = [...pages.values()]
      .map((record) => record.publishedVersion?.attachmentId ?? record.latestVersion?.attachmentId ?? null)
      .filter((id): id is string => id !== null)
    const attachments = attachmentIds.length === 0
      ? []
      : await prisma.attachment.findMany({
        where: { id: { in: attachmentIds }, organizationId },
        select: { id: true, mime: true, sizeBytes: true },
      })
    const attachmentsById = new Map(attachments.map((attachment) => [attachment.id, attachment]))

    const rows: KnowledgeSharedRow[] = []
    for (const share of page.data) {
      const record = pages.get(share.pageId)
      if (!record || !readable.has(record.id)) continue
      const space = spacesById.get(record.spaceId)
      if (!space) continue
      const version = record.publishedVersion ?? record.latestVersion
      const attachment = version?.attachmentId
        ? attachmentsById.get(version.attachmentId) ?? null
        : null
      rows.push(KnowledgeSharedRowSchema.parse({
        id: record.id,
        kind: record.kind,
        title: record.title,
        status: record.status,
        mime: attachment?.mime ?? null,
        // A file's bytes are its attachment's; a document's are its body's, and
        // `sizeBytes` crosses the wire as a decimal string because the ledger's
        // counterpart is a BigInt (docs/standards/file-storage.md).
        sizeBytes: attachment
          ? attachment.sizeBytes.toString()
          : record.kind === 'document' && version?.body
            ? String(Buffer.byteLength(version.body, 'utf8'))
            : null,
        createdBy: record.createdBy,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        indexing: indexingStateFor(record, version ? facts.get(version.id) : undefined),
        home: {
          spaceId: space.id,
          spaceName: space.name,
          // A share only ever lives in the sharer's personal documents, so the
          // recipient's home line names them, not a root folder of their own.
          rootKind: 'personal',
          projectId: space.projectId,
          projectName: space.project?.name ?? null,
          ownerAgentId: space.ownerAgentId,
          parentPath: paths.get(record.id) ?? [],
        },
        access: share.access,
        sharedAt: share.createdAt.toISOString(),
        sharedByUserId: share.grantedByUserId,
      }))
    }
    return createApiResponse(rows, page.meta)
  })
}
