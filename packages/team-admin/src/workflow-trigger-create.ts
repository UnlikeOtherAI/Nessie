import { Prisma, type PrismaClient } from '@prisma/client'
import type { AgentTriggerRecord, AgentTriggerType } from '@nessie/schemas'

import {
  ensureWebhookConfig,
  mapTriggerRecord,
  normalizeNextRunAt,
  SCHEDULER_TRIGGER_TYPES,
  TRIGGER_ADMIN_AUDIENCE,
} from './trigger-core.js'
import { stripServerOwnedTriggerConfig } from './trigger-config-identity.js'

/**
 * The one workflow-trigger write used by both the Admin route and an agent
 * acting for an owner. A workflow schedule belongs to an installation, not to
 * the template's designer-only trigger markers.
 */
export const createWorkflowTrigger = async (
  prisma: PrismaClient,
  workflowInstallationId: string,
  input: {
    config?: Record<string, unknown>
    description?: string
    enabled?: boolean
    name?: string
    nextRunAt?: string
    type: AgentTriggerType
  },
): Promise<AgentTriggerRecord | null> => {
  const clientConfig = stripServerOwnedTriggerConfig(input.config)
  const config = input.type === 'webhook'
    ? ensureWebhookConfig(clientConfig)
    : clientConfig
  const nextRunAt = normalizeNextRunAt({
    config,
    nextRunAt: input.nextRunAt,
    type: input.type,
  })

  if (SCHEDULER_TRIGGER_TYPES.includes(input.type) && !nextRunAt) {
    return null
  }

  const installation = await prisma.workflowInstallation.findUnique({
    where: { id: workflowInstallationId },
    select: { id: true },
  })
  if (!installation) return null

  const trigger = await prisma.agentTrigger.create({
    data: {
      workflowInstallationId,
      type: input.type,
      enabled: input.enabled ?? true,
      status: input.enabled === false ? 'paused' : 'active',
      name: input.name,
      description: input.description,
      config: config as Prisma.InputJsonValue,
      nextRunAt: nextRunAt ?? undefined,
    },
  })

  return mapTriggerRecord(trigger, TRIGGER_ADMIN_AUDIENCE)
}
