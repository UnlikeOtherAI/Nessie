import type { Prisma, PrismaClient } from '@prisma/client'

import { canManageChannel } from './channel-manage.js'

type TransactionClient = PrismaClient | Prisma.TransactionClient

export type PersonalAssistantPresence = {
  agentId: string
  channelId: string
  principalUserId: string
}

export type PersonalAssistantPresenceMutation =
  | { kind: 'created'; presence: PersonalAssistantPresence }
  | { kind: 'deleted' }
  | { kind: 'forbidden' }
  | { kind: 'not_found' }

const personalAssistantForOrganization = async (
  prisma: TransactionClient,
  organizationId: string,
): Promise<{ id: string } | null> =>
  prisma.agent.findFirst({
    where: {
      agentKind: 'personal_assistant',
      organizationId,
      systemManaged: true,
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })

/**
 * Put the caller's organization-singleton PA in a non-system channel they are
 * actively a member of. This is deliberately separate from bindAgentToChannel:
 * a principal-bearing binding is the PA exception, never an ordinary binding.
 */
export const addPersonalAssistantPresence = async (
  prisma: PrismaClient,
  input: { channelId: string; organizationId: string; userId: string },
): Promise<PersonalAssistantPresenceMutation> =>
  prisma.$transaction(async (tx) => {
    const channel = await tx.channel.findFirst({
      where: {
        id: input.channelId,
        organizationId: input.organizationId,
        systemChannelType: null,
        members: { some: { userId: input.userId } },
      },
      select: { id: true },
    })
    if (!channel) return { kind: 'not_found' }

    const [member, assistant] = await Promise.all([
      tx.organizationMember.findFirst({
        where: {
          deactivatedAt: null,
          organizationId: input.organizationId,
          userId: input.userId,
        },
        select: { id: true },
      }),
      personalAssistantForOrganization(tx, input.organizationId),
    ])
    if (!member || !assistant) return { kind: 'not_found' }

    await tx.agentBinding.createMany({
      data: [{
        agentId: assistant.id,
        channelId: channel.id,
        principalUserId: input.userId,
      }],
      skipDuplicates: true,
    })

    return {
      kind: 'created',
      presence: {
        agentId: assistant.id,
        channelId: channel.id,
        principalUserId: input.userId,
      },
    }
  })

/**
 * A principal may remove their own presence; a channel manager may remove any
 * presence. The check lives beside placement so the PA tool and HTTP route
 * cannot diverge in either direction.
 */
export const removePersonalAssistantPresence = async (
  prisma: PrismaClient,
  input: {
    actorUserId: string
    channelId: string
    organizationId: string
    principalUserId: string
  },
): Promise<PersonalAssistantPresenceMutation> => {
  const [assistant, channel] = await Promise.all([
    personalAssistantForOrganization(prisma, input.organizationId),
    prisma.channel.findFirst({
      where: {
        id: input.channelId,
        organizationId: input.organizationId,
        systemChannelType: null,
      },
      select: { id: true },
    }),
  ])
  if (!assistant || !channel) return { kind: 'not_found' }

  if (input.actorUserId === input.principalUserId) {
    const membership = await prisma.channelMember.findUnique({
      where: {
        channelId_userId: {
          channelId: input.channelId,
          userId: input.actorUserId,
        },
      },
      select: { id: true },
    })
    if (!membership) return { kind: 'not_found' }
  } else if (!await canManageChannel(prisma, {
    channelId: input.channelId,
    organizationId: input.organizationId,
    userId: input.actorUserId,
  })) {
    return { kind: 'forbidden' }
  }

  await prisma.agentBinding.deleteMany({
    where: {
      agentId: assistant.id,
      channelId: input.channelId,
      principalUserId: input.principalUserId,
    },
  })
  return { kind: 'deleted' }
}
