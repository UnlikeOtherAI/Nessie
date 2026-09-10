import type { PrismaClient } from '@prisma/client'
import {
  canUserReadDisclosureBasis,
  partitionByDisclosure,
  resolveDisclosureViewer,
  resolveGrantedScopeKeysForMessages,
  viewerSatisfiesBasis,
} from '@nessie/runtime'
import type { UoaSessionIdentity } from '@nessie/schemas'
import type { AgentVisibilityScope } from '@nessie/team-admin'

import { canUserReadRunBasis } from './run-disclosure.js'

export type DisclosureAgentVisibilityScope = AgentVisibilityScope & {
  uoaIdentity: UoaSessionIdentity | undefined
}

/**
 * Agent ownership and ordinary channel visibility decide whether a person can
 * find a run. Provenance decides whether they can read what that run learned.
 */
export const filterReadableAgentRuns = async <TRun extends { id: string }>(
  prisma: PrismaClient,
  runs: readonly TRun[],
  visibility?: DisclosureAgentVisibilityScope,
): Promise<TRun[]> => {
  if (runs.length === 0) return []

  if (!visibility) {
    // A caller without a human viewer can only receive the public outcome.
    const results = await Promise.all(runs.map(async (run) => ({
      run,
      basis: await prisma.runBasisScope.findMany({
        where: { runId: run.id },
        select: { id: true },
        take: 1,
      }),
    })))
    return results.filter(({ basis }) => basis.length === 0).map(({ run }) => run)
  }

  const results = await Promise.all(runs.map(async (run) => ({
    readable: await canUserReadRunBasis(prisma, {
      organizationId: visibility.organizationId,
      runId: run.id,
      uoaIdentity: visibility.uoaIdentity,
      userId: visibility.userId,
    }),
    run,
  })))
  return results.filter(({ readable }) => readable).map(({ run }) => run)
}

export type AgentMessageDisclosureCandidate = {
  agentId: string | null
  basisScopes: Array<{ scopeId: string; scopeType: string }>
  disclosureSources: Array<{ sourceAuthorUserId: string | null; sourceChannelId: string }>
  id: string
  thread: { channelId: string }
}

export const canReadAgentMessage = async (
  prisma: PrismaClient,
  message: AgentMessageDisclosureCandidate,
  visibility?: DisclosureAgentVisibilityScope,
): Promise<boolean> => {
  if (message.basisScopes.length === 0) return true
  if (!visibility) return false

  return canUserReadDisclosureBasis(prisma, {
    agentId: message.agentId,
    basis: message.basisScopes,
    channelId: message.thread.channelId,
    disclosureSources: message.disclosureSources,
    messageId: message.id,
    organizationId: visibility.organizationId,
    uoaIdentity: visibility.uoaIdentity,
    userId: visibility.userId,
  })
}

/**
 * Resolves live disclosure for one bounded history scan. The runtime's batched
 * grant accessor is grouped by destination channel because a grant's audience
 * is channel-specific; no row receives its own grant round trip.
 */
export const filterReadableAgentMessages = async <TMessage extends AgentMessageDisclosureCandidate>(
  prisma: PrismaClient,
  messages: readonly TMessage[],
  visibility?: DisclosureAgentVisibilityScope,
): Promise<TMessage[]> => {
  if (messages.length === 0) return []
  if (!visibility) return messages.filter((message) => message.basisScopes.length === 0)

  const viewer = await resolveDisclosureViewer(prisma, visibility.organizationId, visibility.userId, {
    uoaIdentity: visibility.uoaIdentity,
  })
  if (viewer.kind !== 'user') return []

  const memberChannelIds = new Set(viewer.scopes
    .filter((scope) => scope.scopeType === 'channel')
    .map((scope) => scope.scopeId))
  const unknownChannelIds = [...new Set(messages
    .map((message) => message.thread.channelId)
    .filter((channelId) => !memberChannelIds.has(channelId)))]
  if (unknownChannelIds.length > 0) {
    const publicChannels = await prisma.channel.findMany({
      where: {
        id: { in: unknownChannelIds },
        organizationId: visibility.organizationId,
        visibility: 'public',
      },
      select: { id: true },
    })
    for (const channel of publicChannels) memberChannelIds.add(channel.id)
  }
  const channelReadable = messages.filter((message) =>
    memberChannelIds.has(message.thread.channelId))
  if (channelReadable.length === 0) return []

  const provisional = partitionByDisclosure(channelReadable, viewer)
  if (provisional.withheld.length === 0) return [...channelReadable]

  const grantsByMessage = await resolveGrantedScopeKeysForMessages(prisma, {
    // The accessor's per-subject destination support keeps this one batch even
    // when an agent's history spans many channels.
    channelId: provisional.withheld[0]?.thread.channelId ?? '',
    messages: provisional.withheld.map((message) => ({
      agentId: message.agentId,
      basis: message.basisScopes,
      destinationChannelId: message.thread.channelId,
      disclosureSources: message.disclosureSources,
      messageId: message.id,
    })),
    organizationId: visibility.organizationId,
    viewerChannelIds: viewer.scopes
      .filter((scope) => scope.scopeType === 'channel')
      .map((scope) => scope.scopeId),
    viewerUserId: viewer.userId,
  })

  const withheldIds = new Set(provisional.withheld.map((message) => message.id))
  return channelReadable.filter((message) =>
    !withheldIds.has(message.id)
    || viewerSatisfiesBasis(message.basisScopes, viewer, grantsByMessage.get(message.id) ?? new Set<string>()),
  )
}
