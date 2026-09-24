import { raiseTriggerMachineAccessAttention, TriggerConfigRefusalError } from '@nessie/team-admin'
import type { AgentTriggerRecord } from '@nessie/schemas'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import type { ActingMember } from './access.js'

/**
 * `agent_trigger_create` and `agent_trigger_update` on the project-operator
 * face (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "The
 * project-operator capability"): a trigger for the agent itself, or for an
 * agent in one of this project's channels, that works in this project — the
 * project of the channel the person is talking to it in. Everything else about
 * the trigger is the route's: an organisation owner asking, and the typed
 * `ticket_changed` config with its field-level refusals.
 *
 * Refusals name the field, in the shape `TriggerConfigRefusalError` gives the
 * config's own, so the agent relays them the same way.
 */

const refuse = (path: string, reason: string): never => {
  throw new TriggerConfigRefusalError([{ path, reason }])
}

/** The agent is this one, or is in a live channel of this project. */
const assertAgentOfProject = async (
  context: BuiltinToolRuntimeContext,
  agentId: string,
  projectId: string,
): Promise<void> => {
  if (agentId === context.agentId) return
  const bound = await context.prisma.agentBinding.count({
    where: {
      agentId,
      channel: { archivedAt: null, deletedAt: null, organizationId: context.channel.organizationId, projectId },
    },
  })
  if (bound === 0) {
    refuse('agentId', 'from here you can set up triggers only for yourself or an agent in one of this project\'s channels')
  }
}

/** The channel a trigger target names — directly, or through a thread — and its project. */
const targetProjectId = async (
  context: BuiltinToolRuntimeContext,
  target: { targetChannelId?: string | null; targetThreadId?: string | null },
): Promise<string | null> => {
  const channelId = target.targetThreadId
    ? (await context.prisma.thread.findUnique({ where: { id: target.targetThreadId }, select: { channelId: true } }))
      ?.channelId
    : target.targetChannelId
  if (!channelId) return null
  const channel = await context.prisma.channel.findFirst({
    where: { id: channelId, organizationId: context.channel.organizationId },
    select: { projectId: true },
  })
  return channel?.projectId ?? null
}

const OTHER_PROJECT = 'that channel is in another project; from here a trigger works only in this project, '
  + 'in a channel of it the agent is in'

export const assertOperatorTriggerCreateScope = async (
  context: BuiltinToolRuntimeContext,
  input: {
    agentId: string
    body: { targetChannelId?: string; targetThreadId?: string }
    operatorProjectId: string
  },
): Promise<void> => {
  await assertAgentOfProject(context, input.agentId, input.operatorProjectId)
  const path = input.body.targetThreadId ? 'targetThreadId' : 'targetChannelId'
  const projectId = await targetProjectId(context, input.body)
  if (!projectId) refuse(path, 'name the channel of this project the trigger works in')
  if (projectId !== input.operatorProjectId) refuse(path, OTHER_PROJECT)
}

export const assertOperatorTriggerUpdateScope = async (
  context: BuiltinToolRuntimeContext,
  input: {
    args: { targetChannelId?: string | null; targetThreadId?: string | null }
    operatorProjectId: string
    trigger: {
      agentId: string | null
      scopeProjectId: string | null
      targetChannelId: string | null
      targetThreadId: string | null
    }
  },
): Promise<void> => {
  if (!input.trigger.agentId) return refuse('triggerId', 'that is not an agent\'s trigger')
  await assertAgentOfProject(context, input.trigger.agentId, input.operatorProjectId)
  const current = input.trigger.scopeProjectId ?? await targetProjectId(context, input.trigger)
  if (current !== input.operatorProjectId) {
    refuse('triggerId', 'that trigger works in another project; from here you can change only this project\'s')
  }
  if (input.args.targetChannelId || input.args.targetThreadId) {
    const next = await targetProjectId(context, input.args)
    if (next !== input.operatorProjectId) {
      refuse(input.args.targetThreadId ? 'targetThreadId' : 'targetChannelId', OTHER_PROJECT)
    }
  }
}

/**
 * What a ticket trigger the operator made still lacks, said back and put in
 * the person's attention: machine access stays the machines' owner's to set
 * up, from the trigger's page or with the Agent Designer, never something an
 * agent grants itself. Other trigger types need no machine and add nothing.
 */
export const operatorTriggerFollowUp = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  trigger: AgentTriggerRecord,
  projectId: string,
): Promise<string[]> => {
  if (trigger.type !== 'ticket_changed') return []
  await raiseTriggerMachineAccessAttention(context.prisma, {
    actorAgentId: context.agentId,
    organizationId: member.organizationId,
    projectId,
    triggerId: trigger.id,
    userId: member.userId,
  })
  return [
    'Machine access: not set up. The owner of the machines the work runs on sets it up, from this '
    + 'trigger\'s page or with the Agent Designer; no agent can. The person you are acting for now has an '
    + 'item in their notifications saying so, until it is set up.',
  ]
}
