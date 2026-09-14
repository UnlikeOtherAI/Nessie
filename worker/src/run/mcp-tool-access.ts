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
 *
 * A user-scoped connection is its person's own account, and the scope check
 * above already confines it to runs that person requested. Inside those runs
 * any agent they talk to — their assistant or a shared agent — may use it,
 * because the person who connected it is the one asking; only an explicit
 * per-tool deny withholds it. Anyone else's run never reaches it, so a shared
 * agent mentioned by a colleague still cannot act as the connecting person.
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
  if (instance.scopeType === 'user') return verdict !== false

  const requiresExplicitGrant = stringRecord(metadata).requiresExplicitGrant === true
  if (requiresExplicitGrant) {
    return grants.some((grant) =>
      grant.agentId === agentId
      && isCurrentAllowedMcpToolGrant(grant, descriptorFingerprint))
  }
  return verdict !== false
}
