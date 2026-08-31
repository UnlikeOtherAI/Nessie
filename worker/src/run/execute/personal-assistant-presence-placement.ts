import type { PrismaClient } from '@prisma/client'

import type { RunContext } from './types.js'

export class PersonalAssistantPresencePlacementError extends Error {
  override readonly name = 'PersonalAssistantPresencePlacementError'
  readonly code = 'PERSONAL_ASSISTANT_PRESENCE_INVALID_PLACEMENT'

  constructor() {
    super('This Personal Assistant presence is no longer active in the channel.')
  }
}

/**
 * A queued run can outlive a channel leave or owner deactivation. Verify the
 * exact principal binding immediately before inference so an old queue item
 * cannot keep acting after placement consent has been withdrawn.
 */
export const assertPersonalAssistantPresenceRunPlacement = async (
  prisma: PrismaClient,
  context: RunContext,
): Promise<void> => {
  const principalUserId = context.run.principalUserId
  if (!principalUserId) return

  if (
    context.agent.agentKind !== 'personal_assistant'
    || context.channel.systemChannelType === 'personal_assistant'
  ) {
    throw new PersonalAssistantPresencePlacementError()
  }

  const binding = await prisma.agentBinding.findFirst({
    where: {
      agentId: context.agent.id,
      channelId: context.channel.id,
      principalUserId,
      channel: {
        members: { some: { userId: principalUserId } },
        organizationId: context.channel.organizationId,
      },
    },
    select: { id: true },
  })
  const activeMembership = await prisma.organizationMember.findFirst({
    where: {
      deactivatedAt: null,
      organizationId: context.channel.organizationId,
      userId: principalUserId,
    },
    select: { id: true },
  })
  if (!binding || !activeMembership) {
    throw new PersonalAssistantPresencePlacementError()
  }
}
