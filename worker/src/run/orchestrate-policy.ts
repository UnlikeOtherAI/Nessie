import { createHash } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { z } from 'zod'
import {
  attributionFromActorContext, decideChannelActions, resolveMentionedAgentDecisions,
  type DecisionModelClient, type OrchestratorDecision,
} from '@nessie/runtime'
import {
  AuthorizedActionContextSchema,
  type AuthorizedActionContext, type ChannelDecisionPolicy, type OrchestrateDecideJobPayload,
} from '@nessie/schemas'
import { matchesChannelDecisionTarget } from '@nessie/team-admin'
import { asEngagementCandidate } from './orchestrate-candidates.js'
import type { loadOrchestrationContext } from './orchestrate-context.js'
import { BasisScopeSchema, PrivateConversationSourceSchema } from './execute/disclosure-basis.js'

const IdentityShape = { agentId: z.string().uuid(), principalUserId: z.string().uuid().optional() }
const SnapshotSchema = z.object({
  policyFingerprint: z.string(),
  authorizer: AuthorizedActionContextSchema.nullable(),
  basisScopes: z.array(BasisScopeSchema),
  disclosureSources: z.array(PrivateConversationSourceSchema),
  decisions: z.array(z.discriminatedUnion('action', [
    z.object({ action: z.literal('none') }),
    z.object({ action: z.literal('acknowledge'), ...IdentityShape, emoji: z.string() }),
    z.object({
      action: z.literal('reply'), ...IdentityShape,
      replyPlacement: z.enum(['thread', 'channel']).optional(),
      promptOverride: z.string().optional(), background: z.boolean().optional(),
      policyWork: z.boolean().optional(),
    }),
  ])),
})

/** One pinned result per message: retries never reinterpret a changed policy. */
export const evaluateChannelPolicy = async (
  deps: { prisma: PrismaClient; decisionClient?: DecisionModelClient },
  input: {
    payload: OrchestrateDecideJobPayload
    policy: ChannelDecisionPolicy
    authorizer: unknown
    snapshot: unknown
    structuralDecisions: OrchestratorDecision[] | null
    context: Awaited<ReturnType<typeof loadOrchestrationContext>>
    restrictedTrigger: boolean
  },
): Promise<{ decisions: OrchestratorDecision[]; authorizer: AuthorizedActionContext | null }> => {
  const { payload, policy } = input
  const bindings = await deps.prisma.agentBinding.findMany({
    where: {
      channelId: payload.channelId,
      agent: { organizationId: payload.actorContext.tenant.organizationId, visibility: { not: 'private' } },
    },
    select: { agentId: true, principalUserId: true },
  })
  const agents = payload.channelAgents.filter((agent) => bindings.some((binding) =>
    matchesChannelDecisionTarget({ agentId: agent.id, principalUserId: agent.principalUserId }, binding)))
  const stillBound = (decisions: OrchestratorDecision[]): OrchestratorDecision[] =>
    decisions.filter((decision) => decision.action !== 'none' && agents.some((agent) =>
      agent.id === decision.agentId && agent.principalUserId === decision.principalUserId))
  if (input.snapshot != null) {
    const saved = SnapshotSchema.parse(input.snapshot)
    return { decisions: stillBound(saved.decisions), authorizer: saved.authorizer }
  }
  const structuralDecisions = input.structuralDecisions
    ?? (payload.agentMentions?.length ? resolveMentionedAgentDecisions(agents, payload.agentMentions) : null)
  // A public acknowledgement must not encode a judgment made from restricted
  // input. Explicit addressing still enters the normal run disclosure pipeline.
  if (input.restrictedTrigger) return { decisions: stillBound(structuralDecisions ?? []), authorizer: null }
  if (!deps.decisionClient) throw new Error('Channel decisions require the Ledger evaluation service.')
  const decisions = await decideChannelActions(deps.decisionClient, {
    policy, agents: agents.map(asEngagementCandidate),
    agentMentions: payload.agentMentions,
    ...(structuralDecisions ? { structuralDecisions } : {}),
    ...input.context,
    triggerIsHuman: payload.role === 'user',
    usage: attributionFromActorContext(payload.actorContext, { systemComponent: 'channel-decisions' }),
  })
  const snapshot = {
    policyFingerprint: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
    authorizer: AuthorizedActionContextSchema.nullable().parse(input.authorizer ?? null),
    basisScopes: input.context.basisScopes,
    disclosureSources: input.context.disclosureSources,
    decisions,
  }
  const claimed = await deps.prisma.message.updateMany({
    where: { id: payload.messageId, channelDecision: { equals: Prisma.DbNull } },
    data: { channelDecision: snapshot as Prisma.InputJsonValue },
  })
  if (claimed.count === 1) return { decisions: stillBound(decisions), authorizer: snapshot.authorizer }
  const winner = await deps.prisma.message.findUniqueOrThrow({
    where: { id: payload.messageId }, select: { channelDecision: true },
  })
  const saved = SnapshotSchema.parse(winner.channelDecision)
  return { decisions: stillBound(saved.decisions), authorizer: saved.authorizer }
}
