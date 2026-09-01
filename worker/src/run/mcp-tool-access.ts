import type { AuthorizedActionContext } from '@nessie/schemas'

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
      return !ctx.isPersonalAssistantPresence && ctx.effectiveUserId === scopeId
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
): boolean => {
  if (!scopeMatchesRun(instance.scopeType, instance.scopeId, ctx)) return false

  const verdict = toolPolicy?.[registryEntryId]
  // A user-scoped connection follows its person through a shared agent only
  // when that agent has the normal, explicit per-tool allow.
  if (instance.scopeType === 'user' && ctx.agentKind === 'shared' && verdict !== true) {
    return false
  }

  const requiresExplicitGrant = stringRecord(metadata).requiresExplicitGrant === true
  if (requiresExplicitGrant) {
    return verdict === true || (
      ctx.agentKind === 'personal_assistant'
      && verdict !== false
    )
  }
  return verdict !== false
}
