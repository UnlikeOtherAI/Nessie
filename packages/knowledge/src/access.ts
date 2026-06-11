import type { PrismaClient } from '@prisma/client'
import type { KnowledgeSpaceRecord } from './types.js'

// Per-space access. The space creator always has full access. Non-human actors
// (agents / services) bypass per-user checks for now; fine-grained agent access
// lands with the MCP / agent-tools phase.
export type SpaceViewer = {
  bypass: boolean
  projectIds: Set<string>
  userId: string | null
}

type SpaceAccessFacts = Pick<
  KnowledgeSpaceRecord,
  'visibility' | 'writeRestricted' | 'projectId' | 'createdBy' | 'memberUserIds'
>

const isMember = (space: SpaceAccessFacts, viewer: SpaceViewer): boolean =>
  viewer.userId !== null && space.memberUserIds.includes(viewer.userId)

const isCreator = (space: SpaceAccessFacts, viewer: SpaceViewer): boolean =>
  viewer.userId !== null && space.createdBy === viewer.userId

export const canReadSpace = (space: SpaceAccessFacts, viewer: SpaceViewer): boolean => {
  if (viewer.bypass) return true
  if (isCreator(space, viewer)) return true
  switch (space.visibility) {
    case 'organization':
      return true
    case 'project':
      return viewer.projectIds.has(space.projectId)
    default:
      // private / channel / team → explicit members only
      return isMember(space, viewer)
  }
}

export const canWriteSpace = (space: SpaceAccessFacts, viewer: SpaceViewer): boolean => {
  if (viewer.bypass) return true
  if (isCreator(space, viewer)) return true
  // "public read-only, private write": readable per visibility, written by members.
  if (space.writeRestricted) return isMember(space, viewer)
  switch (space.visibility) {
    case 'organization':
      return true
    case 'project':
      return viewer.projectIds.has(space.projectId)
    default:
      return isMember(space, viewer)
  }
}

export const loadSpaceViewer = async (
  prisma: PrismaClient,
  userId: string | null,
  bypass: boolean,
): Promise<SpaceViewer> => {
  if (bypass || userId === null) {
    return { bypass: true, projectIds: new Set(), userId }
  }
  const memberships = await prisma.projectMember.findMany({
    select: { projectId: true },
    where: { userId },
  })
  return {
    bypass: false,
    projectIds: new Set(memberships.map((m) => m.projectId)),
    userId,
  }
}
