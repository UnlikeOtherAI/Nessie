import {
  ensureCanonicalAgentCore,
  type KnowledgeProvider,
} from '@nessie/knowledge'
import {
  attributionFromActorContext,
  type FileService,
  type LedgerAttribution,
} from '@nessie/runtime'
import {
  isAdminActor,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { listAgentsForUser } from '@nessie/team-admin'
import type { PrismaClient } from '@prisma/client'

export type AgentCoreMigrationResult = { state: 'active'; estimatedTokens: number }

/**
 * API adapter for the shared, idempotent provisioner. Human-triggered
 * creation, Designer reads and clones all enter with truthful authorship; the
 * worker uses the same provisioner with agent authorship at run admission.
 */
export const migrateLegacyAgentCoreDocuments = async (
  prisma: PrismaClient,
  provider: KnowledgeProvider,
  fileService: FileService,
  input: {
    agentId: string
    attribution: LedgerAttribution
    organizationId: string
    sourceDisclosure?: Partial<Record<
      'identity' | 'working_rules',
      {
        basisScopes?: Array<{ scopeId: string; scopeType: string }>
        disclosureSources?: Array<{ sourceAuthorUserId: string | null; sourceChannelId: string }>
      }
    >>
    userId: string
  },
): Promise<AgentCoreMigrationResult> => {
  await ensureCanonicalAgentCore(prisma, provider, fileService, {
    agentId: input.agentId,
    attribution: input.attribution,
    authorId: input.userId,
    authorType: 'user',
    organizationId: input.organizationId,
    provisionOnly: true,
    sourceDisclosure: input.sourceDisclosure,
    uploaderId: input.userId,
  })
  return { estimatedTokens: 0, state: 'active' }
}

const AGENT_PROVISION_BATCH = 8

/**
 * Repair the required files for the ordinary agents this person can reach.
 * The Finder root calls this before loading its agent-home directory, so an
 * old tenant crosses the same cutover as a newly created agent without putting
 * migration policy inside the route module.
 */
export const provisionVisibleAgentCoreDocuments = async (
  prisma: PrismaClient,
  provider: KnowledgeProvider,
  fileService: FileService,
  input: {
    actorContext: AuthorizedActionContext
    limit: number
  },
): Promise<Array<{ agentId: string | undefined; error: unknown }>> => {
  const { actorContext } = input
  const entitledAgents = await listAgentsForUser(
    prisma,
    actorContext.actor.actorId,
    actorContext.tenant.organizationId,
    isAdminActor(actorContext),
  )
  const visibleAgents = await prisma.agent.findMany({
    where: {
      id: { in: entitledAgents.map((agent) => agent.id) },
      organizationId: actorContext.tenant.organizationId,
      systemManaged: false,
    },
    select: { id: true },
  })
  const markers = await prisma.agentCoreDocumentMigration.findMany({
    where: { agentId: { in: visibleAgents.map((agent) => agent.id) } },
    select: { agentId: true, documentCount: true },
  })
  const complete = new Set(
    markers.filter((marker) => marker.documentCount === 2).map((marker) => marker.agentId),
  )
  const incomplete = visibleAgents
    .filter((agent) => !complete.has(agent.id))
    .slice(0, input.limit)
  const failures: Array<{ agentId: string | undefined; error: unknown }> = []
  for (let index = 0; index < incomplete.length; index += AGENT_PROVISION_BATCH) {
    const batch = incomplete.slice(index, index + AGENT_PROVISION_BATCH)
    const outcomes = await Promise.allSettled(batch.map((agent) =>
      migrateLegacyAgentCoreDocuments(prisma, provider, fileService, {
        agentId: agent.id,
        attribution: attributionFromActorContext(actorContext),
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      })))
    outcomes.forEach((outcome, outcomeIndex) => {
      if (outcome.status === 'rejected') {
        failures.push({ agentId: batch[outcomeIndex]?.id, error: outcome.reason })
      }
    })
  }
  return failures
}
