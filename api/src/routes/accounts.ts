import type { FastifyInstance, FastifyReply } from 'fastify'
import { buildVisibleAgentWhere } from '@nessie/db'
import {
  AccountAgentGrantsSchema,
  AccountDetailSchema,
  AccountListResponseSchema,
  AgentAccountGrantsSchema,
  SetAccountAgentAccessBodySchema,
  isAdminActor,
  parseAccountId,
  parseAccountListScope,
  parseListedAccountId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { mailboxToolsState, readAccountAgentGrants } from '../services/accounts/account-grants-read.js'
import { listAccounts, loadAccount } from '../services/accounts/account-reads.js'
import { readMailboxAccounts, type AccountViewer } from '../services/accounts/account-sources.js'
import { readAccountUsedIn } from '../services/accounts/account-used-in.js'
import { writeAccountAgentAccess } from './account-grant-write.js'
import type { RouteDeps } from './types.js'

/**
 * Accounts (plan §6.7, §10.1, §10.2): one read model over every login a
 * person or the company holds at another service, and the one write that
 * decides which agents may use one.
 *
 * - `GET /api/accounts?scope=me|team:<id>|organisation` — the list.
 * - `GET /api/accounts/:id` — one account and what depends on it (Used in).
 * - `GET /api/accounts/:id/agents` — Agents with access.
 * - `PUT /api/accounts/:id/agents/:agentId` — allow or stop one agent.
 * - `GET /api/accounts/for-agent/:agentId` — the same decisions from the
 *   agent's side, which its Access tab mirrors.
 *
 * A person's own accounts are theirs alone. A team's and the company's are
 * read by the people who manage company connections — an owner or admin,
 * Company connections' own gate. An account the viewer may not see answers
 * exactly as one that does not exist.
 */

const AgentParams = z.object({ agentId: z.string().uuid() }).strict()

export const accountViewer = (actor: AuthorizedActionContext): AccountViewer => ({
  isManager: isAdminActor(actor),
  isOwner: (actor.actor.roles ?? []).includes('owner'),
  organizationId: actor.tenant.organizationId,
  userId: actor.actor.actorId,
})

const notFound = (reply: FastifyReply): FastifyReply => {
  sendApiError(reply, 404, 'ACCOUNT_NOT_FOUND', 'That account could not be found.')
  return reply
}

export const registerAccountRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma } = deps

  /** A person asking, never a program or an agent: these are a person's accounts. */
  const requirePerson = (
    request: Parameters<typeof deps.requireActorContext>[0],
    reply: FastifyReply,
  ): AuthorizedActionContext | null => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return null
    return actor
  }

  app.get('/api/accounts', async (request, reply) => {
    const actor = requirePerson(request, reply)
    if (!actor) return reply
    const { scope: raw } = (request.query ?? {}) as { scope?: string }
    const scope = parseAccountListScope(raw)
    if (!scope) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'Name a scope: me, organisation or team:<id>.', 'scope')
      return reply
    }
    if (scope.kind !== 'me') {
      if (!deps.requireOrgAdmin(actor, reply)) return reply
      if (scope.kind === 'team') {
        // Teams carry no organisation of their own — tenancy runs through
        // their project — so a team from another organisation is not found.
        const team = await prisma.team.findFirst({
          select: { id: true },
          where: { id: scope.teamId, project: { organizationId: actor.tenant.organizationId } },
        })
        if (!team) {
          sendApiError(reply, 404, 'TEAM_NOT_FOUND', 'That team could not be found.')
          return reply
        }
      }
    }
    const accounts = await listAccounts(prisma, accountViewer(actor), scope)
    return createApiResponse(AccountListResponseSchema.parse({ accounts }))
  })

  app.get('/api/accounts/for-agent/:agentId', async (request, reply) => {
    const actor = requirePerson(request, reply)
    if (!actor) return reply
    const params = parseInput(AgentParams, request.params, reply, 'params')
    if (!params) return reply
    const viewer = accountViewer(actor)
    const agent = await prisma.agent.findFirst({
      select: { id: true, toolPolicy: true },
      where: {
        AND: [
          { id: params.agentId },
          buildVisibleAgentWhere({ organizationId: viewer.organizationId, userId: viewer.userId }),
        ],
      },
    })
    if (!agent) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'That agent could not be found.')
      return reply
    }
    // The accounts with a per-agent switch the viewer can see: their own
    // mailboxes, and the shared ones of their teams (all of them for an
    // owner or admin), exactly as the mailbox list reads them.
    const teamIds = viewer.isManager
      ? null
      : (await prisma.teamMember.findMany({
          select: { teamId: true },
          where: { team: { project: { organizationId: viewer.organizationId } }, userId: viewer.userId },
        })).map((row) => row.teamId)
    const mailboxes = await readMailboxAccounts(prisma, viewer, {
      OR: [
        { ownerUserId: viewer.userId },
        teamIds === null ? { teamId: { not: null } } : { teamId: { in: teamIds } },
      ],
    })
    const access = await prisma.mailboxConnectionAgentAccess.findMany({
      select: { connectionId: true },
      where: { agentId: agent.id, organizationId: viewer.organizationId },
    })
    const allowed = new Set(access.map((row) => row.connectionId))
    const tools = mailboxToolsState(agent.toolPolicy)
    return createApiResponse(AgentAccountGrantsSchema.parse({
      accounts: mailboxes.map((account) => ({
        account,
        allowed: allowed.has(account.id.slice('mailbox:'.length)),
        canManage: account.agents.canManage,
        tools,
      })),
      agentId: agent.id,
    }))
  })

  app.get('/api/accounts/:accountId', async (request, reply) => {
    const actor = requirePerson(request, reply)
    if (!actor) return reply
    const target = parseListedAccountId((request.params as { accountId: string }).accountId)
    if (!target) return notFound(reply)
    const viewer = accountViewer(actor)
    const account = await loadAccount(prisma, viewer, target)
    if (!account) return notFound(reply)
    const usedIn = await readAccountUsedIn(
      prisma,
      viewer,
      target,
      () => deps.listAccessibleProjectIds(actor),
    )
    return createApiResponse(AccountDetailSchema.parse({ account, usedIn }))
  })

  app.get('/api/accounts/:accountId/agents', async (request, reply) => {
    const actor = requirePerson(request, reply)
    if (!actor) return reply
    const target = parseAccountId((request.params as { accountId: string }).accountId)
    if (!target) return notFound(reply)
    const viewer = accountViewer(actor)
    const grants = await readAccountAgentGrants(prisma, viewer, actor, target, async () =>
      target.kind !== 'computer' && (await loadAccount(prisma, viewer, { id: target.id, kind: target.kind })) !== null)
    if (!grants) return notFound(reply)
    return createApiResponse(AccountAgentGrantsSchema.parse(grants))
  })

  app.put('/api/accounts/:accountId/agents/:agentId', async (request, reply) => {
    const actor = requirePerson(request, reply)
    if (!actor) return reply
    const { accountId, agentId } = request.params as { accountId: string; agentId: string }
    const target = parseAccountId(accountId)
    if (!target) return notFound(reply)
    const agent = parseInput(AgentParams, { agentId }, reply, 'params')
    if (!agent) return reply
    const body = parseInput(SetAccountAgentAccessBodySchema, request.body, reply)
    if (!body) return reply
    const outcome = await writeAccountAgentAccess(deps, reply, request.log, actor, target, {
      agentId: agent.agentId,
      allowed: body.allowed,
    })
    if (outcome === 'refused') return reply
    const viewer = accountViewer(actor)
    const grants = await readAccountAgentGrants(prisma, viewer, actor, target, async () => true)
    const row = grants?.agents.find((entry) => entry.agentId === agent.agentId) ?? null
    return createApiResponse({ agent: row, subjectId: grants?.subjectId ?? accountId })
  })
}
