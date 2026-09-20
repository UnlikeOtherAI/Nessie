import {
  deleteAgent,
  deleteAgentTrigger,
  checkPolicy,
  isAgentAccessibleToActor,
  listAgentTriggers,
  loadChannelForAgentManagement,
  unbindAgentFromChannel,
  updateAgentTrigger,
} from '@nessie/team-admin'
import { AgentTriggerStatusSchema, parseAgentId, parseOrganizationId } from '@nessie/schemas'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { requireOwnerMember, resolveActingMember } from './access.js'
import { emitWorkerAuditEvent } from '../execute/policy.js'

const Id = z.string().uuid()

const requireAccessibleAgent = async (context: BuiltinToolRuntimeContext, agentId: string) => {
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'manage another agent’s lifecycle')
  if (!await isAgentAccessibleToActor(context.prisma, member.actorContext, agentId)) {
    throw new Error('Agent not found.')
  }
  return member
}

export const runAgentTriggerListTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { agentId } = z.object({ agentId: Id }).parse(input)
  await requireAccessibleAgent(context, agentId)
  const triggers = await listAgentTriggers(context.prisma, agentId)
  return {
    inputSummary: `agentId=${agentId}`,
    outputPreview: triggers.length === 0
      ? 'This agent has no triggers.'
      : triggers.map((trigger) =>
        `- ${trigger.name ?? trigger.type} | triggerId=${trigger.id} | type=${trigger.type} | status=${trigger.status} | enabled=${trigger.enabled}`,
      ).join('\n'),
    toolName: 'agent_trigger_list',
  }
}

const AgentTriggerUpdateInputSchema = z.object({
  triggerId: Id,
  enabled: z.boolean().optional(),
  status: AgentTriggerStatusSchema.optional(),
  name: z.string().min(1).nullable().optional(),
  description: z.string().min(1).nullable().optional(),
  config: z.record(z.unknown()).optional(),
  nextRunAt: z.string().nullable().optional(),
  targetChannelId: Id.nullable().optional(),
  targetThreadId: Id.nullable().optional(),
})

export const runAgentTriggerUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AgentTriggerUpdateInputSchema.parse(input)
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'update another agent’s trigger')
  const trigger = await context.prisma.agentTrigger.findFirst({
    where: {
      id: args.triggerId,
      agent: { organizationId: member.organizationId },
    },
  })
  if (!trigger?.agentId || !await isAgentAccessibleToActor(
    context.prisma,
    member.actorContext,
    trigger.agentId,
  )) {
    throw new Error('Trigger not found.')
  }
  const updated = await updateAgentTrigger(context.prisma, {
    organizationId: member.organizationId,
    triggerId: trigger.id,
  }, args)
  if (!updated) throw new Error('Trigger configuration is invalid.')
  await emitWorkerAuditEvent(context.prisma, member.actorContext, {
    action: 'trigger.updated',
    metadata: { fields: Object.keys(args).filter((key) => key !== 'triggerId') },
    outcome: 'success',
    resourceId: trigger.id,
    resourceType: 'agent_trigger',
  })
  const agentId = parseAgentId(trigger.agentId)
  await context.realtimeTransport.publishWs([
    { kind: 'agent', agentId },
  ], {
    data: { agentId },
    event: 'agent.updated',
  })
  return {
    inputSummary: `triggerId=${args.triggerId}`,
    outputPreview: `Updated triggerId=${updated.id} | status=${updated.status} | enabled=${updated.enabled}`,
    toolName: 'agent_trigger_update',
  }
}

export const runAgentTriggerDeleteTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { triggerId } = z.object({ triggerId: Id }).parse(input)
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'delete another agent’s trigger')
  const trigger = await context.prisma.agentTrigger.findFirst({
    where: {
      id: triggerId,
      agent: { organizationId: member.organizationId },
    },
    select: { agentId: true, id: true },
  })
  if (!trigger?.agentId || !await isAgentAccessibleToActor(
    context.prisma,
    member.actorContext,
    trigger.agentId,
  )) {
    throw new Error('Trigger not found.')
  }
  if (!await deleteAgentTrigger(context.prisma, {
    organizationId: member.organizationId,
    triggerId,
  })) {
    throw new Error('Trigger with delivery history cannot be deleted.')
  }
  await emitWorkerAuditEvent(context.prisma, member.actorContext, {
    action: 'trigger.deleted',
    outcome: 'success',
    resourceId: triggerId,
    resourceType: 'agent_trigger',
  })
  const agentId = parseAgentId(trigger.agentId)
  await context.realtimeTransport.publishWs([
    { kind: 'agent', agentId },
  ], {
    data: { agentId },
    event: 'agent.updated',
  })
  return {
    inputSummary: `triggerId=${triggerId}`,
    outputPreview: `Deleted triggerId=${triggerId}.`,
    toolName: 'agent_trigger_delete',
  }
}

export const runAgentUnbindChannelTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { agentId, channelId } = z.object({ agentId: Id, channelId: Id }).parse(input)
  const member = await resolveActingMember(context)
  if (!member.isOrganizationAdmin) {
    throw new Error(
      `Only an organisation owner or admin can unbind an agent (your role is "${member.role}").`,
    )
  }
  const channel = await loadChannelForAgentManagement(context.prisma, {
    channelId,
    isOrganizationAdmin: member.isOrganizationAdmin,
    organizationId: member.organizationId,
    userId: member.userId,
  })
  if (channel.kind === 'not_found') throw new Error('Channel not found.')
  if (channel.kind === 'system_managed') {
    throw new Error('System-managed conversation bindings are owned by their bootstrap.')
  }
  const policy = await checkPolicy(context.prisma, {
    ...member.actorContext,
    actionContext: { ...member.actorContext.actionContext, toolId: undefined },
  }, 'agent', 'bind', { agentId, channelId })
  if (!policy.allowed) throw new Error(`Agent unbinding denied by policy: ${policy.reasonCode}`)
  await unbindAgentFromChannel(context.prisma, {
    agentId,
    channelId,
    organizationId: member.organizationId,
  })
  await emitWorkerAuditEvent(context.prisma, member.actorContext, {
    action: 'agent.unbound',
    metadata: { channelId },
    outcome: 'success',
    resourceId: agentId,
    resourceType: 'agent',
  })
  const parsedAgentId = parseAgentId(agentId)
  await context.realtimeTransport.publishWs([
    { kind: 'agent', agentId: parsedAgentId },
  ], {
    data: { agentId: parsedAgentId },
    event: 'agent.updated',
  })
  return {
    inputSummary: `agentId=${agentId} channelId=${channelId}`,
    outputPreview: `Unbound agentId=${agentId} from channelId=${channelId}.`,
    toolName: 'agent_unbind_channel',
  }
}

export const runAgentDeleteTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { agentId } = z.object({ agentId: Id }).parse(input)
  const member = await resolveActingMember(context)
  const outcome = await deleteAgent(context.prisma, member.actorContext, agentId)
  if (outcome.kind === 'not_found') throw new Error('Agent not found.')
  if (outcome.kind === 'refused') throw new Error(outcome.message)
  await emitWorkerAuditEvent(context.prisma, member.actorContext, {
    action: 'agent.deleted',
    outcome: 'success',
    resourceId: outcome.agentId,
    resourceType: 'agent',
  })
  const deletedAgentId = parseAgentId(outcome.agentId)
  await context.realtimeTransport.publishWs([
    {
      kind: 'organization',
      organizationId: parseOrganizationId(member.organizationId),
    },
    { kind: 'agent', agentId: deletedAgentId },
  ], {
    data: { agentId: deletedAgentId },
    event: 'agent.updated',
  })
  return {
    inputSummary: `agentId=${agentId}`,
    outputPreview: `Deleted agentId=${agentId}; its bindings, triggers, queued work, mailbox, and standing access were revoked.`,
    toolName: 'agent_delete',
  }
}
