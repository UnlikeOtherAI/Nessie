import type { ToolSchemaDescriptor } from '@nessie/runtime'
import type { BuiltinToolDefinition } from '@nessie/runtime'

type ToolPolicy = Record<string, boolean>

type ResolvedToolSet = {
  descriptors: ToolSchemaDescriptor[]
  allowedIds: Set<string>
}

export type ToolDenialReason =
  | 'agent_policy_denied'
  | 'parent_agent_subtask_denied'
  | 'tool_not_granted'
  | 'unknown_tool'

export type ToolAuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason: ToolDenialReason }

const hasPolicyDeny = (agentToolPolicy: ToolPolicy | null, toolId: string): boolean =>
  agentToolPolicy?.[toolId] === false

export const authorizeToolCall = (
  toolId: string,
  enabledToolIds: Set<string>,
  allToolDefinitions: BuiltinToolDefinition[],
  agentToolPolicy: ToolPolicy | null,
  parentAgentId: string | null,
): ToolAuthorizationDecision => {
  if (!allToolDefinitions.some((tool) => tool.id === toolId)) {
    return { allowed: false, reason: 'unknown_tool' }
  }

  if (hasPolicyDeny(agentToolPolicy, toolId)) {
    return { allowed: false, reason: 'agent_policy_denied' }
  }

  if (parentAgentId && toolId === 'spawn_subtask') {
    return { allowed: false, reason: 'parent_agent_subtask_denied' }
  }

  if (!enabledToolIds.has(toolId)) {
    return { allowed: false, reason: 'tool_not_granted' }
  }

  return { allowed: true }
}

export const resolveAgentTools = (
  enabledToolIds: Set<string>,
  allToolDefinitions: BuiltinToolDefinition[],
  agentToolPolicy: ToolPolicy | null,
  parentAgentId: string | null,
): ResolvedToolSet => {
  const allowedIds = new Set<string>()
  for (const tool of allToolDefinitions) {
    if (
      authorizeToolCall(
        tool.id,
        enabledToolIds,
        allToolDefinitions,
        agentToolPolicy,
        parentAgentId,
      ).allowed
    ) {
      allowedIds.add(tool.id)
    }
  }

  const descriptors: ToolSchemaDescriptor[] = allToolDefinitions
    .filter((tool) => allowedIds.has(tool.id))
    .map((tool) => ({
      toolName: tool.id,
      description: tool.description,
      inputSchema: tool.parameters,
    }))

  return { descriptors, allowedIds }
}
