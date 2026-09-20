import {
  AgentTriggerStatusSchema,
  isAgentAccessibleToActor,
  unbindAgentFromChannel,
} from '@nessie/team-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { requireOwnerMember, resolveActingMember } from './access.js'

const Id = z.string().uuid()

const requireAccessibleAgent = async (context: BuiltinToolRuntimeContext, agentId: string) => {
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'manage another agent’s lifecycle')
  if (!await isAgentAccessibleToActor(context.prisma, member.actorContext, agentId)) {
    throw new Error('Agent not found.')
  }
  return member
}

export const runAgentTriggerListTool = async (context: BuiltinToolRuntimeContext, input: Record<string, unknown>): Promise<ToolExecutionResult> => {
  const { agentId } = z.object({ agentId: Id }).parse(input)
  await requireAccessibleAgent(context, agentId)
  const triggers = await context.prisma.agentTrigger.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' } })
  return {
    inputSummary: `agentId=${agentId}`,
    outputPreview: triggers.length === 0 ? 'This agent has no triggers.' : triggers.map((trigger) =>
      `- ${trigger.name ?? trigger.type} | triggerId=${trigger.id} | type=${trigger.type} | status=${trigger.status} | enabled=${trigger.enabled}`,
    ).join('\n'),
    toolName: 'agent_trigger_list',
  }
}

export const runAgentTriggerUpdateTool = async (context: BuiltinToolRuntimeContext, input: Record<string, unknown>): Promise<ToolExecutionResult> => {
  const args = z.object({ triggerId: Id, enabled: z.boolean().optional(), status: AgentTriggerStatusSchema.optional(), name: z.string().min(1).nullable().optional(), description: z.string().min(1).nullable().optional() }).parse(input)
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'update another agent’s trigger')
  const trigger = await context.prisma.agentTrigger.findFirst({ where: { id: args.triggerId, agent: { organizationId: member.organizationId } } })
  if (!trigger || !trigger.agentId || !await isAgentAccessibleToActor(context.prisma, member.actorContext, trigger.agentId)) throw new Error('Trigger not found.')
  const status = args.status ?? (args.enabled === undefined ? undefined : args.enabled ? 'active' : 'paused')
  const updated = await context.prisma.agentTrigger.update({ where: { id: trigger.id }, data: { name: args.name, description: args.description, enabled: status === 'paused' ? false : args.enabled, status } })
  return { inputSummary: `triggerId=${args.triggerId}`, outputPreview: `Updated triggerId=${updated.id} | status=${updated.status} | enabled=${updated.enabled}`, toolName: 'agent_trigger_update' }
}

export const runAgentTriggerDeleteTool = async (context: BuiltinToolRuntimeContext, input: Record<string, unknown>): Promise<ToolExecutionResult> => {
  const { triggerId } = z.object({ triggerId: Id }).parse(input)
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'delete another agent’s trigger')
  const trigger = await context.prisma.agentTrigger.findFirst({ where: { id: triggerId, agent: { organizationId: member.organizationId } }, select: { agentId: true, id: true } })
  if (!trigger?.agentId || !await isAgentAccessibleToActor(context.prisma, member.actorContext, trigger.agentId)) throw new Error('Trigger not found.')
  if (await context.prisma.agentTriggerDelivery.count({ where: { triggerId } })) throw new Error('Trigger with delivery history cannot be deleted.')
  await context.prisma.agentTrigger.delete({ where: { id: triggerId } })
  return { inputSummary: `triggerId=${triggerId}`, outputPreview: `Deleted triggerId=${triggerId}.`, toolName: 'agent_trigger_delete' }
}

export const runAgentUnbindChannelTool = async (context: BuiltinToolRuntimeContext, input: Record<string, unknown>): Promise<ToolExecutionResult> => {
  const { agentId, channelId } = z.object({ agentId: Id, channelId: Id }).parse(input)
  const member = await requireAccessibleAgent(context, agentId)
  const channel = await context.prisma.channel.findFirst({ where: { id: channelId, organizationId: member.organizationId }, select: { systemChannelType: true } })
  if (!channel) throw new Error('Channel not found.')
  if (channel.systemChannelType) throw new Error('System-managed conversation bindings are owned by their bootstrap.')
  await unbindAgentFromChannel(context.prisma, { agentId, channelId, organizationId: member.organizationId })
  return { inputSummary: `agentId=${agentId} channelId=${channelId}`, outputPreview: `Unbound agentId=${agentId} from channelId=${channelId}.`, toolName: 'agent_unbind_channel' }
}
