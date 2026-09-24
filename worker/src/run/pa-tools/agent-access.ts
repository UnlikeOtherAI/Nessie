import {
  fingerprintMcpToolDescriptor,
  isCurrentAllowedMcpToolGrant,
  listInstancesVisibleToUser,
  mcpToolDescriptorAnnotationsFromMetadata,
  setAgentExplicitToolAccess,
  setDeepWaterAgentAccess,
} from '@nessie/mcp-manage'
import { CAPABILITY_GRANT_DEFINITIONS } from '@nessie/runtime'
import { parseAgentId, parseOrganizationId } from '@nessie/schemas'
import {
  listAgentToolPolicyTargets,
  registryEntryRequiresExplicitPolicy,
} from '@nessie/team-admin'
import { z } from 'zod'

import { emitWorkerAuditEvent } from '../execute/policy.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { requireOwnerMember, resolveActingMember } from './access.js'

const AgentToolAccessSetInputSchema = z.object({
  agentId: z.string().uuid(),
  enabled: z.boolean(),
  toolRegistryEntryId: z.string().uuid(),
})

const AgentDeepWaterAccessSetInputSchema = z.object({
  agentId: z.string().uuid(),
  enabled: z.boolean(),
  teamId: z.string().uuid(),
})

const visibleMcpInstanceIds = async (
  context: BuiltinToolRuntimeContext,
  member: Awaited<ReturnType<typeof resolveActingMember>>,
): Promise<Set<string>> => {
  const instances = await listInstancesVisibleToUser(
    context.prisma,
    member.organizationId,
    member.userId,
  )
  return new Set(instances.map((instance) => instance.id))
}

const readToolPolicyTarget = async (
  context: BuiltinToolRuntimeContext,
  member: Awaited<ReturnType<typeof resolveActingMember>>,
  agentId: string,
) => {
  const target = (await listAgentToolPolicyTargets(
    context.prisma,
    member.organizationId,
    member.userId,
  )).find((candidate) => candidate.id === agentId)
  if (!target) {
    throw new Error('Agent not found, or you cannot inspect its protected access.')
  }
  return target
}

const publishAgentUpdated = async (
  context: BuiltinToolRuntimeContext,
  agentId: string,
): Promise<void> => {
  const parsedAgentId = parseAgentId(agentId)
  await context.realtimeTransport.publishWs(
    [
      {
        kind: 'organization',
        organizationId: parseOrganizationId(context.channel.organizationId),
      },
      { kind: 'agent', agentId: parsedAgentId },
    ],
    { event: 'agent.updated', data: { agentId: parsedAgentId } },
  )
}

export const runAgentToolAccessSetTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AgentToolAccessSetInputSchema.parse(input)
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'change protected agent tool access')

  const requested = await context.prisma.toolRegistryEntry.findFirst({
    where: {
      id: args.toolRegistryEntryId,
      OR: [
        { organizationId: null },
        { organizationId: member.organizationId },
      ],
    },
    select: { mcpInstance: { select: { id: true } } },
  })
  const executorManaged = await context.prisma.toolRegistryEntry.findFirst({
    where: {
      id: args.toolRegistryEntryId,
      organizationId: member.organizationId,
      source: 'executor',
    },
    select: { id: true },
  })
  if (executorManaged) {
    throw new Error(
      'Executor logical tools are managed from the Executors access controls.',
    )
  }
  const visibleInstances = await visibleMcpInstanceIds(context, member)
  if (requested?.mcpInstance && !visibleInstances.has(requested.mcpInstance.id)) {
    throw new Error('This connection is outside your accessible scope.')
  }

  const target = await setAgentExplicitToolAccess(context.prisma, {
    ...args,
    actorUserId: member.userId,
    organizationId: member.organizationId,
  })
  await emitWorkerAuditEvent(context.prisma, member.actorContext, {
    action: 'agent.tool_access.updated',
    metadata: {
      enabled: args.enabled,
      toolRegistryEntryId: args.toolRegistryEntryId,
    },
    outcome: 'success',
    resourceId: args.agentId,
    resourceType: 'agent',
  })
  await publishAgentUpdated(context, args.agentId)

  return {
    inputSummary:
      `agentId=${args.agentId} tool=${args.toolRegistryEntryId} `
      + `enabled=${args.enabled}`,
    outputPreview:
      `${args.enabled ? 'Granted' : 'Revoked'} protected tool access for ${target.name}.`,
    toolName: 'agent_tool_access_set',
  }
}

export const runAgentToolAccessInspectTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { agentId } = z.object({ agentId: z.string().uuid() }).parse(input)
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'inspect protected agent tool access')
  const agent = await readToolPolicyTarget(context, member, agentId)

  const candidates = await context.prisma.toolRegistryEntry.findMany({
    where: {
      OR: [
        { organizationId: null },
        { organizationId: member.organizationId },
      ],
      enabled: true,
      status: 'active',
    },
    select: {
      description: true,
      handlerKind: true,
      id: true,
      inputSchema: true,
      label: true,
      metadata: true,
      mcpInstance: { select: { id: true } },
      outputSchema: true,
      source: true,
      toolId: true,
      transportConfig: true,
    },
  })
  const visibleInstances = await visibleMcpInstanceIds(context, member)
  const entries = candidates.filter(
    (entry) => entry.source !== 'executor'
      && registryEntryRequiresExplicitPolicy(entry)
      && (!entry.mcpInstance || visibleInstances.has(entry.mcpInstance.id)),
  )
  const grants = await context.prisma.toolGrant.findMany({
    where: {
      agentId,
      roleId: null,
      toolId: {
        in: entries
          .filter((entry) => entry.handlerKind === 'mcp')
          .map((entry) => entry.id),
      },
    },
    select: { config: true, state: true, toolId: true },
  })

  return {
    inputSummary: `agentId=${agentId}`,
    outputPreview: [
      `Protected access for ${agent.name}:`,
      ...entries.map((entry) => {
        const configured = entry.transportConfig
          && typeof entry.transportConfig === 'object'
          ? (entry.transportConfig as Record<string, unknown>).toolName
          : null
        const name = typeof configured === 'string'
          ? configured
          : entry.toolId.split(':').at(-1)
        const fingerprint = entry.handlerKind === 'mcp' && name
          ? fingerprintMcpToolDescriptor({
              annotations: mcpToolDescriptorAnnotationsFromMetadata(entry.metadata),
              description: entry.description,
              inputSchema: entry.inputSchema,
              name,
              outputSchema: entry.outputSchema,
            })
          : null
        const granted = entry.handlerKind === 'builtin'
          ? agent.toolPolicy[entry.toolId] === true
          : fingerprint !== null
            && grants.some(
              (grant) => grant.toolId === entry.id
                && isCurrentAllowedMcpToolGrant(grant, fingerprint),
            )
        // A capability grant is no tool anybody would recognise by its label,
        // so it says what it lets the agent do.
        const capability = entry.handlerKind === 'builtin'
          ? CAPABILITY_GRANT_DEFINITIONS.find((definition) => definition.id === entry.toolId)
          : undefined
        return `- ${entry.label} | registryId=${entry.id} | ${granted ? 'granted' : 'not granted'}`
          + (capability ? ` | ${capability.description}` : '')
      }),
    ].join('\n'),
    toolName: 'agent_tool_access_inspect',
  }
}

export const runAgentDeepWaterAccessSetTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AgentDeepWaterAccessSetInputSchema.parse(input)
  const member = await resolveActingMember(context)
  requireOwnerMember(member, 'change DeepWater agent access')
  const target = await readToolPolicyTarget(context, member, args.agentId)
  const team = await context.prisma.team.findFirst({
    where: {
      id: args.teamId,
      project: { organizationId: member.organizationId },
    },
    select: { id: true },
  })
  if (!team) throw new Error('Team not found in this organization.')

  await setDeepWaterAgentAccess(context.prisma, {
    ...args,
    organizationId: member.organizationId,
  })
  await emitWorkerAuditEvent(context.prisma, member.actorContext, {
    action: 'agent.tool_access.updated',
    metadata: { enabled: args.enabled, teamId: args.teamId },
    outcome: 'success',
    resourceId: args.agentId,
    resourceType: 'agent',
  })
  await publishAgentUpdated(context, args.agentId)

  return {
    inputSummary:
      `agentId=${args.agentId} teamId=${args.teamId} enabled=${args.enabled}`,
    outputPreview:
      `${args.enabled ? 'Granted' : 'Revoked'} the complete DeepWater bundle for ${target.name}.`,
    toolName: 'agent_deepwater_access_set',
  }
}
