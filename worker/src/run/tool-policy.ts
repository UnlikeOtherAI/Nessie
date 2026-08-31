import type { ToolSchemaDescriptor } from '@nessie/runtime'
import type { BuiltinToolDefinition } from '@nessie/runtime'

type ToolPolicy = Record<string, boolean>

export type AgentKind = 'personal_assistant' | 'shared'

/**
 * A PA presence is marked by a per-run principal, not only by its singleton
 * agent kind. Delegated children are shared agents but retain that principal,
 * so the reduced toolset follows the owner's delegated identity.
 */
export const isPersonalAssistantPresenceRun = (input: {
  principalUserId?: string | null
  systemChannelType: string | null | undefined
}): boolean =>
  input.systemChannelType !== 'personal_assistant'
  && input.principalUserId != null

type ResolvedToolSet = {
  descriptors: ToolSchemaDescriptor[]
  allowedIds: Set<string>
}

// These reads normally resolve through the PA owner's personal audience. A PA
// presence runs in a shared destination, so keeping their schemas out of that
// run is the safe default until a request is elevated through the existing
// approval path. Memory recall itself is separately destination-contained.
const PA_PRESENCE_PRIVATE_READ_TOOL_IDS = new Set([
  'attachment_list',
  'attachment_read',
  'authored_message_search',
  'kb_comments_list',
  'kb_list',
  'kb_page_read',
  'kb_search',
  'message_search',
  // A shared-channel PA presence can answer in the room, but it cannot use
  // owner-scoped communication mutations as side channels. The normal final
  // reply remains the one run-owned delivery path and is stamped on behalf.
  'message_post',
  'message_edit',
  'message_delete',
  'react',
  'workspace_search',
])

const isWithheldFromPersonalAssistantPresence = (tool: BuiltinToolDefinition): boolean =>
  tool.personalAssistantOnly === true || PA_PRESENCE_PRIVATE_READ_TOOL_IDS.has(tool.id)

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
  options: { isPersonalAssistantPresence?: boolean } = {},
): ResolvedToolSet => {
  const allowedIds = new Set<string>()
  for (const tool of allToolDefinitions) {
    if (
      !(options.isPersonalAssistantPresence && isWithheldFromPersonalAssistantPresence(tool))
      &&
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

  const descriptors: ToolSchemaDescriptor[] = allToolDefinitions
    .filter((tool) => allowedIds.has(tool.id))
    .map((tool) => ({
      toolName: tool.id,
      description: tool.description,
      inputSchema: tool.parameters,
    }))

  return { descriptors, allowedIds }
}
