import { Prisma, type PrismaClient } from '@prisma/client'
import { parseIntervalMinutes, parseScheduledCronConfig } from '@nessie/runtime'
import type { AgentTriggerRecord, AgentTriggerStatus } from '@nessie/schemas'
import { mergeTriggerConfigPreservingIdentity } from './trigger-config-identity.js'
import { acquireAgentTodoAgentLock } from './agent-todo-lock.js'
import { ensureWebhookConfig, isJsonRecord, mapTriggerRecord, normalizeNextRunAt, resolveExecutionTarget, TRIGGER_ADMIN_AUDIENCE } from './trigger-core.js'
import { validateTodoTemplateTriggerConfig } from './trigger-create.js'

export type AgentTriggerScope = { organizationId: string; triggerId: string }
/** Every trigger is tenant-scoped through its agent (including bound global
 * agents) or its workflow installation; never look up a caller id bare. */
const whereFor = (scope: AgentTriggerScope): Prisma.AgentTriggerWhereInput => ({
  id: scope.triggerId,
  OR: [
    {
      agent: {
        OR: [
          { organizationId: scope.organizationId },
          { bindings: { some: { channel: { organizationId: scope.organizationId } } } },
        ],
      },
    },
    { workflowInstallation: { organizationId: scope.organizationId } },
  ],
})

export const listAgentTriggers = async (prisma: PrismaClient, agentId: string): Promise<AgentTriggerRecord[]> =>
  (await prisma.agentTrigger.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' } })).map((trigger) => mapTriggerRecord(trigger, TRIGGER_ADMIN_AUDIENCE))

export const getAgentTrigger = async (prisma: PrismaClient, scope: AgentTriggerScope): Promise<AgentTriggerRecord | null> => {
  const trigger = await prisma.agentTrigger.findFirst({ where: whereFor(scope) })
  return trigger ? mapTriggerRecord(trigger) : null
}

export const updateAgentTrigger = async (prisma: PrismaClient, scope: AgentTriggerScope, input: { config?: Record<string, unknown>; description?: string | null; enabled?: boolean; name?: string | null; nextRunAt?: string | null; status?: AgentTriggerStatus; targetChannelId?: string | null; targetThreadId?: string | null }): Promise<AgentTriggerRecord | null> => {
  const existing = await prisma.agentTrigger.findFirst({ where: whereFor(scope), select: { agentId: true, config: true, id: true, targetChannelId: true, targetThreadId: true, type: true } })
  if (!existing) return null
  const agentId = existing.agentId
  const targetChanged = input.targetChannelId !== undefined || input.targetThreadId !== undefined
  const target = agentId
    ? targetChanged ? await resolveExecutionTarget(prisma, agentId, { targetChannelId: input.targetChannelId === undefined ? existing.targetChannelId : input.targetChannelId, targetThreadId: input.targetThreadId === undefined ? existing.targetThreadId : input.targetThreadId }) : { channelId: existing.targetChannelId, threadId: existing.targetThreadId }
    : targetChanged ? null : { channelId: null, threadId: null }
  if (!target || (agentId && (!target.channelId || !target.threadId))) return null
  const status = input.status ?? (input.enabled === undefined ? undefined : input.enabled ? 'active' : 'paused')
  const config = input.config === undefined ? existing.config : mergeTriggerConfigPreservingIdentity(existing.config, input.config)
  const normalizedConfig = existing.type === 'webhook' ? ensureWebhookConfig(config) : config
  if (existing.type === 'scheduled' && input.config !== undefined && !parseScheduledCronConfig(normalizedConfig)) return null
  if (existing.type === 'interval' && input.config !== undefined && !parseIntervalMinutes(normalizedConfig)) return null
  const nextRunAt = input.nextRunAt === undefined ? (input.config === undefined ? undefined : normalizeNextRunAt({ config: isJsonRecord(normalizedConfig) ? normalizedConfig : undefined, type: existing.type })) : input.nextRunAt === null ? null : normalizeNextRunAt({ config: isJsonRecord(normalizedConfig) ? normalizedConfig : undefined, nextRunAt: input.nextRunAt, type: existing.type })
  const write = (tx: PrismaClient | Prisma.TransactionClient) => tx.agentTrigger.update({ where: { id: existing.id }, data: { name: input.name, description: input.description, enabled: status === 'paused' ? false : input.enabled, status, config: input.config === undefined ? undefined : normalizedConfig as Prisma.InputJsonValue, ...(targetChanged ? { targetChannelId: target.channelId, targetThreadId: target.threadId } : {}), nextRunAt } })
  const configRecord = isJsonRecord(normalizedConfig) ? normalizedConfig : {}
  const trigger = Object.hasOwn(configRecord, 'todoTemplateId') && (input.config !== undefined || input.enabled === true)
    ? agentId ? await prisma.$transaction(async (tx) => { await acquireAgentTodoAgentLock(tx, agentId); return await validateTodoTemplateTriggerConfig(tx, agentId, configRecord) ? write(tx) : null }) : null
    : await write(prisma)
  return trigger ? mapTriggerRecord(trigger, TRIGGER_ADMIN_AUDIENCE) : null
}

export const deleteAgentTrigger = async (prisma: PrismaClient, scope: AgentTriggerScope): Promise<boolean> => {
  if (await prisma.agentTriggerDelivery.count({ where: { triggerId: scope.triggerId } })) return false
  return (await prisma.agentTrigger.deleteMany({ where: whereFor(scope) })).count > 0
}
