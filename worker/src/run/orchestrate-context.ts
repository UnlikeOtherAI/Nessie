import {
  partitionByDisclosure, resolveDisclosureViewer, selectFollowingAgentIds,
  originalHumanAuthorId,
} from '@nessie/runtime'
import type { OrchestrateDecideJobPayload } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import { describeAttachments, loadMessageAttachments } from './message-attachments.js'
import { engagementIdFor } from './orchestrate-candidates.js'

/** Loads the decision window once, under the triggering person's live visibility. */
export const loadOrchestrationContext = async (
  deps: { prisma: PrismaClient },
  payload: OrchestrateDecideJobPayload,
  channel: { organizationId: string; visibility?: string },
  replyRootContextId?: string,
  policyDecision = false,
  triggerCreatedAt?: Date,
) => {
  const { actorContext, channelAgents, content, messageId, role, threadId } = payload
  // Exclude the trigger by identity: another turn can arrive before this job runs.
  const recentDbMessages = await deps.prisma.message.findMany({
    where: { threadId, ...(triggerCreatedAt ? { createdAt: { lte: triggerCreatedAt } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 6,
    include: {
      agent: { select: { name: true } },
      basisScopes: { select: { scopeType: true, scopeId: true } },
      disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
    },
  })

  // The window the *run* reads is disclosure-filtered (`prompt.ts`); this one
  // was not, so the engagement judgement for one person's message could be
  // formed over another person's restricted exchange. It decides only whether
  // and where to reply, but a judgement is still a reading, and the two
  // windows disagreeing about what exists is its own defect. Withheld turns
  // are dropped rather than placeheld: there is no reader here to show a
  // placeholder to.
  const viewer = await resolveDisclosureViewer(
    deps.prisma,
    channel.organizationId,
    actorContext.actionContext.effectiveUserId
      ?? (actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : undefined),
    {
      agentId: actorContext.actor.actorType === 'agent'
        ? actorContext.actor.actorId
        : actorContext.actionContext.agentId,
      uoaIdentity: actorContext.actionContext.uoaIdentity,
    },
  )
  const visible = partitionByDisclosure(recentDbMessages, viewer).visible
  // Policy effects can include a public reaction. Do not derive those effects
  // from turns restricted beyond the room, even when the requester can read them.
  const recentOrdered = visible.filter((message) =>
    !policyDecision || message.basisScopes.length === 0).reverse()
  // A message can be nothing but a photo. Naming its files gives the
  // engagement judgement something to read — without an inventory line an
  // image-only post looks like an empty message and nobody answers it.
  const attachments = await loadMessageAttachments(
    deps.prisma,
    channel.organizationId,
    [...recentOrdered.map((m) => m.id), messageId],
  )
  const annotate = (messageContent: string, id: string): string => {
    const note = describeAttachments(attachments.get(id) ?? [])
    if (!note) return messageContent
    return messageContent.trim() ? `${messageContent}\n${note}` : note
  }

  const recentMessages = recentOrdered
    .filter((message) => message.id !== messageId)
    .map((m) => ({
      role: m.role,
      content: annotate(m.content, m.id),
      agentName: m.agent?.name ?? undefined,
    }))

  // Thread-following remains local to the reply thread when one is active.
  const triggerIsHuman = role === 'user'
  let followingAgentIds: string[] = []
  if (triggerIsHuman) {
    const candidateAgentIds = channelAgents.map((agent) => agent.id)
    const authored = await deps.prisma.message.findMany({
      where: {
        threadId,
        role: 'assistant',
        agentId: { in: candidateAgentIds },
        ...(replyRootContextId
          ? { OR: [{ rootMessageId: replyRootContextId }, { id: replyRootContextId }] }
          : {}),
      },
      distinct: ['agentId', 'onBehalfOfUserId'],
      select: { agentId: true, onBehalfOfUserId: true },
    })
    followingAgentIds = selectFollowingAgentIds(
      channelAgents.map(engagementIdFor),
      authored.flatMap((message) => {
        if (!message.agentId) return []
        const candidate = channelAgents.find(
          (agent) =>
            agent.id === message.agentId
            && (agent.principalUserId ?? null) === message.onBehalfOfUserId,
        )
        return candidate ? [engagementIdFor(candidate)] : []
      }),
    )
  }

  const nonPublic = channel.visibility !== 'public'
  // A classifier outcome is derived from these sources even if the run begins
  // after the original context window has scrolled away. Policy prose has no
  // retained source authorship, so its private origin remains explicitly unknown.
  const disclosureSources = policyDecision ? [
    ...(nonPublic ? [{ sourceAuthorUserId: null, sourceChannelId: payload.channelId }] : []),
    ...recentOrdered.flatMap((message) => [
      ...(message.disclosureSources ?? []),
      ...(nonPublic && originalHumanAuthorId(message) ? [{
        sourceAuthorUserId: originalHumanAuthorId(message), sourceChannelId: payload.channelId,
      }] : []),
    ]),
  ] : []
  const basisScopes = policyDecision && nonPublic
    ? [{ scopeType: 'channel' as const, scopeId: payload.channelId }] : []
  return { content: annotate(content, messageId), recentMessages, followingAgentIds, basisScopes, disclosureSources }
}
