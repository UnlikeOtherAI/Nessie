import type { Prisma, PrismaClient } from '@prisma/client'
import type {
  AppAgentAccessRecord,
  AuthorizedActionContext,
  McpServerScopeType,
} from '@nessie/schemas'
import {
  buildAccessibleChannelWhere,
  buildAgentVisibilityWhere,
} from '@nessie/workspace-admin'

import { isOwnerRole } from '../mcp-catalog.js'

/**
 * "Which of my agents can actually use this app" — the question the detail
 * page's *Agents with access* tab exists to answer.
 *
 * The rule is the run-time exposure rule stated at agent granularity, and it
 * has to be: an agent that cannot reach the install scope does not get the
 * tool no matter what its policy says, and a policy deny hides a tool the
 * scope would otherwise have granted. The authority for that rule is the
 * worker's `isExposed` (`worker/src/run/mcp-toolset.ts`) — the worker is not a
 * dependency of this package, so the shape is restated here and must move with
 * it. Two differences, both structural rather than a re-decision:
 *
 * - A run's team/project come from the channel it happens in, so an agent's
 *   reach is the set of channels it is bound to.
 * - A user-scoped install reaches only the installing user's delegated
 *   personal-assistant runs. There is one system-managed personal assistant
 *   per organisation, and `listInstancesVisibleToUser` only ever returns the
 *   caller's own user-scope rows, so a visible user-scope install means "your
 *   assistant, in your own runs".
 */

export type AppAccessInstance = {
  id: string
  scopeType: McpServerScopeType
  scopeId: string
}

export type AppAccessRegistryRow = {
  id: string
  mcpInstanceId: string | null
  enabled: boolean
  status: string
  metadata: unknown
}

type AccessAgent = {
  id: string
  name: string
  role: string
  agentKind: string
  toolPolicy: unknown
  bindings: Array<{ channel: { id: string; teamId: string; projectId: string } }>
}

const jsonRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

/**
 * Projected MCP tools are authorized by their registry-row id, so replacing a
 * projection cannot inherit a stale grant. Only `handlerKind: 'mcp'` rows
 * reach here, which is what makes the key unconditional.
 */
const policyVerdict = (
  toolPolicy: unknown,
  registryEntryId: string,
): boolean | undefined => {
  const verdict = jsonRecord(toolPolicy)[registryEntryId]
  return typeof verdict === 'boolean' ? verdict : undefined
}

const requiresExplicitGrant = (metadata: unknown): boolean =>
  jsonRecord(metadata).requiresExplicitGrant === true

const scopeReachesAgent = (
  instance: AppAccessInstance,
  agent: AccessAgent,
): boolean => {
  switch (instance.scopeType) {
    case 'system':
    case 'organization':
      return true
    case 'project':
      return agent.bindings.some((b) => b.channel.projectId === instance.scopeId)
    case 'team':
      return agent.bindings.some((b) => b.channel.teamId === instance.scopeId)
    case 'channel':
      return agent.bindings.some((b) => b.channel.id === instance.scopeId)
    case 'user':
      return agent.agentKind === 'personal_assistant'
  }
}

const agentCanUseApp = (
  agent: AccessAgent,
  instances: readonly AppAccessInstance[],
  rowsByInstance: Map<string, AppAccessRegistryRow[]>,
): boolean =>
  instances.some((instance) => {
    if (!scopeReachesAgent(instance, agent)) return false
    return (rowsByInstance.get(instance.id) ?? []).some((row) => {
      const verdict = policyVerdict(agent.toolPolicy, row.id)
      // An explicit-grant tool is OFF until granted; everything else is on
      // unless denied. Neither ever escapes the install scope checked above.
      return requiresExplicitGrant(row.metadata)
        ? verdict === true
        : verdict !== false
    })
  })

/**
 * Only tools that are actually callable count: a `pending_review` projection
 * is a capability the app has, not access an agent holds.
 */
const callableRowsByInstance = (
  rows: readonly AppAccessRegistryRow[],
): Map<string, AppAccessRegistryRow[]> => {
  const byInstance = new Map<string, AppAccessRegistryRow[]>()
  for (const row of rows) {
    if (!row.mcpInstanceId || !row.enabled || row.status !== 'active') continue
    const existing = byInstance.get(row.mcpInstanceId)
    if (existing) existing.push(row)
    else byInstance.set(row.mcpInstanceId, [row])
  }
  return byInstance
}

/**
 * The channels this caller may see an agent working in, from the one predicate
 * that decides it for `GET /api/agents` and the Agents page.
 *
 * Imported rather than restated on purpose: `/api/apps/:slug` is
 * member-readable and must not name an agent the agents list would withhold,
 * so if that rule ever changes this surface has to change with it. A copy here
 * would drift silently and leak exactly the agents the original started hiding.
 */
const visibleChannelWhere = (
  actorContext: AuthorizedActionContext,
): Prisma.ChannelWhereInput =>
  buildAccessibleChannelWhere({
    includeAllOrgChannels: isOwnerRole(actorContext),
    organizationId: actorContext.tenant.organizationId,
    userId: actorContext.actor.actorId,
  })

/**
 * The agents this caller is entitled to see, narrowed to the ones a person
 * grants app access to: shared agents plus the one system-managed personal
 * assistant (sub-agents and other system-managed records are not).
 *
 * Entitlement is `GET /api/agents`' rule, not the owner-only tool-policy
 * target list: an agent is reachable through a channel the caller can see it
 * working in, and an owner additionally reaches unbound agents. Nothing
 * narrows by the session's project or team.
 */
const accessCandidateWhere = (
  actorContext: AuthorizedActionContext,
): Prisma.AgentWhereInput => {
  const channelWhere = visibleChannelWhere(actorContext)
  const reachable: Prisma.AgentWhereInput[] = [
    { bindings: { some: { channel: channelWhere } } },
  ]
  if (isOwnerRole(actorContext)) reachable.push({ bindings: { none: {} } })
  return {
    organizationId: actorContext.tenant.organizationId,
    AND: [
      // The app detail is member-readable, so it must compose the same private
      // visibility fence as GET /api/agents. In particular, an org owner can
      // reach every channel but never another member's private agent.
      buildAgentVisibilityWhere({
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      }),
      {
        OR: [
          { agentKind: 'personal_assistant', systemManaged: true },
          { agentKind: 'shared', systemManaged: false },
        ],
      },
      { OR: reachable },
    ],
  }
}

export const listAgentsWithAppAccess = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  instances: readonly AppAccessInstance[],
  registryRows: readonly AppAccessRegistryRow[],
): Promise<AppAgentAccessRecord[]> => {
  const rowsByInstance = callableRowsByInstance(registryRows)
  if (instances.length === 0 || rowsByInstance.size === 0) return []

  // Bindings are loaded unfiltered on purpose. Whether the caller may see this
  // agent at all is settled by the `where` above; whether the app's install
  // scope reaches it is a fact about the agent, and narrowing its bindings to
  // the caller's own channels would answer "no access" for an agent that
  // plainly has it. The channels themselves are never rendered.
  const agents = await prisma.agent.findMany({
    where: accessCandidateWhere(actorContext),
    orderBy: [{ agentKind: 'asc' }, { name: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      name: true,
      role: true,
      agentKind: true,
      toolPolicy: true,
      bindings: {
        select: {
          channel: { select: { id: true, teamId: true, projectId: true } },
        },
      },
    },
  })

  return agents
    .filter((agent) => agentCanUseApp(agent, instances, rowsByInstance))
    .map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
    }))
}
