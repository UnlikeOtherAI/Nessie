import type { Prisma } from '@prisma/client'

import { TriggerConfigRefusalError } from './trigger-config-refusal.js'

/**
 * The target channel of a ticket or document trigger, checked on the server
 * (docs/standards/ticket-work.md, docs/standards/document-triggers.md): live,
 * ordinary — no direct or system conversation — **public**, and holding the
 * agent. The project comes from it, never from the caller. Both trigger types
 * wake the agent in threads of their own in this channel, readable by the
 * whole project audience, so both refuse the same things for the same reasons;
 * only the words that say what the channel is for differ.
 */

export type TriggerTargetChannel = {
  archivedAt: Date | null
  id: string
  label: string
  project: { name: string }
  projectId: string
  visibility: string
}

export type TriggerTargetChannelWording = {
  /** The refusal when no channel is given: what the channel is for. */
  missing: string
  /** "a ticket trigger", "a document trigger". */
  subject: string
  /** Why it must be public, after "must be public, so that". */
  whyPublic: string
}

const refuse = (reason: string): never => {
  throw new TriggerConfigRefusalError([{ path: 'targetChannelId', reason }])
}

export const resolveTriggerTargetChannel = async (
  tx: Pick<Prisma.TransactionClient, 'channel' | 'agentBinding'>,
  input: {
    agent: { id: string; name: string; organizationId: string }
    targetChannelId?: string | null
    wording: TriggerTargetChannelWording
  },
): Promise<TriggerTargetChannel> => {
  const channelId = input.targetChannelId
  if (!channelId) return refuse(input.wording.missing)
  const channel = await tx.channel.findFirst({
    where: { deletedAt: null, id: channelId, organizationId: input.agent.organizationId, project: { deletedAt: null } },
    select: {
      archivedAt: true,
      dmKey: true,
      id: true,
      label: true,
      project: { select: { name: true } },
      projectId: true,
      systemChannelType: true,
      type: true,
      visibility: true,
    },
  })
  if (!channel) return refuse('no such channel in this organisation')
  const room = `#${channel.label}`
  if (channel.archivedAt) return refuse(`${room} is archived; pick a live channel`)
  if (channel.type !== 'standard' || channel.systemChannelType || channel.dmKey) {
    return refuse(
      `${room} is a direct or system conversation; ${input.wording.subject} works in an ordinary project channel`,
    )
  }
  if (channel.visibility !== 'public') {
    return refuse(
      `${room} is ${channel.visibility}. ${input.wording.subject[0]!.toUpperCase()}${input.wording.subject.slice(1)}'s `
      + `channel must be public, so that ${input.wording.whyPublic}`,
    )
  }
  const bound = await tx.agentBinding.count({ where: { agentId: input.agent.id, channelId: channel.id } })
  if (bound === 0) return refuse(`${input.agent.name} is not in ${room}; add it to the channel first`)
  return channel
}
