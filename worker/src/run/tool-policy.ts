import type { ToolSchemaDescriptor } from '@nessie/runtime'
import type { BuiltinToolDefinition } from '@nessie/runtime'
import {
  buildBuiltinToolsetView,
  resolveBuiltinInlineToolLimit,
} from './builtin-toolset-deferred.js'

type ToolPolicy = Record<string, boolean>

export type AgentKind = 'personal_assistant' | 'shared'

/**
 * A reduced PA-context run is the PA itself, or a delegated child carrying a
 * per-run principal. Both are reduced outside the PA DM, so a shared-channel
 * PA trigger cannot regain the owner's private toolset while delegated children
 * retain the same reduction.
 */
export const isPersonalAssistantPresenceRun = (input: {
  agentKind: AgentKind
  principalUserId?: string | null
  systemChannelType: string | null | undefined
}): boolean =>
  input.systemChannelType !== 'personal_assistant'
  && (input.agentKind === 'personal_assistant' || input.principalUserId != null)

type ResolvedToolSet = {
  descriptors: ToolSchemaDescriptor[]
  allowedIds: Set<string>
  stubbedIds: Set<string>
  toolSpecEnabled: boolean
}

// These reads normally resolve through the PA owner's personal audience. A PA
// presence runs in a shared destination, so keeping their schemas out of that
// run is the safe default until a request is elevated through the existing
// approval path. Memory recall itself is separately destination-contained.
export const PA_PRESENCE_PRIVATE_READ_TOOL_IDS = new Set([
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

export type ToolAuthorizationOptions = {
  /**
   * `personalAssistantOnly` tool ids this run may exercise even though its
   * agent is not the Personal Assistant (D3).
   *
   * Resolved once per run by `resolveIdentityDelegatedToolIds`
   * (`./delegated-identity.ts`), which is where the surface and
   * interactive-human conditions live: a set arrives here only when the run is
   * a DM-homed global agent, on its own home DM, on an interactive turn from a
   * live human requester. Keeping those conditions out of this function is
   * deliberate — it stays pure, and toolset assembly and per-call
   * authorization consume the same resolved answer instead of re-deriving it
   * and risking disagreement.
   */
  identityToolIds?: ReadonlySet<string>
}

const hasPolicyDeny = (agentToolPolicy: ToolPolicy | null, toolId: string): boolean =>
  agentToolPolicy?.[toolId] === false

export const authorizeToolCall = (
  toolId: string,
  enabledToolIds: Set<string>,
  allToolDefinitions: BuiltinToolDefinition[],
  agentToolPolicy: ToolPolicy | null,
  parentAgentId: string | null,
  agentKind: AgentKind,
  options: ToolAuthorizationOptions = {},
): ToolAuthorizationDecision => {
  const definition = allToolDefinitions.find((tool) => tool.id === toolId)
  if (!definition) {
    return { allowed: false, reason: 'unknown_tool' }
  }

  if (hasPolicyDeny(agentToolPolicy, toolId)) {
    return { allowed: false, reason: 'agent_policy_denied' }
  }

  // "Act as the user" tools are reserved for agents that are a person's
  // explicit delegate. Any other agent is denied so a user's identity/authority
  // cannot be exercised by an agent it never delegated to (e.g. one pulled into
  // a channel by an @mention).
  //
  // Two arms, and only two: the Personal Assistant, and a global agent whose
  // blueprint declares this exact tool id AND whose run satisfied every
  // condition in `resolveIdentityDelegatedToolIds` (own home DM, interactive,
  // live human requester). Neither the policy nor the model can widen the set —
  // it comes from code that ships with the deployment.
  if (
    definition.personalAssistantOnly
    && agentKind !== 'personal_assistant'
    && !options.identityToolIds?.has(toolId)
  ) {
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
  options: ToolAuthorizationOptions & {
    inlineToolLimit?: number
    isPersonalAssistantPresence?: boolean
  } = {},
): ResolvedToolSet => {
  const allowedIds = new Set<string>()
  for (const tool of allToolDefinitions) {
    if (
      !(options.isPersonalAssistantPresence && isWithheldFromPersonalAssistantPresence(tool))
      &&
      // The same resolved answer the per-call gate uses, so an identity tool
      // the run may not exercise is OMITTED from the model's schema array
      // rather than offered and then denied.
      authorizeToolCall(
        tool.id,
        enabledToolIds,
        allToolDefinitions,
        agentToolPolicy,
        parentAgentId,
        agentKind,
        { ...(options.identityToolIds ? { identityToolIds: options.identityToolIds } : {}) },
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
