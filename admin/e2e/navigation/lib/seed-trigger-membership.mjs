import { PrismaClient } from '@prisma/client'

import { call, seedTriggerOwner } from './seed.mjs'

/**
 * One schedule already stopped by the worker after its agent was removed.
 * The navigation case owns only the recovery surface, so it seeds the durable
 * post-failure state and lets the real Resume route prove the membership gate.
 */
export const seedTriggerMembershipError = async (seed) => {
  const suffix = Date.now().toString(36)
  const title = `Removed agent schedule ${suffix}`
  const owner = await seedTriggerOwner(seed, suffix)
  const agent = await call('/api/agents', {
    body: { name: `Removed channel agent ${suffix}`, systemPrompt: 'Membership recovery proof.' },
    method: 'POST',
    token: owner.token,
  })
  const prisma = new PrismaClient()
  try {
    await prisma.agentBinding.deleteMany({
      where: { agentId: agent.id, channelId: seed.channels[0].id },
    })
    const trigger = await prisma.agentTrigger.create({
      data: {
        agentId: agent.id,
        config: { createdViaTool: true, interval_minutes: 60 },
        enabled: false,
        healthDetail: 'The agent was removed from the target channel.',
        healthReason: 'agent_channel_access_lost',
        healthRevision: 1,
        name: title,
        nextRunAt: new Date(Date.now() + 60 * 60_000),
        status: 'error',
        targetChannelId: seed.channels[0].id,
        targetThreadId: seed.channels[0].defaultThreadId,
        type: 'interval',
      },
    })
    await prisma.agentTriggerDelivery.create({
      data: {
        dedupeKey: `navigation-membership:${trigger.id}`,
        errorMessage: 'The agent was removed from the target channel.',
        source: 'scheduler',
        status: 'failed',
        triggerId: trigger.id,
      },
    })
    return { title, token: owner.token, triggerId: trigger.id }
  } finally {
    await prisma.$disconnect()
  }
}
