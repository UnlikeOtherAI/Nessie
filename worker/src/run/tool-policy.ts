import type { ToolSchemaDescriptor } from '@nessie/runtime'
import type { BuiltinToolDefinition } from '@nessie/runtime'
import {
  buildBuiltinToolsetView,
  resolveBuiltinInlineToolLimit,
} from './builtin-toolset-deferred.js'

type ToolPolicy = Record<string, boolean>

export type AgentKind = 'personal_assistant' | 'shared'

type ResolvedToolSet = {
  descriptors: ToolSchemaDescriptor[]
  allowedIds: Set<string>
  stubbedIds: Set<string>
  toolSpecEnabled: boolean
}

export type ToolDenialReason =
  | 'agent_policy_denied'
  | 'parent_agent_subtask_denied'
  | 'personal_assistant_only'
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
  agentKind: AgentKind,
): ToolAuthorizationDecision => {
  const definition = allToolDefinitions.find((tool) => tool.id === toolId)
  if (!definition) {
    return { allowed: false, reason: 'unknown_tool' }
  }

  if (hasPolicyDeny(agentToolPolicy, toolId)) {
    return { allowed: false, reason: 'agent_policy_denied' }
  }

  // "Act as the user" tools are reserved for the personal assistant, the only
  // agent that is a user's explicit delegate. Any other agent is denied so a
  // user's identity/authority cannot be exercised by an agent it never
  // delegated to (e.g. one pulled into a channel by an @mention).
  if (definition.personalAssistantOnly && agentKind !== 'personal_assistant') {
    return { allowed: false, reason: 'personal_assistant_only' }
  }

  // Explicit-grant tools are OFF by default: they surface only when the agent's
  // policy carries an explicit allow (`=== true`). An absent/inherited verdict
  // is a denial (the opposite of ordinary builtins, which are allowed unless the
  // policy sets `false`). This is the per-agent "allow this agent" gate for
  // powerful integration builtins such as `deep_water_run_update`, grantable to
  // any agent kind (PA or shared), not PA-only.
  if (definition.requiresExplicitGrant && agentToolPolicy?.[toolId] !== true) {
    return { allowed: false, reason: 'tool_not_granted' }
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
  agentKind: AgentKind,
  options: { inlineToolLimit?: number } = {},
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
        agentKind,
      ).allowed
    ) {
      allowedIds.add(tool.id)
    }
  }

  const allowedDefinitions = allToolDefinitions.filter((tool) => allowedIds.has(tool.id))
  const view = buildBuiltinToolsetView(
    allowedDefinitions,
    options.inlineToolLimit ?? resolveBuiltinInlineToolLimit(),
  )

  return {
    allowedIds,
    descriptors: view.descriptors,
    stubbedIds: view.stubbedIds,
    toolSpecEnabled: view.toolSpecEnabled,
  }
}
