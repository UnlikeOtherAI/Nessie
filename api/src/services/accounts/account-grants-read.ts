import type { Prisma, PrismaClient } from '@prisma/client'
import { buildVisibleAgentWhere } from '@nessie/db'
import {
  BROWSER_OPEN_TOOL_ID,
  CALENDAR_EVENTS_LIST_TOOL_ID,
  GMAIL_SEARCH_TOOL_ID,
  MAILBOX_READ_TOOL_ID,
  MAILBOX_SEARCH_TOOL_ID,
  isExplicitToolGranted,
} from '@nessie/runtime'
import {
  ExecutorAgentAccessListQuerySchema,
  formatAccountId,
  type AccountAgentGrant,
  type AccountAgentGrants,
  type AuthorizedActionContext,
  type GrantSubjectKind,
} from '@nessie/schemas'
import {
  listAgentToolPolicyTargets,
  registryEntryPolicyKey,
  registryEntryRequiresExplicitPolicy,
} from '@nessie/team-admin'

import { listExecutorAgentAccess } from '../executor-management-reads.js'
import type { AccountViewer } from './account-sources.js'

/**
 * "Agents with access" for one grant subject (plan §10.2): every agent the
 * viewer may see, beside the subject's own decision about it. The decision is
 * read from the store that holds it — a mailbox's access rows, an app's
 * policy entries, a computer's operation grants — and is never widened here.
 *
 * Where an account needs a second decision on the agent itself (a mailbox
 * needs the agent's own mailbox tools), `tools` carries it read-only beside
 * the row: the two are separate writes and neither rewrites the other.
 */

type AgentRow = {
  id: string
  modelSubscriptionId: string | null
  name: string
  ownerUserId: string | null
  role: string | null
  toolPolicy: unknown
  visibility: 'team' | 'private'
}

const listVisibleAgents = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  extra: Prisma.AgentWhereInput = {},
): Promise<AgentRow[]> =>
  prisma.agent.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      modelSubscriptionId: true,
      name: true,
      ownerUserId: true,
      role: true,
      toolPolicy: true,
      visibility: true,
    },
    where: {
      AND: [
        buildVisibleAgentWhere({ organizationId: viewer.organizationId, userId: viewer.userId }),
        // A system agent never holds a per-account row (`setMailboxAgentAccess`
        // refuses one); it is covered by each rule's own sentence instead.
        { systemManaged: false },
        extra,
      ],
    },
  })

const grant = (
  agent: AgentRow,
  allowed: boolean | null,
  tools: 'on' | 'off' | null,
): AccountAgentGrant => ({
  agentId: agent.id,
  allowed,
  name: agent.name,
  role: agent.role,
  tools,
  visibility: agent.visibility,
})

/** The agent's own switch for connected mailboxes: may it search or read one at all. */
export const mailboxToolsState = (toolPolicy: unknown): 'on' | 'off' =>
  isExplicitToolGranted(toolPolicy, MAILBOX_READ_TOOL_ID)
    || isExplicitToolGranted(toolPolicy, MAILBOX_SEARCH_TOOL_ID)
    ? 'on'
    : 'off'

/** The agent's own switch for a Google account: may it read mail or a calendar. */
export const googleToolsState = (toolPolicy: unknown): 'on' | 'off' =>
  isExplicitToolGranted(toolPolicy, GMAIL_SEARCH_TOOL_ID)
    || isExplicitToolGranted(toolPolicy, CALENDAR_EVENTS_LIST_TOOL_ID)
    ? 'on'
    : 'off'

const readMailboxGrants = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  connectionId: string,
): Promise<AccountAgentGrants | null> => {
  const connection = await prisma.mailboxConnection.findFirst({
    select: { agentAccess: { select: { agentId: true } }, ownerUserId: true, teamId: true },
    where: { id: connectionId, organizationId: viewer.organizationId },
  })
  if (!connection) return null
  const own = connection.ownerUserId === viewer.userId
  if (!own && !connection.teamId) return null
  if (!own && !viewer.isManager) {
    const member = await prisma.teamMember.findFirst({
      select: { teamId: true },
      where: { teamId: connection.teamId ?? '', userId: viewer.userId },
    })
    if (!member) return null
  }
  const canManage = own || viewer.isManager
  const allowed = new Set(connection.agentAccess.map((row) => row.agentId))
  const agents = await listVisibleAgents(prisma, viewer)
  return {
    agents: agents.map((agent) => grant(agent, allowed.has(agent.id), mailboxToolsState(agent.toolPolicy))),
    canManage,
    manageReason: canManage
      ? null
      : 'Only an organisation owner or admin changes which agents may use a shared mailbox.',
    rule: 'listed',
    subjectId: formatAccountId('mailbox', connectionId),
    toolsLabel: 'Mailbox tools',
  }
}

const readAppGrants = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  instanceId: string,
): Promise<AccountAgentGrants | null> => {
  const instance = await prisma.mcpServerInstance.findFirst({
    select: {
      scopeId: true,
      scopeType: true,
      toolRegistryEntries: {
        select: { handlerKind: true, id: true, metadata: true, toolId: true },
        where: { enabled: true },
      },
    },
    where: { id: instanceId, organizationId: viewer.organizationId },
  })
  if (!instance) return null
  const subjectId = formatAccountId('app', instanceId)
  if (instance.scopeType === 'user') {
    // A person's own connection reaches any agent they talk to, in their own
    // conversations, unless an agent's policy says no to one of its tools
    // (`isMcpRegistryRowExposed`). There is nothing here to allow.
    if (instance.scopeId !== viewer.userId) return null
    const agents = await listVisibleAgents(prisma, viewer)
    const entryIds = instance.toolRegistryEntries.map((entry) => entry.id)
    return {
      agents: agents.map((agent) => {
        const policy = (agent.toolPolicy ?? {}) as Record<string, unknown>
        return grant(agent, !entryIds.some((id) => policy[id] === false), null)
      }),
      canManage: false,
      manageReason: 'Any agent you talk to may use your own connection in your own conversations.',
      rule: 'requester',
      subjectId,
      toolsLabel: null,
    }
  }
  // A shared connection is granted per agent, one policy entry per
  // capability it provides — the app page's own switch, and owner-only as
  // the route that writes it is.
  if (!viewer.isOwner) return null
  const explicit = instance.toolRegistryEntries.filter(registryEntryRequiresExplicitPolicy)
  const targets = await listAgentToolPolicyTargets(prisma, viewer.organizationId, viewer.userId)
  return {
    agents: targets
      .filter((target) => target.agentKind === 'shared')
      .map((target) => ({
        agentId: target.id,
        allowed: explicit.length > 0
          && explicit.every((entry) => target.toolPolicy[registryEntryPolicyKey(entry)] === true),
        name: target.name,
        role: target.role ?? null,
        tools: null,
        visibility: 'team' as const,
      })),
    canManage: explicit.length > 0,
    manageReason: explicit.length > 0 ? null : 'This connection has no capabilities to allow yet.',
    rule: 'listed',
    subjectId,
    toolsLabel: null,
  }
}

const readComputerGrants = async (
  prisma: PrismaClient,
  actor: AuthorizedActionContext,
  executorId: string,
): Promise<AccountAgentGrants | null> => {
  const query = ExecutorAgentAccessListQuerySchema.parse({ limit: 100 })
  try {
    const [assigned, candidates] = await Promise.all([
      listExecutorAgentAccess(prisma, actor, executorId, query, false),
      listExecutorAgentAccess(prisma, actor, executorId, query, true),
    ])
    const rows = [
      ...assigned.data.map((row) => ({ ...row, allowed: true })),
      ...candidates.data.map((row) => ({ ...row, allowed: false })),
    ].sort((a, b) => a.name.localeCompare(b.name))
    return {
      agents: rows.map((row) => ({
        agentId: row.agentId,
        allowed: row.allowed,
        name: row.name,
        role: null,
        tools: null,
        visibility: row.visibility,
      })),
      canManage: true,
      manageReason: null,
      rule: 'listed',
      subjectId: formatAccountId('computer', executorId),
      toolsLabel: null,
    }
  } catch {
    // The computer's own reads refuse anybody who does not manage it; so does this.
    return null
  }
}

export const readAccountAgentGrants = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  actor: AuthorizedActionContext,
  target: { id: string; kind: GrantSubjectKind },
  visible: () => Promise<boolean>,
): Promise<AccountAgentGrants | null> => {
  switch (target.kind) {
    case 'mailbox':
      return readMailboxGrants(prisma, viewer, target.id)
    case 'app':
      return readAppGrants(prisma, viewer, target.id)
    case 'computer':
      return readComputerGrants(prisma, actor, target.id)
    default:
      break
  }
  // The remaining kinds have no per-agent switch; each still says which of
  // the viewer's agents the account reaches, by the store's own rule.
  if (!(await visible())) return null
  const subjectId = formatAccountId(target.kind, target.id)
  if (target.kind === 'comms') {
    const connection = await prisma.commsConnection.findFirst({
      select: { provider: true },
      where: { id: target.id, organizationId: viewer.organizationId, ownerUserId: viewer.userId },
    })
    if (!connection) return null
    if (connection.provider !== 'google') {
      return {
        agents: [],
        canManage: false,
        manageReason: 'No agent reads this account directly. What it imports can wake an automation.',
        rule: 'not_used',
        subjectId,
        toolsLabel: null,
      }
    }
    const agents = await listVisibleAgents(prisma, viewer)
    return {
      agents: agents.map((agent) => grant(agent, null, googleToolsState(agent.toolPolicy))),
      canManage: false,
      manageReason:
        'Any agent you talk to may use your Google account in your own conversations when its Google tools are on.',
      rule: 'requester',
      subjectId,
      toolsLabel: 'Google tools',
    }
  }
  if (target.kind === 'ai-plan') {
    const agents = await listVisibleAgents(prisma, viewer, { ownerUserId: viewer.userId })
    return {
      agents: agents.map((agent) => grant(agent, agent.modelSubscriptionId === target.id, null)),
      canManage: false,
      manageReason: 'Choose the plan an agent runs on in that agent’s model settings.',
      rule: 'owned_agents',
      subjectId,
      toolsLabel: null,
    }
  }
  if (target.kind === 'browser') {
    const agents = await listVisibleAgents(prisma, viewer)
    return {
      agents: agents.map((agent) => grant(
        agent,
        isExplicitToolGranted(agent.toolPolicy, BROWSER_OPEN_TOOL_ID),
        null,
      )),
      canManage: false,
      manageReason: 'An organisation owner turns the cloud browser on for an agent, on that agent’s page.',
      rule: 'browser_grant',
      subjectId,
      toolsLabel: null,
    }
  }
  return {
    agents: [],
    canManage: false,
    manageReason: 'Agents do not use this account. Projects sync their boards through it.',
    rule: 'not_used',
    subjectId,
    toolsLabel: null,
  }
}
