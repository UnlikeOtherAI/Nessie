import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  beginDeepWaterPersonAction,
  beginLegacyDeepWaterCancel,
  enqueueDeepWaterBriefAction,
  readDeepWaterBriefRun,
  type DeepWaterBriefRun,
} from '@nessie/runtime'
import {
  DEEP_WATER_BRIEF_ERROR_CODES,
  DeepWaterResearchRunActionRequestSchema,
  type AuthorizedActionContext,
  type DeepWaterRequesterIdentity,
} from '@nessie/schemas'

import { createApiResponse, parseInput } from '../../lib/api.js'
import { emitAuditEvent } from '../../services/audit.js'
import {
  filterVisibleDeepWaterRuns,
  resolveDeepWaterResearchViewer,
  type DeepWaterResearchViewer,
} from '../../services/deepwater-research-access.js'
import { resolveDeepWaterRequesterIdentity } from '../../services/deepwater-research-readiness.js'
import type { RouteDeps } from '../types.js'
import {
  DeepWaterBriefRefusal,
  RESEARCH_RUNS_PATH,
  ResearchRunParamsSchema,
  notFound,
  notReady,
  publishDeepWaterRunUpdated,
  sendBriefRefusal,
} from './research-run-support.js'

/**
 * `POST …/research-runs/:runId/cancel` (Water plan nessie.md §7.1, amendments
 * N8.5, N9.6, amendments-fable F3).
 *
 * The requester may cancel their own open research. A team owner or admin may
 * cancel any open research in their team — whoever asked, and whether or not
 * they may read it — so a disable or contract upgrade it blocks can always be
 * cleared; DeepWater is then asked with the owner's own identity, never the
 * requester's, and the audit names the owner. An owner who may not read the
 * run is answered with its id and status only.
 *
 * A launcher run (from before research briefs) is cancelled by an owner or
 * admin: here, when DeepWater never received it; through DeepWater when it
 * has a research id; and not at all while a start may still be in flight.
 */

type RouteHelpers = {
  refusing: (reply: FastifyReply, body: () => Promise<FastifyReply>) => Promise<FastifyReply>
  sendRun: (
    reply: FastifyReply,
    viewer: DeepWaterResearchViewer,
    run: DeepWaterBriefRun,
    code: number,
  ) => Promise<FastifyReply>
}

const NOT_CANCELLABLE = new DeepWaterBriefRefusal(
  409,
  DEEP_WATER_BRIEF_ERROR_CODES.RUN_NOT_CANCELLABLE,
  'This research can no longer be cancelled.',
)

const OWNER_ONLY = new DeepWaterBriefRefusal(
  409,
  DEEP_WATER_BRIEF_ERROR_CODES.RUN_NOT_CANCELLABLE,
  'A team owner or admin can cancel this research.',
)

const STILL_OPENING = new DeepWaterBriefRefusal(
  409,
  DEEP_WATER_BRIEF_ERROR_CODES.BRIEF_BUSY,
  'This brief is still opening. Try again in a moment.',
)

/** Open research: a brief being agreed, a research running, or one parked for an operator. */
const OPEN_STATUSES: ReadonlySet<string> = new Set(['queued', 'drafting', 'running', 'needs_setup'])

type Acting = {
  role: 'requester' | 'owner'
  canRead: boolean
  /** An organisation owner or admin acting in the run's own team. */
  ownerInTeam: boolean
}

/** Who is cancelling, or null when this person may not cancel the run at all. */
const actingAs = async (
  prisma: RouteDeps['prisma'],
  viewer: DeepWaterResearchViewer,
  run: DeepWaterBriefRun,
): Promise<Acting | null> => {
  const canRead = (await filterVisibleDeepWaterRuns(prisma, viewer, [run])).length === 1
  const ownerInTeam = viewer.canChangeTeam && viewer.teamId === run.teamId
  if (canRead && run.requestedByUserId === viewer.userId) return { role: 'requester', canRead, ownerInTeam }
  if (ownerInTeam) return { role: 'owner', canRead, ownerInTeam }
  return null
}

export const registerResearchRunCancelRoute = (
  app: FastifyInstance,
  deps: RouteDeps,
  helpers: RouteHelpers,
): void => {
  const { prisma, realtimeHub, requireActorContext, requireUserActor } = deps

  const audit = (actorContext: AuthorizedActionContext, run: DeepWaterBriefRun, via: string) =>
    emitAuditEvent(prisma, {
      actorContext,
      action: 'integration.research.cancelled',
      resourceType: 'product_integration_run',
      resourceId: run.id,
      outcome: 'success',
      metadata: { productSlug: 'deep-water', requestedByUserId: run.requestedByUserId, via },
    })

  /** The run as the canceller may see it: the full view, or only its id and status. */
  const answer = async (
    reply: FastifyReply,
    viewer: DeepWaterResearchViewer,
    acting: Acting,
    runId: string,
    code: number,
  ) => {
    const run = await readDeepWaterBriefRun(prisma, { organizationId: viewer.organizationId, runId })
    if (!run) throw notFound()
    if (acting.canRead) return helpers.sendRun(reply, viewer, run, code)
    return reply.code(code).send(createApiResponse({ id: run.id, status: run.status }))
  }

  /** A launcher run: cancelled here, or through DeepWater with the owner's identity. */
  const cancelLauncherRun = async (
    reply: FastifyReply,
    input: {
      actorContext: AuthorizedActionContext
      viewer: DeepWaterResearchViewer
      acting: Acting
      run: DeepWaterBriefRun
      actionId: string
      identity: DeepWaterRequesterIdentity | null
    },
  ) => {
    const { run, viewer, acting } = input
    // Only an owner or admin clears a launcher run (N9.6): its requester's
    // own way out is the chat it was handed to.
    if (!acting.ownerInTeam) throw OWNER_ONLY
    const outcome = await prisma.$transaction(async (tx) => {
      const route = await beginLegacyDeepWaterCancel(tx, { organizationId: run.organizationId, runId: run.id })
      if (route === null) throw notFound()
      if (route === 'not_cancellable') throw NOT_CANCELLABLE
      if (route === 'local') return 'cancelled' as const
      if (!input.identity) throw notReady('account_not_linked')
      const enqueued = await enqueueDeepWaterBriefAction(tx, {
        organizationId: run.organizationId,
        runId: run.id,
        actionId: input.actionId,
        acceptedAt: new Date().toISOString(),
        actor: { userId: viewer.userId, role: acting.role, identity: input.identity },
        action: { kind: 'cancel' },
      })
      return enqueued ? 'enqueued' as const : 'replay' as const
    })
    if (outcome === 'cancelled') {
      console.info(`[deep-water] launcher run ${run.id} cancelled locally by ${viewer.userId}; DeepWater never received it`)
      await audit(input.actorContext, run, 'launcher_local')
    }
    if (outcome !== 'replay') await publishDeepWaterRunUpdated(realtimeHub, run)
    return answer(reply, viewer, acting, run.id, outcome === 'replay' ? 200 : 202)
  }

  app.post(`${RESEARCH_RUNS_PATH}/:runId/cancel`, async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const params = ResearchRunParamsSchema.safeParse(request.params)
    if (!params.success) return sendBriefRefusal(reply, notFound())
    const body = parseInput(DeepWaterResearchRunActionRequestSchema, request.body, reply)
    if (!body) return reply

    return helpers.refusing(reply, async () => {
      const viewer = await resolveDeepWaterResearchViewer(prisma, actorContext)
      const run = await readDeepWaterBriefRun(prisma, {
        organizationId: viewer.organizationId,
        runId: params.data.runId,
      })
      if (!run) throw notFound()
      const acting = await actingAs(prisma, viewer, run)
      if (!acting) throw notFound()
      // DeepWater is asked with the acting person's own identity, for the run's team.
      const identity = await resolveDeepWaterRequesterIdentity(prisma, actorContext, run.teamId)

      if (run.scopeState === null) {
        return cancelLauncherRun(reply, { actorContext, viewer, acting, run, actionId: body.actionId, identity })
      }
      if (!identity) throw notReady('account_not_linked')
      const outcome = await prisma.$transaction((tx) => beginDeepWaterPersonAction(tx, {
        job: {
          organizationId: run.organizationId,
          runId: run.id,
          actionId: body.actionId,
          actor: { userId: viewer.userId, role: acting.role, identity },
          action: { kind: 'cancel' },
        },
        precondition: (locked) => {
          if (!OPEN_STATUSES.has(locked.status)) throw NOT_CANCELLABLE
          // No research id yet: the brief is still opening in DeepWater (or
          // its opening was lost and is being replayed), and a cancel then
          // would have nothing to name.
          if (locked.externalRunId === null) throw STILL_OPENING
        },
      }))
      if (outcome.kind === 'not_found') throw notFound()
      if (outcome.kind === 'busy') throw STILL_OPENING
      if (outcome.kind === 'started') {
        if (acting.role === 'owner') await audit(actorContext, run, 'owner')
        await publishDeepWaterRunUpdated(realtimeHub, outcome.run)
      }
      return answer(reply, viewer, acting, run.id, outcome.kind === 'started' ? 202 : 200)
    })
  })
}
