import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma, type PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { writeAuditEntryInTransaction } from '@nessie/db'
import { isAdminActor, type AuthorizedActionContext } from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { forgetUoaTeamDirectory } from '../services/uoa-directory-cache.js'
import {
  createUoaOrganisation,
  createUoaTeamTeam,
  resolveUoaRosterTeam,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
  type UoaProvisionedTeam,
  type UoaRosterDeps,
} from '../services/uoa-org-roster.js'
import type { RouteDeps } from './types.js'

/**
 * Founding a UOA organisation, or a further team inside one, from inside
 * Nessie — so that neither costs a second interactive login.
 *
 * These routes create **nothing locally**. UOA owns the organisation/team
 * hierarchy, and the local `Organization`/`Team`/`Project`/`#general` mirror is
 * born in `materializeUoaTeam`, from a team UOA itself proved in an
 * authenticated response. That is why both handlers answer only a pair of UOA
 * ids: the client then calls the ordinary `POST /api/auth/uoa/team`, and
 * the existing silent switch grant does the materializing. Writing a local row
 * here would be inventing an organisation ahead of UOA's proof.
 *
 * The two routes deliberately use different UOA credential modes; the reasons
 * are on the service functions in `@nessie/team-admin`.
 */

const CreateOrganizationBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Distinguishes a retry of one intent from a second intent. See the ledger
  // note below: without it, a retry after an ambiguous network failure mints a
  // second organisation nobody asked for.
  idempotencyKey: z.string().trim().min(8).max(200),
})

const ORG_CREATED_ACTION = 'organization.external_created'
const TEAM_CREATED_ACTION = 'team.external_created'

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
 * UOA's organisation ids — which is the whole point of this feature. Every
 * predicate but the JSON one is covered by an existing organisation-scoped
 * index (`audit_logs` carries several leading on `organization_id`), and the
 * 24-hour window bounds what is left, so only a handful of rows ever reach the
 * JSON comparison: no new index, and no walk of the organisation's history.
 */
const findPriorProvisioning = async (
  tx: Prisma.TransactionClient,
  input: {
    action: string
    organizationId: string
    userId: string
    idempotencyKey: string
  },
): Promise<UoaProvisionedTeam | null> => {
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
  create: () => Promise<UoaProvisionedTeam>,
): Promise<UoaProvisionedTeam> => prisma.$transaction(
  async (tx) => {
    await lockUserProvisioning(tx, input.userId)

    const prior = await findPriorProvisioning(tx, input)
    if (prior) return prior

    const team = await create()

    // The caller's cached team directory predates what they just made.
    // The switch that normally follows re-primes it, but if that call fails
    // they would otherwise be told their own new team does not exist for
    // up to the cache TTL.
    forgetUoaTeamDirectory(input.userId)

    await writeAuditEntryInTransaction(tx, {
      organizationId: input.organizationId,
      actorType: 'user',
      actorId: input.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: team.externalOrgId,
      outcome: 'success',
      metadata: {
        idempotencyKey: input.idempotencyKey,
        name: input.name,
        externalOrgId: team.externalOrgId,
        externalTeamId: team.externalTeamId,
      },
      ...auditRequestFields(request),
    })

    return team
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

export const registerTeamProvisioningRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  rosterDeps: UoaRosterDeps = {},
): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  /**
   * Found a new UOA organisation, owned by the caller.
   *
   * **Any active member**, which is the flow this replaces, not a widening of
   * it. The old "Add team" redirect sent people into UOA's chooser in
   * user mode, where `org_features.allow_user_create_org` (true for this
   * deployment) lets any authenticated user of the domain found one — so
   * owner-gating here would quietly take a capability away from members while
   * claiming only to remove a login.
   *
   * It is also the right shape on its own terms: founding an organisation is
   * not an act upon the current tenant. It reads nothing from it, changes
   * nothing in it, and produces a separate tenancy in which the caller is the
   * owner. The route that DOES write into the current tenant — adding a
   * team, below — carries the owner/admin gate.
   *
   * What backend mode costs is the upstream role check, and the answer to that
   * is not a stricter role but the two things that ARE checked here: a live,
   * non-deactivated membership (re-resolved per request by
   * `requireActorContext`, so a revoked account cannot mint tenancies) and a
   * linked UOA subject to own the result.
   */
  app.post('/api/teams/organizations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const body = parseInput(CreateOrganizationBodySchema, request.body, reply)
    if (!body) return reply
    const ownerUoaSub = requireUoaSubject(actorContext, reply)
    if (!ownerUoaSub) return reply

    try {
      const team = await provisionOnce(
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
      return createApiResponse(team)
    } catch (error) {
      if (sendProvisioningError(request, reply, error)) return reply
      throw error
    }
  })

  /**
   * Add a team to the organisation the caller is currently in.
   *
   * Owner **or admin**, deliberately wider than the organisation route above.
   * This one is user mode upstream, so UOA applies its own gate on the live
   * membership — owner/admin — and enforces `allow_user_create_team`. Gating
   * locally on owner alone would refuse an admin UOA is willing to serve,
   * making Nessie stricter than the authority it is relaying to; the local
   * check exists to refuse early and identically, not to invent a second
   * policy. The organisation route is owner-only for the opposite reason:
   * backend mode has no upstream gate at all, so its local one is the whole
   * authorization.
   */
  app.post('/api/teams/teams', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    if (!isAdminActor(actorContext)) {
      sendApiError(
        reply,
        403,
        'FORBIDDEN',
        'Only organisation owners and admins can create a team',
      )
      return reply
    }
    const body = parseInput(CreateOrganizationBodySchema, request.body, reply)
    if (!body) return reply

    const team = await resolveUoaRosterTeam(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId,
    })
    if (!team) {
      sendApiError(
        reply,
        404,
        'TEAM_NOT_LINKED',
        'This team is not linked to an UnlikeOtherAI team',
      )
      return reply
    }

    try {
      const created = await provisionOnce(
        prisma,
        request,
        {
          action: TEAM_CREATED_ACTION,
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
          idempotencyKey: body.idempotencyKey,
          name: body.name,
          resourceType: 'team',
        },
        () => createUoaTeamTeam(
          team,
          { name: body.name },
          withUoaRosterSubjectAssertion(
            team,
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
