import type { Prisma, PrismaClient } from '@prisma/client'
import { listVisibleAgentIdsForUser, visibleKnowledgeSpaceWhere } from '@nessie/db'
import type { KnowledgeSpaceRecord } from './types.js'

// Per-space access. The space creator always has full access. `bypass` is now
// reserved for genuine service/system actors (workers acting outside any
// principal, scheduled jobs, migrations) — user and agent viewers are always
// evaluated against the real access rules below.
export type SpaceViewerAgentScopes = {
  id: string
  parentAgentId: string | null
  // True when the agent has at least one channel binding in this org — grants
  // organization-visibility spaces, mirroring "every human in the org can read
  // an org-visibility space."
  orgBound: boolean
  channelIds: Set<string>
  teamIds: Set<string>
  projectIds: Set<string>
  // Spaces the agent was explicitly granted via KnowledgeSpaceMember.
  memberSpaceIds: Set<string>
}

export type SpaceViewer = {
  bypass: boolean
  userId: string | null
  projectIds: Set<string>
  visibleAgentIds: Set<string>
  agent?: SpaceViewerAgentScopes
}

export type SpaceViewerPrincipal =
  | { actorType: 'user'; actorId: string }
  | { actorType: 'agent'; actorId: string }
  | { actorType: 'service'; actorId: string | null }

type SpaceAccessFacts = Pick<
  KnowledgeSpaceRecord,
  | 'visibility'
  | 'writeRestricted'
  | 'projectId'
  | 'teamId'
  | 'channelId'
  | 'createdBy'
  | 'memberUserIds'
  | 'memberAgentIds'
  | 'sensitivityTier'
  | 'privateToAgentId'
  | 'ownerAgentId'
>

const isMember = (space: SpaceAccessFacts, viewer: SpaceViewer): boolean =>
  viewer.userId !== null && space.memberUserIds.includes(viewer.userId)

const isCreator = (space: SpaceAccessFacts, viewer: SpaceViewer): boolean =>
  viewer.userId !== null && space.createdBy === viewer.userId

// Rules 2-4 of the agent access model: private-to-this-agent, creator, an
// explicit KnowledgeSpaceMember grant, or proprietorship of the agent's own
// documents home (including a spawn_subtask child's parent). Shared by read
// and write so the plan's §4.1/§4.2 permissions cannot diverge.
const agentHasExplicitGrant = (
  space: SpaceAccessFacts,
  agent: SpaceViewerAgentScopes,
): boolean =>
  space.privateToAgentId === agent.id ||
  space.createdBy === agent.id ||
  space.memberAgentIds.includes(agent.id) ||
  // A child works in its parent's home rather than receiving a second space;
  // see docs/plans/2026-08-31-agent-documents.md §4.1.
  space.ownerAgentId === agent.id ||
  (agent.parentAgentId !== null && space.ownerAgentId === agent.parentAgentId)

// Rule 5: fall back to visibility-scoped reach when there is no explicit
// grant. `private` visibility is members-only, so it has no agent arm here.
const agentReachesByVisibility = (
  space: SpaceAccessFacts,
  agent: SpaceViewerAgentScopes,
): boolean => {
  switch (space.visibility) {
    case 'organization':
      return agent.orgBound
    case 'project':
      return agent.projectIds.has(space.projectId)
    case 'team':
      return typeof space.teamId === 'string' && agent.teamIds.has(space.teamId)
    case 'channel':
      return typeof space.channelId === 'string' && agent.channelIds.has(space.channelId)
    default:
      return false
  }
}

const canAgentReadSpace = (
  space: SpaceAccessFacts,
  agent: SpaceViewerAgentScopes,
): boolean => {
  // Restricted content is humans-only: this wins over every other agent arm,
  // including the agent's own private space or explicit membership.
  if (space.sensitivityTier === 'restricted') return false
  return agentHasExplicitGrant(space, agent) || agentReachesByVisibility(space, agent)
}

const canAgentWriteSpace = (
  space: SpaceAccessFacts,
  agent: SpaceViewerAgentScopes,
): boolean => {
  if (space.sensitivityTier === 'restricted') return false
  if (space.writeRestricted) return agentHasExplicitGrant(space, agent)
  return agentHasExplicitGrant(space, agent) || agentReachesByVisibility(space, agent)
}

export const canReadSpace = (space: SpaceAccessFacts, viewer: SpaceViewer): boolean => {
  if (viewer.bypass) return true
  if (viewer.agent) return canAgentReadSpace(space, viewer.agent)
  if (space.ownerAgentId !== null) {
    // Agent homes derive their audience from live agent visibility; stored
    // `private` is only the fail-closed floor. Explicit human membership stays
    // a deliberate grant. Never fall through (agent-documents.md §4.1).
    return viewer.visibleAgentIds.has(space.ownerAgentId) || isMember(space, viewer)
  }
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
  if (viewer.agent) return canAgentWriteSpace(space, viewer.agent)
  if (space.ownerAgentId !== null) {
    // `writeRestricted` is the steward's explicit narrowing switch and wins
    // over read-derived access. Otherwise colleagues who can see the agent may
    // edit its notebook; see agent-documents.md §4.2.
    if (space.writeRestricted) return isMember(space, viewer)
    return viewer.visibleAgentIds.has(space.ownerAgentId) || isMember(space, viewer)
  }
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

// Query-time counterpart of canReadSpace. Lists must apply the same decision
// before pagination: filtering a single arbitrary page in memory can hide a
// readable private space behind a page of newer inaccessible ones.
//
// The user arm delegates to @nessie/db's shared agent-visibility-aware
// predicate. The agent arm mirrors canAgentReadSpace structurally; agents do
// not have a reusable database predicate because their reach is assembled
// from bindings when the viewer is loaded.
export const readableKnowledgeSpaceWhere = (
  organizationId: string,
  viewer: SpaceViewer,
): Prisma.KnowledgeSpaceWhereInput | null => {
  if (viewer.bypass) return null
  if (!viewer.agent) {
    if (viewer.userId === null) return { id: { in: [] } }
    return visibleKnowledgeSpaceWhere({ organizationId, userId: viewer.userId })
  }

  const { agent } = viewer
  const ownerAgentIds = [agent.id, ...(agent.parentAgentId ? [agent.parentAgentId] : [])]
  const reach: Prisma.KnowledgeSpaceWhereInput[] = [
    { privateToAgentId: agent.id },
    { createdBy: agent.id },
    { ownerAgentId: { in: ownerAgentIds } },
    { members: { some: { agentId: agent.id } } },
  ]
  if (agent.orgBound) reach.push({ visibility: 'organization' })
  if (agent.projectIds.size > 0) {
    reach.push({ visibility: 'project', projectId: { in: Array.from(agent.projectIds) } })
  }
  if (agent.teamIds.size > 0) {
    reach.push({ visibility: 'team', teamId: { in: Array.from(agent.teamIds) } })
  }
  if (agent.channelIds.size > 0) {
    reach.push({ visibility: 'channel', channelId: { in: Array.from(agent.channelIds) } })
  }
  return {
    organizationId,
    deletedAt: null,
    sensitivityTier: { not: 'restricted' },
    OR: reach,
  }
}

const loadUserViewer = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
): Promise<SpaceViewer> => {
  const [memberships, visibleAgentIds] = await Promise.all([
    prisma.projectMember.findMany({
      select: { projectId: true },
      // A user can be a member of projects in more than one organization.
      // The active organization is an authorization boundary, so a project
      // membership from another organization must never widen this viewer.
      where: { userId, project: { organizationId } },
    }),
    listVisibleAgentIdsForUser(prisma, { organizationId, userId }),
  ])
  return {
    bypass: false,
    userId,
    projectIds: new Set(memberships.map((m) => m.projectId)),
    visibleAgentIds: new Set(visibleAgentIds),
  }
}

const loadAgentViewer = async (
  prisma: PrismaClient,
  organizationId: string,
  agentId: string,
): Promise<SpaceViewer> => {
  // One tenant-scoped agent read carries the parent, binding reach, and
  // explicit grants together. Besides avoiding another round trip, this makes
  // a missing/cross-tenant principal fail closed before any access predicate.
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, organizationId },
    select: {
      parentAgentId: true,
      bindings: {
        where: { channel: { organizationId } },
        select: {
          channelId: true,
          channel: { select: { teamId: true, projectId: true } },
        },
      },
      knowledgeSpaceMemberships: {
        where: { organizationId },
        select: { spaceId: true },
      },
    },
  })
  if (!agent) throw new Error('Agent viewer not found in organization')

  const channelIds = new Set<string>()
  const teamIds = new Set<string>()
  const projectIds = new Set<string>()
  for (const binding of agent.bindings) {
    channelIds.add(binding.channelId)
    teamIds.add(binding.channel.teamId)
    projectIds.add(binding.channel.projectId)
  }
  return {
    bypass: false,
    userId: null,
    projectIds: new Set(),
    visibleAgentIds: new Set(),
    agent: {
      id: agentId,
      parentAgentId: agent.parentAgentId,
      orgBound: agent.bindings.length > 0,
      channelIds,
      teamIds,
      projectIds,
      memberSpaceIds: new Set(agent.knowledgeSpaceMemberships.map((m) => m.spaceId)),
    },
  }
}

// Resolves the access facts for one principal, once per request. Service
// actors (workers acting outside any user/agent, migrations, system jobs)
// bypass per-space checks entirely; users and agents are always evaluated
// against `canReadSpace` / `canWriteSpace`.
export const loadSpaceViewer = async (
  prisma: PrismaClient,
  organizationId: string,
  principal: SpaceViewerPrincipal,
): Promise<SpaceViewer> => {
  if (principal.actorType === 'service') {
    return {
      bypass: true,
      userId: null,
      projectIds: new Set(),
      visibleAgentIds: new Set(),
    }
  }
  if (principal.actorType === 'user') {
    return loadUserViewer(prisma, organizationId, principal.actorId)
  }
  return loadAgentViewer(prisma, organizationId, principal.actorId)
}
