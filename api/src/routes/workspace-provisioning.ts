import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma, type PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { writeAuditEntryInTransaction } from '@nessie/db'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  createUoaOrganisation,
  createUoaWorkspaceTeam,
  resolveUoaRosterWorkspace,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
  type UoaProvisionedWorkspace,
  type UoaRosterDeps,
} from '../services/uoa-org-roster.js'
import type { RouteDeps } from './types.js'

/**
 * Founding a UOA organisation, or a further workspace inside one, from inside
 * Nessie — so that neither costs a second interactive login.
 *
 * These routes create **nothing locally**. UOA owns the organisation/team
 * hierarchy, and the local `Organization`/`Team`/`Project`/`#general` mirror is
 * born in `materializeUoaWorkspace`, from a workspace UOA itself proved in an
 * authenticated response. That is why both handlers answer only a pair of UOA
 * ids: the client then calls the ordinary `POST /api/auth/uoa/workspace`, and
 * the existing silent switch grant does the materializing. Writing a local row
 * here would be inventing an organisation ahead of UOA's proof.
 *
 * The two routes deliberately use different UOA credential modes; the reasons
 * are on the service functions in `@nessie/workspace-admin`.
 */

const CreateOrganizationBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Distinguishes a retry of one intent from a second intent. See the ledger
  // note below: without it, a retry after an ambiguous network failure mints a
  // second organisation nobody asked for.
  idempotencyKey: z.string().trim().min(8).max(200),
})

const ORG_CREATED_ACTION = 'organization.external_created'
const WORKSPACE_CREATED_ACTION = 'workspace.external_created'

const NEEDS_UOA_SESSION =
  'Sign in with UnlikeOtherAI to create an organisation.'

/**
 * Serialize one person's provisioning attempts across every API replica.
 *
 * Transaction-scoped, matching `lockUserSessions` and the audit chain's own
 * lock. Two clicks a few milliseconds apart would otherwise both pass the
 * replay check below and create two organisations.
 */
const lockUserProvisioning = async (
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`nessie:org-provisioning:${userId}`}, 0)
    )
  `)
}

/**
 * The result of an earlier attempt carrying this idempotency key, if any.
 *
 * **The audit log is the ledger.** It already records who created what, it is
 * append-only and hash-chained, and using it means no second table mirroring
 * UOA's organisation ids — which is the whole point of this feature. A window
 * bounds the scan so this stays an index-friendly lookup over recent rows
 * rather than a walk of the organisation's history.
 */
const findPriorProvisioning = async (
  tx: Prisma.TransactionClient,
  input: {
    action: string
    organizationId: string
    userId: string
    idempotencyKey: string
  },
): Promise<UoaProvisionedWorkspace | null> => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const prior = await tx.auditLog.findFirst({
    where: {
      organizationId: input.organizationId,
      action: input.action,
      actorId: input.userId,
      outcome: 'success',
      createdAt: { gte: since },
      metadata: { path: ['idempotencyKey'], equals: input.idempotencyKey },
    },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true },
  })
  const metadata = prior?.metadata as Record<string, unknown> | null | undefined
  const externalOrgId = typeof metadata?.externalOrgId === 'string' ? metadata.externalOrgId : null
  const externalTeamId = typeof metadata?.externalTeamId === 'string' ? metadata.externalTeamId : null
  return externalOrgId && externalTeamId ? { externalOrgId, externalTeamId } : null
}

const auditRequestFields = (request: FastifyRequest) => ({
  requestId: request.id,
  ipAddress: request.ip ?? null,
  userAgent: typeof request.headers['user-agent'] === 'string'
    ? request.headers['user-agent']
    : null,
})

/**
 * Run one provisioning attempt exactly once per idempotency key.
 *
 * The UOA call happens INSIDE the interactive transaction, which is unusual
 * here and deliberate. Holding the per-user advisory lock across it is what
 * makes a double-submit impossible rather than merely unlikely, and the
 * alternative — a lock released before the call — leaves exactly the window
 * this exists to close. It is safe because the call is a single POST bounded by
 * the `/org/*` seam's own 10s timeout, well inside the transaction budget; the
 * long multi-step UOA exchanges that must stay outside transactions are a
 * different shape entirely.
 */
const provisionOnce = async (
  prisma: PrismaClient,
  request: FastifyRequest,
  input: {
    action: string
    organizationId: string
    userId: string
    idempotencyKey: string
    name: string
    resourceType: string
  },
  create: () => Promise<UoaProvisionedWorkspace>,
): Promise<UoaProvisionedWorkspace> => prisma.$transaction(
  async (tx) => {
    await lockUserProvisioning(tx, input.userId)

    const prior = await findPriorProvisioning(tx, input)
    if (prior) return prior

    const workspace = await create()

    await writeAuditEntryInTransaction(tx, {
      organizationId: input.organizationId,
      actorType: 'user',
      actorId: input.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: workspace.externalOrgId,
      outcome: 'success',
      metadata: {
        idempotencyKey: input.idempotencyKey,
        name: input.name,
        externalOrgId: workspace.externalOrgId,
        externalTeamId: workspace.externalTeamId,
      },
      ...auditRequestFields(request),
    })

    return workspace
  },
  { maxWait: 5_000, timeout: 25_000 },
)

/** Map a provisioning failure onto the API's error envelope. */
const sendProvisioningError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean => {
  if (error instanceof UoaRosterRejectedError) {
    // 400 with no owner is the one refusal a person can act on: it means UOA
    // has no record of them on this domain, which signing in again repairs.
    const missingOwner = error.upstreamCode === 'OWNER_REQUIRED'
      || error.upstreamCode === 'OWNER_NOT_ALLOWED'
    sendApiError(
      reply,
      error.statusCode === 429 ? 429 : missingOwner ? 409 : 400,
      error.statusCode === 429 ? 'UOA_RATE_LIMITED' : 'UOA_PROVISIONING_REJECTED',
      error.statusCode === 429
        ? 'UnlikeOtherAI is rate-limiting new organisations for this deployment. Try again shortly.'
        : missingOwner
          ? 'UnlikeOtherAI could not confirm your account on this deployment. Sign out and in again, then retry.'
          : 'UnlikeOtherAI refused the request.',
    )
    return true
  }
  if (error instanceof UoaRosterIdentityError) {
    sendApiError(reply, 403, 'UOA_SESSION_REQUIRED', NEEDS_UOA_SESSION)
    return true
  }
  if (error instanceof UoaRosterUnavailableError) {
    request.log.warn({ err: error }, 'uoa provisioning failed')
    sendApiError(
      reply,
      502,
      'UOA_DIRECTORY_UNAVAILABLE',
      'UnlikeOtherAI is temporarily unavailable. Nothing was changed; try again.',
    )
    return true
  }
  return false
}

const requireUoaSubject = (
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): string | null => {
  const subject = actorContext.actionContext.uoaIdentity?.subject
  if (!subject) {
    sendApiError(reply, 403, 'UOA_SESSION_REQUIRED', NEEDS_UOA_SESSION)
    return null
  }
  return subject
}

export const registerWorkspaceProvisioningRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  rosterDeps: UoaRosterDeps = {},
): void => {
  const { prisma, requireActorContext, requireOwner, requireUserActor } = deps

  /**
   * Found a new UOA organisation, owned by the caller.
   *
   * Owner-gated. In UOA backend mode there is no acting user and therefore no
   * upstream role check at all, so this gate is the entire authorization —
   * and `actor.roles` is re-resolved from the live `OrganizationMember` row on
   * every request, so a demotion takes effect immediately.
   */
  app.post('/api/workspaces/organizations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    if (!requireOwner(actorContext, reply)) return reply
    const body = parseInput(CreateOrganizationBodySchema, request.body, reply)
    if (!body) return reply
    const ownerUoaSub = requireUoaSubject(actorContext, reply)
    if (!ownerUoaSub) return reply

    try {
      const workspace = await provisionOnce(
        prisma,
        request,
        {
          action: ORG_CREATED_ACTION,
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
          idempotencyKey: body.idempotencyKey,
          name: body.name,
          resourceType: 'organization',
        },
        () => createUoaOrganisation({ name: body.name, ownerUoaSub }, rosterDeps),
      )
      return createApiResponse(workspace)
    } catch (error) {
      if (sendProvisioningError(request, reply, error)) return reply
      throw error
    }
  })

  /**
   * Add a workspace to the organisation the caller is currently in.
   *
   * User mode upstream, so UOA applies its own owner/admin gate on the live
   * membership and enforces `allow_user_create_team`. The local owner gate
   * stays as the first refusal, keeping the affordance and the answer
   * consistent with the organisation route.
   */
  app.post('/api/workspaces/teams', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    if (!requireOwner(actorContext, reply)) return reply
    const body = parseInput(CreateOrganizationBodySchema, request.body, reply)
    if (!body) return reply

    const workspace = await resolveUoaRosterWorkspace(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId,
    })
    if (!workspace) {
      sendApiError(
        reply,
        404,
        'WORKSPACE_NOT_LINKED',
        'This workspace is not linked to an UnlikeOtherAI workspace',
      )
      return reply
    }

    try {
      const created = await provisionOnce(
        prisma,
        request,
        {
          action: WORKSPACE_CREATED_ACTION,
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
          idempotencyKey: body.idempotencyKey,
          name: body.name,
          resourceType: 'team',
        },
        () => createUoaWorkspaceTeam(
          workspace,
          { name: body.name },
          withUoaRosterSubjectAssertion(
            workspace,
            actorContext.actionContext.uoaIdentity,
            rosterDeps,
          ),
        ),
      )
      return createApiResponse(created)
    } catch (error) {
      if (sendProvisioningError(request, reply, error)) return reply
      throw error
    }
  })
}
