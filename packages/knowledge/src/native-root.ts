import type { PrismaClient } from '@prisma/client'
import type { KnowledgeRoot, KnowledgeRootSpace } from '@nessie/schemas'

import { canWriteSpace, type SpaceViewer } from './access.js'
import { ensureMyDocsSpace } from './provisioning.js'
import type { KnowledgeProvider, KnowledgeSpaceRecord } from './types.js'

/**
 * The Finder's root column in one read: My Documents, one row per project the
 * viewer belongs to, the readable folders that are neither, and the badge count
 * for "Shared with me".
 *
 * Assembling this on the client would be three round trips (`GET /spaces`,
 * `POST /my-docs`, `GET /projects`) and would put a paged list under a tree that
 * must not page.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §7.
 */

/** More than this many readable shared folders and the status bar says so. */
export const ROOT_SHARED_SPACE_CAP = 200

export type BuildKnowledgeRootInput = {
  organizationId: string
  // Where My Documents is filed when it has to be provisioned. Same source the
  // existing POST /my-docs uses: the caller's active project.
  projectId: string
  userId: string
  viewer: SpaceViewer
  provider: KnowledgeProvider
  /** `canManageKnowledgeSpaceAccess` — it needs the actor context the route holds. */
  canManageAccess: (space: KnowledgeSpaceRecord) => boolean
}

export type BuildKnowledgeRootResult = {
  root: KnowledgeRoot
  /** True only when this call provisioned My Documents — the audit event's gate. */
  myDocumentsCreated: boolean
}

const isFlagged = (metadata: unknown, flag: string): boolean =>
  typeof metadata === 'object'
  && metadata !== null
  && !Array.isArray(metadata)
  && (metadata as Record<string, unknown>)[flag] === true

const byName = (left: { name: string }, right: { name: string }): number =>
  left.name.localeCompare(right.name)

export const buildKnowledgeRoot = async (
  prisma: PrismaClient,
  input: BuildKnowledgeRootInput,
): Promise<BuildKnowledgeRootResult> => {
  const { provider, viewer } = input
  const toRootSpace = (space: KnowledgeSpaceRecord, projectName: string | null): KnowledgeRootSpace => ({
    spaceId: space.id,
    name: space.name,
    canWrite: canWriteSpace(space, viewer),
    canManageAccess: input.canManageAccess(space),
    visibility: space.visibility ?? 'private',
    writeRestricted: space.writeRestricted,
    ownerAgentId: space.ownerAgentId,
    projectId: space.projectId,
    projectName,
    updatedAt: space.updatedAt,
  })

  // My Documents is provisioned on first open by the same ensure call POST
  // /my-docs makes, so the root never shows a folder that is not there yet.
  const myDocs = await ensureMyDocsSpace(prisma, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    userId: input.userId,
  })
  const myDocsSpace = await provider.getSpace(input.organizationId, myDocs.spaceId)
  if (!myDocsSpace) throw new Error('My Documents space could not be loaded after provisioning')

  const projectIds = Array.from(viewer.projectIds)
  const [projects, projectSpaces, sharedPage, sharedWithMeCount] = await Promise.all([
    projectIds.length === 0 ? [] : prisma.project.findMany({
      where: { id: { in: projectIds }, organizationId: input.organizationId, deletedAt: null },
      select: { id: true, name: true },
    }),
    projectIds.length === 0 ? [] : prisma.knowledgeSpace.findMany({
      where: {
        organizationId: input.organizationId,
        projectId: { in: projectIds },
        deletedAt: null,
        metadata: { path: ['projectDocuments'], equals: true },
      },
      select: { id: true },
    }),
    // Personal spaces are excluded by the same flag GET /spaces uses; the
    // viewer's own is already above, and nobody else's is readable at space
    // level (a share reaches the page, not the folder).
    provider.listSpaces({
      organizationId: input.organizationId,
      limit: ROOT_SHARED_SPACE_CAP,
      viewer,
    }),
    prisma.knowledgePageShare.count({
      where: { organizationId: input.organizationId, granteeUserId: input.userId },
    }),
  ])

  const projectSpaceIds = new Set(projectSpaces.map((space) => space.id))
  const readableById = new Map(sharedPage.data.map((space) => [space.id, space]))
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  // A project's Documents space may exist without being in the capped page, so
  // load the ones that belong to a project row directly.
  const missingProjectSpaceIds = Array.from(projectSpaceIds).filter((id) => !readableById.has(id))
  const loadedProjectSpaces = await Promise.all(
    missingProjectSpaceIds.map((id) => provider.getSpace(input.organizationId, id)),
  )
  for (const space of loadedProjectSpaces) {
    if (space) readableById.set(space.id, space)
  }

  const projectRows = projects
    .map((project) => {
      const space = Array.from(readableById.values()).find(
        (candidate) => candidate.projectId === project.id && projectSpaceIds.has(candidate.id),
      ) ?? null
      return {
        projectId: project.id,
        projectName: project.name,
        space: space ? toRootSpace(space, project.name) : null,
      }
    })
    .sort((left, right) => left.projectName.localeCompare(right.projectName))

  // The third group by definition: readable, not personal, not a project's
  // Documents folder. Ad-hoc spaces and agent homes both land here.
  const shared = sharedPage.data
    .filter((space) => space.id !== myDocsSpace.id)
    .filter((space) => !isFlagged(space.metadata, 'personal'))
    .filter((space) => !isFlagged(space.metadata, 'projectDocuments'))
    .sort(byName)
    .map((space) => toRootSpace(space, projectNames.get(space.projectId) ?? null))

  const sharedProjectIds = Array.from(new Set(
    shared.filter((space) => space.projectName === null).map((space) => space.projectId),
  ))
  if (sharedProjectIds.length > 0) {
    // A shared folder's subtitle names the project it is filed under, which may
    // be a project the viewer does not belong to.
    const extra = await prisma.project.findMany({
      where: { id: { in: sharedProjectIds }, organizationId: input.organizationId },
      select: { id: true, name: true },
    })
    const extraNames = new Map(extra.map((project) => [project.id, project.name]))
    for (const space of shared) {
      if (space.projectName === null) space.projectName = extraNames.get(space.projectId) ?? null
    }
  }

  return {
    myDocumentsCreated: myDocs.created,
    root: {
      myDocuments: toRootSpace(myDocsSpace, projectNames.get(myDocsSpace.projectId) ?? null),
      projects: projectRows,
      shared,
      sharedTruncated: sharedPage.meta.hasMore,
      sharedWithMeCount,
    },
  }
}
