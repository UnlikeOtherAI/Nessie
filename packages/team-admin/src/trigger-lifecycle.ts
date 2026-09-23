import { Prisma, type PrismaClient } from '@prisma/client'
import { parseIntervalMinutes, parseScheduledCronConfig } from '@nessie/runtime'
import type { AgentTriggerRecord, AgentTriggerStatus } from '@nessie/schemas'
import { mergeTriggerConfigPreservingIdentity, stripServerOwnedTriggerConfig } from './trigger-config-identity.js'
import { resolveTicketChangedTrigger, ticketChangedConfigAsInput } from './trigger-ticket-config.js'
import { acquireAgentTodoAgentLock } from './agent-todo-lock.js'
import { ensureWebhookConfig, extractWebhookApiKey, isJsonRecord, mapTriggerRecord, normalizeNextRunAt, resolveExecutionTarget, TRIGGER_ADMIN_AUDIENCE } from './trigger-core.js'
import { validateTodoTemplateTriggerConfig } from './trigger-create.js'
import { endTicketWorkForTrigger } from './ticket-work-records.js'

export type AgentTriggerScope = { organizationId: string; triggerId: string }
/** Every trigger is tenant-scoped through its agent (including bound global
 * agents) or its workflow installation; never look up a caller id bare. */
export const agentTriggerScopeWhere = (scope: AgentTriggerScope): Prisma.AgentTriggerWhereInput => ({
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

export const getAgentTrigger = async (
  prisma: PrismaClient,
  scope: AgentTriggerScope,
): Promise<AgentTriggerRecord | null> => {
  const trigger = await prisma.agentTrigger.findFirst({ where: agentTriggerScopeWhere(scope) })
  return trigger ? mapTriggerRecord(trigger) : null
}

type AgentTriggerUpdateInput = {
  config?: Record<string, unknown>
  description?: string | null
  enabled?: boolean
  name?: string | null
  nextRunAt?: string | null
  status?: AgentTriggerStatus
  targetChannelId?: string | null
  targetThreadId?: string | null
}

/**
 * A `ticket_changed` edit. A config patch names only the keys it changes: the
 * stored config is read back in the input's words (`ticketChangedConfigAsInput`),
 * the patch laid over it, and the whole resolved and checked again, exactly as
 * a create is — including when the edit only switches the trigger on, which is
 * when the one-pickup-per-column rule can newly bite. A refusal throws
 * `TriggerConfigRefusalError`; a name or description edit resolves nothing.
 */
const updateTicketChangedTrigger = async (
  prisma: PrismaClient,
  existing: { agentId: string | null; config: unknown; enabled: boolean; id: string; targetChannelId: string | null },
  input: AgentTriggerUpdateInput,
): Promise<AgentTriggerRecord | null> => {
  const agentId = existing.agentId
  if (!agentId) return null
  const status = input.status ?? (input.enabled === undefined ? undefined : input.enabled ? 'active' : 'paused')
  const enabled = status === 'paused' ? false : input.enabled
  const reresolve = enabled === true || input.config !== undefined || input.nextRunAt !== undefined
    || input.targetChannelId !== undefined || input.targetThreadId !== undefined
  const trigger = await prisma.$transaction(async (tx) => {
    const agent = await tx.agent.findUnique({
      where: { id: agentId },
      select: { id: true, name: true, organizationId: true },
    })
    if (!agent?.organizationId) return null
    let resolvedData: Prisma.AgentTriggerUncheckedUpdateInput = {}
    if (reresolve) {
      const resolved = await resolveTicketChangedTrigger(tx, {
        agent: { id: agent.id, name: agent.name, organizationId: agent.organizationId },
        config: { ...ticketChangedConfigAsInput(existing.config), ...stripServerOwnedTriggerConfig(input.config) },
        enabled: enabled ?? existing.enabled,
        excludeTriggerId: existing.id,
        nextRunAt: input.nextRunAt,
        targetChannelId: input.targetChannelId === undefined ? existing.targetChannelId : input.targetChannelId,
        targetThreadId: input.targetThreadId,
      })
      const target = await resolveExecutionTarget(tx, agent.id, { targetChannelId: resolved.targetChannelId })
      if (!target) return null
      resolvedData = {
        config: mergeTriggerConfigPreservingIdentity(existing.config, resolved.config) as Prisma.InputJsonValue,
        scopeBoardId: resolved.scopeBoardId,
        scopeProjectId: resolved.scopeProjectId,
        targetChannelId: target.channelId,
        targetThreadId: target.threadId,
      }
    }
    const updated = await tx.agentTrigger.update({
      where: { id: existing.id },
      data: { description: input.description, enabled, name: input.name, status, ...resolvedData },
    })
    // Switching it off ends the work it holds, in this same write.
    if (enabled === false) await endTicketWorkForTrigger(tx, { triggerId: existing.id })
    return updated
  })
  return trigger ? mapTriggerRecord(trigger, TRIGGER_ADMIN_AUDIENCE) : null
}

export const updateAgentTrigger = async (
  prisma: PrismaClient,
  scope: AgentTriggerScope,
  input: AgentTriggerUpdateInput,
): Promise<AgentTriggerRecord | null> => {
  const existing = await prisma.agentTrigger.findFirst({
    where: agentTriggerScopeWhere(scope),
    select: {
      agentId: true, config: true, enabled: true, id: true, targetChannelId: true, targetThreadId: true, type: true,
    },
  })
  if (!existing) return null
  if (existing.type === 'ticket_changed') return updateTicketChangedTrigger(prisma, existing, input)
  const agentId = existing.agentId
  const targetChanged = input.targetChannelId !== undefined || input.targetThreadId !== undefined
  const target = agentId
    ? targetChanged
      ? await resolveExecutionTarget(prisma, agentId, {
          targetChannelId: input.targetChannelId === undefined
            ? existing.targetChannelId : input.targetChannelId,
          targetThreadId: input.targetThreadId === undefined
            ? existing.targetThreadId : input.targetThreadId,
        })
      : { channelId: existing.targetChannelId, threadId: existing.targetThreadId }
    : targetChanged ? null : { channelId: null, threadId: null }
  if (!target || (agentId && (!target.channelId || !target.threadId))) return null
  const status = input.status ?? (input.enabled === undefined ? undefined : input.enabled ? 'active' : 'paused')
  const config = input.config === undefined
    ? existing.config
    : mergeTriggerConfigPreservingIdentity(existing.config, input.config)
  const normalizedConfig = existing.type === 'webhook' ? ensureWebhookConfig(config) : config
  if (existing.type === 'scheduled' && input.config !== undefined && !parseScheduledCronConfig(normalizedConfig)) return null
  if (existing.type === 'interval' && input.config !== undefined && !parseIntervalMinutes(normalizedConfig)) return null
  const shouldPersistConfig = existing.type === 'webhook' ? input.config !== undefined || !extractWebhookApiKey(existing.config) : input.config !== undefined
  const recompute = input.nextRunAt === undefined && input.config !== undefined
  const nextRunAt = existing.type === 'scheduled' || existing.type === 'interval' ? input.nextRunAt === undefined ? recompute ? normalizeNextRunAt({ config: isJsonRecord(normalizedConfig) ? normalizedConfig : undefined, type: existing.type }) : undefined : input.nextRunAt === null ? null : normalizeNextRunAt({ config: isJsonRecord(normalizedConfig) ? normalizedConfig : undefined, nextRunAt: input.nextRunAt, type: existing.type }) : input.nextRunAt === undefined ? undefined : input.nextRunAt === null ? null : new Date(input.nextRunAt)
  const write = (tx: PrismaClient | Prisma.TransactionClient) => tx.agentTrigger.update({ where: { id: existing.id }, data: { name: input.name === undefined ? undefined : input.name, description: input.description === undefined ? undefined : input.description, enabled: status === 'paused' ? false : input.enabled, status, config: shouldPersistConfig ? normalizedConfig as Prisma.InputJsonValue : undefined, ...(targetChanged ? { targetChannelId: target.channelId, targetThreadId: target.threadId } : {}), nextRunAt } })
  const configRecord = isJsonRecord(normalizedConfig) ? normalizedConfig : {}
  const trigger = Object.hasOwn(configRecord, 'todoTemplateId') && (input.config !== undefined || input.enabled === true)
    ? agentId
      ? await prisma.$transaction(async (tx) => {
          await acquireAgentTodoAgentLock(tx, agentId)
          return await validateTodoTemplateTriggerConfig(tx, agentId, configRecord)
            ? write(tx) : null
        })
      : null
    : await write(prisma)
  return trigger ? mapTriggerRecord(trigger, TRIGGER_ADMIN_AUDIENCE) : null
}

export const deleteAgentTrigger = async (prisma: PrismaClient, scope: AgentTriggerScope): Promise<boolean> => {
  if (await prisma.agentTriggerDelivery.count({ where: { triggerId: scope.triggerId } })) return false
  return prisma.$transaction(async (tx) => {
    const trigger = await tx.agentTrigger.findFirst({ where: agentTriggerScopeWhere(scope), select: { id: true } })
    if (!trigger) return false
    // A ticket trigger's work records outlive it (`triggerId` is SetNull), so
    // they end first, while they still know which trigger held them.
    await endTicketWorkForTrigger(tx, { triggerId: trigger.id })
    return (await tx.agentTrigger.deleteMany({ where: { id: trigger.id } })).count > 0
  })
}
