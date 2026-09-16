import type { FastifyInstance } from 'fastify'
import {
  indexingStatesFor,
  listSharesForGrantee,
  mapPage,
  pageAncestorPaths,
  pageInclude,
} from '@nessie/knowledge'
import {
  KnowledgeSharedRowSchema,
  KnowledgeSharedWithMeQuerySchema,
  buildPage,
  decodeKeysetCursor,
  resolvePageLimit,
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

/**
 * A shared row's searchability is derived by the one shared derivation
 * (`indexingStatesFor`), which reads the chunk mirror *and* the extract/embed
 * queue jobs, so a row can tell `failed` from `pending` and `unsupported` from
 * "not extracted yet".
 *
 * The caveat that matters to a recipient is elsewhere and unconditional: a
 * shared page is never in *their* search, whatever this says. The chunk scope
 * mirror has no per-person arm and this design deliberately does not add one.
 */

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
    // A virtual folder pages 50 at a time, not the instance's 25: this is a
    // Finder column being scrolled, not a table being read a page at a time.
    const limit = resolvePageLimit(query.limit ?? 50)
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
    const indexing = await indexingStatesFor(prisma, [...pages.values()].map((record) => ({
      id: record.id,
      kind: record.kind,
      status: record.status,
      publishedVersionId: record.publishedVersionId,
    })))
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
        indexing: indexing.get(record.id) ?? { state: 'not_applicable' },
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
