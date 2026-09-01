import type { AuthorizedActionContext } from '@nessie/schemas'
import { isCurrentAllowedMcpToolGrant } from '@nessie/mcp-manage'

export type McpRunScopeContext = {
  agentKind: 'personal_assistant' | 'shared'
  effectiveUserId: string | null
  isPersonalAssistantPresence: boolean
  channelId: string
  teamId: string | null
  projectId: string | null
}

const stringRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

/** Derives the live run scope; this is never taken from an agent's static owner. */
export const buildMcpRunScopeContext = (
  actorContext: AuthorizedActionContext,
  runtimeContext: {
    agentKind: 'personal_assistant' | 'shared'
    channelId: string
    isPersonalAssistantPresence?: boolean
  },
): McpRunScopeContext => ({
  agentKind: runtimeContext.agentKind,
  effectiveUserId:
    actorContext.actionContext.effectiveUserId
    ?? (actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : null),
  channelId: runtimeContext.channelId,
  isPersonalAssistantPresence: runtimeContext.isPersonalAssistantPresence === true,
  teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId ?? null,
  projectId: actorContext.tenant.projectId ?? null,
})

const scopeMatchesRun = (
  scopeType: string,
  scopeId: string,
  ctx: McpRunScopeContext,
): boolean => {
  switch (scopeType) {
    case 'system':
    case 'organization':
      return true
    case 'project':
      return ctx.projectId === scopeId
    case 'team':
      return ctx.teamId === scopeId
    case 'channel':
      return ctx.channelId === scopeId
    case 'user':
      return ctx.effectiveUserId === scopeId
    default:
      return false
  }
}

/**
 * The connection scope is a hard ceiling. Explicit grants may narrow it but
 * cannot turn a credential belonging to one person into an agent-wide one.
 */
export const isMcpRegistryRowExposed = (
  toolPolicy: Record<string, boolean> | null,
  registryEntryId: string,
  instance: { scopeType: string; scopeId: string },
  ctx: McpRunScopeContext,
  metadata: unknown,
  grants: readonly { agentId: string | null; config: unknown; state: string }[],
  agentId: string,
  descriptorFingerprint: string,
): boolean => {
  if (!scopeMatchesRun(instance.scopeType, instance.scopeId, ctx)) return false

  const verdict = toolPolicy?.[registryEntryId]
  const requiresExplicitGrant = stringRecord(metadata).requiresExplicitGrant === true
  if (requiresExplicitGrant) {
    // A shared agent cannot use an install bound to one person's identity.
    // Its setup must use a channel, team, or organization-scoped instance
    // instead; a descriptor-bound grant never broadens this scope ceiling.
    if (
      instance.scopeType === 'user'
      && (ctx.agentKind === 'shared' || !ctx.isPersonalAssistantPresence)
    ) return false
    return grants.some((grant) =>
      grant.agentId === agentId
      && isCurrentAllowedMcpToolGrant(grant, descriptorFingerprint))
  }

  // A user-scoped connection follows its person through a shared agent only
  // when that agent has the normal, explicit per-tool allow.
  if (instance.scopeType === 'user' && ctx.agentKind === 'shared' && verdict !== true) {
    return false
  }
  return verdict !== false
}
