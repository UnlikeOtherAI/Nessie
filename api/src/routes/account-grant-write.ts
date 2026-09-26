import type { FastifyBaseLogger, FastifyReply } from 'fastify'
import { setAgentToolPolicyForRegistryEntry } from '@nessie/mcp-manage'
import { parseAgentId, type AuthorizedActionContext, type GrantSubjectKind } from '@nessie/schemas'
import {
  loadManageableMailboxConnection,
  registryEntryRequiresExplicitPolicy,
  setMailboxAgentAccess,
} from '@nessie/team-admin'

import { sendApiError } from '../lib/api.js'
import { AgentToolPolicyError } from '../services/agent-tool-policy.js'
import { emitAuditEvent } from '../services/audit.js'
import { applyExecutorAgentAccessChange } from './executor-agent-access-change.js'
import { sendExecutorError } from './executor-route-errors.js'
import { mailboxActingMember, sendMailboxConnectionRefusal } from './mailbox-connections.js'
import { sendMcpError } from './mcp/shared.js'
import type { RouteDeps } from './types.js'

/**
 * The one grant write (plan §10.2): which agents may use an account, an app
 * connection or a computer. It fans out to the table the decision already
 * lives in, through the writer that table already has, under that writer's own
 * authority — it adds no grant of its own and widens none:
 *
 * - a mailbox's per-agent access row (`setMailboxAgentAccess`, for the person
 *   who connected it or an owner or admin for a shared one);
 * - a shared app connection's per-agent policy entry for every capability it
 *   provides (`setAgentToolPolicyForRegistryEntry`, owner-only as its route is);
 * - a computer's agent assignment (the computer page's own sequence).
 *
 * A mailbox's second decision — the agent's own mailbox tools — is never
 * written here (`docs/standards/connected-mailboxes.md`). Every other kind has
 * no per-agent switch and is refused with a sentence naming where its decision
 * lives.
 */

type WriteOutcome = 'written' | 'refused'

const NOT_GRANTABLE: Partial<Record<GrantSubjectKind, string>> = {
  'ai-plan': 'Choose the plan an agent runs on in that agent’s model settings.',
  browser: 'An organisation owner turns the cloud browser on for an agent, on that agent’s page.',
  comms:
    'Any agent you talk to may use your account in your own conversations; its tools are switched on the agent’s page.',
  tickets: 'Agents do not use this account. Projects sync their boards through it.',
}

const refuseNotGrantable = (reply: FastifyReply, message: string): WriteOutcome => {
  sendApiError(reply, 409, 'ACCOUNT_NOT_GRANTABLE', message)
  return 'refused'
}

const writeMailbox = async (
  deps: RouteDeps,
  reply: FastifyReply,
  actor: AuthorizedActionContext,
  input: { agentId: string; allowed: boolean; connectionId: string },
): Promise<WriteOutcome> => {
  try {
    const connection = await loadManageableMailboxConnection(deps.prisma, {
      actor: mailboxActingMember(actor),
      connectionId: input.connectionId,
      organizationId: actor.tenant.organizationId,
    })
    await setMailboxAgentAccess(deps.prisma, {
      agentId: input.agentId,
      allowed: input.allowed,
      connectionId: connection.id,
      grantedByUserId: actor.actor.actorId,
      organizationId: actor.tenant.organizationId,
    })
    await emitAuditEvent(deps.prisma, {
      action: input.allowed ? 'mailbox.access.granted' : 'mailbox.access.revoked',
      actorContext: actor,
      metadata: { agentId: input.agentId },
      outcome: 'success',
      resourceId: connection.id,
      resourceType: 'mailbox_connection',
    })
    return 'written'
  } catch (error) {
    if (sendMailboxConnectionRefusal(reply, error)) return 'refused'
    throw error
  }
}

const writeApp = async (
  deps: RouteDeps,
  reply: FastifyReply,
  actor: AuthorizedActionContext,
  input: { agentId: string; allowed: boolean; instanceId: string },
): Promise<WriteOutcome> => {
  const organizationId = actor.tenant.organizationId
  const instance = await deps.prisma.mcpServerInstance.findFirst({
    select: {
      scopeType: true,
      toolRegistryEntries: {
        select: { handlerKind: true, id: true, metadata: true, toolId: true },
        where: { enabled: true },
      },
    },
    where: { id: input.instanceId, organizationId },
  })
  if (!instance) {
    sendApiError(reply, 404, 'ACCOUNT_NOT_FOUND', 'That account could not be found.')
    return 'refused'
  }
  if (instance.scopeType === 'user') {
    return refuseNotGrantable(
      reply,
      'Any agent you talk to may use your own connection in your own conversations. Nothing needs allowing.',
    )
  }
  if (!deps.requireOwner(actor, reply)) return 'refused'
  const explicit = instance.toolRegistryEntries.filter(registryEntryRequiresExplicitPolicy)
  if (explicit.length === 0) {
    return refuseNotGrantable(reply, 'This connection has no capabilities to allow yet.')
  }
  try {
    for (const entry of explicit) {
      await setAgentToolPolicyForRegistryEntry(deps.prisma, {
        actorUserId: actor.actor.actorId,
        agentId: input.agentId,
        enabled: input.allowed,
        organizationId,
        toolRegistryEntryId: entry.id,
      })
    }
  } catch (error) {
    if (sendMcpError(reply, error)) return 'refused'
    throw error
  }
  await deps.realtimeHub?.publishWs(
    [
      { kind: 'organization', organizationId },
      { agentId: parseAgentId(input.agentId), kind: 'agent' },
    ],
    { data: { agentId: input.agentId }, event: 'agent.updated' },
  )
  return 'written'
}

const writeComputer = async (
  deps: RouteDeps,
  reply: FastifyReply,
  log: FastifyBaseLogger,
  actor: AuthorizedActionContext,
  input: { agentId: string; allowed: boolean; executorId: string },
): Promise<WriteOutcome> => {
  try {
    await applyExecutorAgentAccessChange(deps, log, actor, {
      agentId: input.agentId,
      executorId: input.executorId,
      state: input.allowed ? 'allowed' : 'denied',
    })
    return 'written'
  } catch (error) {
    if (error instanceof AgentToolPolicyError) {
      sendApiError(reply, 409, error.code, error.message)
      return 'refused'
    }
    if (sendExecutorError(reply, error)) return 'refused'
    throw error
  }
}

export const writeAccountAgentAccess = async (
  deps: RouteDeps,
  reply: FastifyReply,
  log: FastifyBaseLogger,
  actor: AuthorizedActionContext,
  target: { id: string; kind: GrantSubjectKind },
  input: { agentId: string; allowed: boolean },
): Promise<WriteOutcome> => {
  switch (target.kind) {
    case 'mailbox':
      return writeMailbox(deps, reply, actor, { ...input, connectionId: target.id })
    case 'app':
      return writeApp(deps, reply, actor, { ...input, instanceId: target.id })
    case 'computer':
      return writeComputer(deps, reply, log, actor, { ...input, executorId: target.id })
    default:
      return refuseNotGrantable(reply, NOT_GRANTABLE[target.kind] ?? 'This account has no per-agent switch.')
  }
}
