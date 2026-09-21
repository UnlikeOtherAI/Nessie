import type { PrismaClient } from '@prisma/client'
import type { DisclosureViewer } from '@nessie/runtime'
import { scopeForVisibility } from '@nessie/memory'
import type { TaskSetDisclosure, TaskSetSource } from '@nessie/schemas'
import { canReadSpace, canWriteSpace, type SpaceViewer } from './access.js'
import { mapSpace, mapVersion, spaceInclude, versionInclude } from './native-mappers.js'
import { viewerHoldsPageShare } from './page-shares.js'
import { canReadKnowledgePageVersion } from './version-disclosure-access.js'
import { TaskSetSourceError } from './task-set-records.js'

export type TaskSetKnowledgeAccess = {
  prisma: PrismaClient
  organizationId: string
  actorType: 'user' | 'agent'
  viewer: SpaceViewer
  disclosureViewer: DisclosureViewer
}

export type TaskSetResolvedSource = { attachmentId: string; disclosure: TaskSetDisclosure }

/** Exact-version content read: current home/share entitlement AND that retained version's basis. */
export const resolveTaskSetDocumentSource = async (
  access: TaskSetKnowledgeAccess, source: TaskSetSource,
): Promise<TaskSetResolvedSource> => {
  const { prisma, organizationId, viewer } = access
  const page = await prisma.knowledgePage.findFirst({
    where: { id: source.pageId, organizationId, deletedAt: null },
    select: {
      id: true, kind: true, status: true, deletedAt: true, sensitivityTier: true, privateToAgentId: true,
      space: { include: spaceInclude },
    },
  })
  if (!page || !['file', 'spreadsheet'].includes(page.kind) || page.space.deletedAt !== null) {
    throw new TaskSetSourceError('source_unavailable', 'The pinned source is unavailable.')
  }
  const space = mapSpace(page.space)
  const shared = await viewerHoldsPageShare(prisma, {
    organizationId, actorType: access.actorType, page: { ...page, deletedAt: null }, viewer, minimum: 'view',
  })
  if ((!canReadSpace(space, viewer) && !shared) || (access.actorType === 'agent' && (
    page.sensitivityTier === 'restricted'
      || (page.privateToAgentId !== null && page.privateToAgentId !== viewer.agent?.id)
  ))) throw new TaskSetSourceError('authorization_lost', 'The source document is not accessible.')
  const version = mapVersion(await prisma.knowledgePageVersion.findFirst({
    where: { id: source.versionId, pageId: source.pageId }, include: versionInclude,
  }))
  if (!version?.attachmentId) throw new TaskSetSourceError('source_unavailable', 'The pinned source version is unavailable.')
  if (!canReadKnowledgePageVersion(version, access.disclosureViewer)) {
    throw new TaskSetSourceError('authorization_lost', 'The pinned source version is not accessible.')
  }
  const home = space.ownerAgentId ? { scopeType: 'agent', scopeId: space.ownerAgentId }
    : scopeForVisibility({ ...space, visibility: space.visibility ?? 'project' })
  if (!home) throw new TaskSetSourceError('unclassified_input', 'The source home has no disclosure scope.')
  return {
    attachmentId: version.attachmentId,
    disclosure: {
      classified: true,
      basisScopes: [home, ...version.basisScopes],
      disclosureSources: version.disclosureSources,
    },
  }
}

export type TaskSetArtifactDestination = {
  projectId: string
  teamId: string | null
  spaceId: string
  parentPageId: string | null
}

/** A folder edit share allows children; a root destination always requires the space's write grant. */
export const resolveTaskSetArtifactDestination = async (
  access: TaskSetKnowledgeAccess, destination: { spaceId: string; parentId?: string },
): Promise<TaskSetArtifactDestination> => {
  const { prisma, organizationId, viewer } = access
  const row = await prisma.knowledgeSpace.findFirst({
    where: { id: destination.spaceId, organizationId, deletedAt: null }, include: spaceInclude,
  })
  if (!row) throw new TaskSetSourceError('output_unavailable', 'The output destination is unavailable.')
  const space = mapSpace(row)
  let shared = false
  if (destination.parentId) {
    const parent = await prisma.knowledgePage.findFirst({
      where: {
        id: destination.parentId, spaceId: space.id, organizationId, deletedAt: null, status: { not: 'archived' },
      },
      select: {
        id: true, kind: true, status: true, deletedAt: true, sensitivityTier: true, privateToAgentId: true,
      },
    })
    if (!parent || parent.kind !== 'folder') {
      throw new TaskSetSourceError('output_unavailable', 'Choose an existing Documents folder.')
    }
    if (access.actorType === 'agent' && (parent.sensitivityTier === 'restricted'
      || (parent.privateToAgentId !== null && parent.privateToAgentId !== viewer.agent?.id))) {
      throw new TaskSetSourceError('authorization_lost', 'The output folder is not writable by this agent.')
    }
    shared = await viewerHoldsPageShare(prisma, {
      organizationId, actorType: access.actorType, page: { ...parent, deletedAt: null }, viewer, minimum: 'edit',
    })
  }
  if ((!canWriteSpace(space, viewer) && !shared) || (
    access.actorType === 'agent' && space.sensitivityTier === 'restricted'
  )) throw new TaskSetSourceError('authorization_lost', 'The output destination is not writable.')
  return {
    projectId: space.projectId, teamId: space.teamId ?? null,
    spaceId: space.id, parentPageId: destination.parentId ?? null,
  }
}
