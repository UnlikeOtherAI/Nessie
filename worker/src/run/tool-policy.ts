import type { ToolSchemaDescriptor } from '@nessie/runtime'
import type { BuiltinToolDefinition } from '@nessie/runtime'

type ToolPolicy = Record<string, boolean>

type ResolvedToolSet = {
  descriptors: ToolSchemaDescriptor[]
  allowedIds: Set<string>
}

export const resolveAgentTools = (
  enabledToolIds: Set<string>,
  allToolDefinitions: BuiltinToolDefinition[],
  agentToolPolicy: ToolPolicy | null,
  parentAgentId: string | null,
): ResolvedToolSet => {
  const allowedIds = new Set<string>()
  for (const tool of allToolDefinitions) {
    const policyOverride = agentToolPolicy?.[tool.id]
    if (policyOverride === false) continue
    if (policyOverride === true || enabledToolIds.has(tool.id)) {
      allowedIds.add(tool.id)
    }
  }

  if (parentAgentId) {
    allowedIds.delete('spawn_subtask')
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
