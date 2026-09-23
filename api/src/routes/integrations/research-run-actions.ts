import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  DeepWaterBriefNotReadyError,
  DeepWaterBriefOriginNotFoundError,
  createPersonDeepWaterBrief,
} from '@nessie/mcp-manage'
import {
  beginDeepWaterDeliveryRetry,
  beginDeepWaterPersonAction,
  findDeepWaterBriefRunByOrigin,
  type DeepWaterBriefRun,
} from '@nessie/runtime'
import {
  CreateDeepWaterBriefRequestSchema,
  DEEP_WATER_BRIEF_ERROR_CODES,
  DeepWaterBriefReplyRequestSchema,
  DeepWaterBriefViewSchema,
  DeepWaterResearchRunActionRequestSchema,
  DeepWaterResearchRunViewSchema,
  StartDeepWaterBriefRequestSchema,
  deepWaterReplyAction,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { createApiResponse, parseInput } from '../../lib/api.js'
import {
  loadVisibleDeepWaterRun,
  resolveDeepWaterResearchViewer,
  toDeepWaterBriefViewFor,
  toDeepWaterResearchRunViews,
  type DeepWaterResearchViewer,
} from '../../services/deepwater-research-access.js'
import { resolveDeepWaterResearchAccess } from '../../services/deepwater-research-readiness.js'
import type { RouteDeps } from '../types.js'
import { registerResearchRunCancelRoute } from './research-run-cancel.js'
import { resolveBriefOrigin } from './research-run-origin.js'
import {
  DeepWaterBriefRefusal,
  RESEARCH_RUNS_PATH,
  ResearchRunParamsSchema,
  assertNoSecrets,
  notFound,
  notReady,
  publishDeepWaterRunUpdated,
  requireRequesterIdentity,
  requireTeamId,
  sendBriefRefusal,
} from './research-run-support.js'

/**
 * The mutations of the DeepWater brief API (Water plan nessie.md §7.1,
 * contract D10). Each one is validated here, recorded on the run as the
 * action in flight and enqueued in one transaction, and answered 202; the
 * worker — the only process that calls DeepWater — carries it out with the
 * acting person's live identity, captured from this request. A retried
 * request with the same `actionId` is answered 200 with the run as it now is,
 * and never enqueued twice.
 */

type UserActorContext = AuthorizedActionContext & {
  actor: AuthorizedActionContext['actor'] & { actorType: 'user' }
}

const BRIEF_NOT_EDITABLE = new DeepWaterBriefRefusal(
  409,
  DEEP_WATER_BRIEF_ERROR_CODES.BRIEF_NOT_EDITABLE,
  'Only the person who opened this brief can change it, and only while it is being agreed.',
)

const BRIEF_BUSY = new DeepWaterBriefRefusal(
  409,
  DEEP_WATER_BRIEF_ERROR_CODES.BRIEF_BUSY,
  'DeepWater is still working on your last change. Try again when it has answered.',
)

/** The person may edit or start their own brief while it is being agreed. */
const assertEditable = (run: DeepWaterBriefRun, userId: string): void => {
  if (run.requestedByUserId !== userId || run.originKind !== 'person' || run.status !== 'drafting') {
    throw BRIEF_NOT_EDITABLE
  }
}

/** The edit or launch was made against the brief as it is now (checked against Nessie's projection). */
const assertRevision = (run: DeepWaterBriefRun, revision: number): void => {
  const current = run.scopeState?.brief?.revision ?? null
  if (current !== revision) {
    throw new DeepWaterBriefRefusal(
      409,
      DEEP_WATER_BRIEF_ERROR_CODES.BRIEF_REVISION_CONFLICT,
      'The brief changed while you were editing it. Check the latest version, then try again.',
      { currentRevision: current },
    )
  }
}

export const registerResearchRunActionRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, realtimeHub, requireActorContext, requireUserActor } = deps

  /** Answer a refusal raised anywhere in a route's body, after its transaction rolled back. */
  const refusing = async (reply: FastifyReply, body: () => Promise<FastifyReply>): Promise<FastifyReply> => {
    try {
      return await body()
    } catch (error) {
      if (error instanceof DeepWaterBriefRefusal) return sendBriefRefusal(reply, error)
      throw error
    }
  }

  type Send = (reply: FastifyReply, viewer: DeepWaterResearchViewer, run: DeepWaterBriefRun, code: number) =>
    Promise<FastifyReply>

  const sendBrief: Send = async (reply, viewer, run, code) => {
    const view = await toDeepWaterBriefViewFor(prisma, viewer, run)
    return reply.code(code).send(createApiResponse(DeepWaterBriefViewSchema.parse(view)))
  }

  const sendRun: Send = async (reply, viewer, run, code) => {
    const [view] = await toDeepWaterResearchRunViews(prisma, viewer, [run])
    return reply.code(code).send(createApiResponse(DeepWaterResearchRunViewSchema.parse(view)))
  }

  /** Load a run the viewer may see and the acting person's identity for the run's own team. */
  const openRun = async (actorContext: UserActorContext, runId: string) => {
    const viewer = await resolveDeepWaterResearchViewer(prisma, actorContext)
    const run = await loadVisibleDeepWaterRun(prisma, viewer, runId)
    if (!run) throw notFound()
    return { viewer, run }
  }

  app.post(RESEARCH_RUNS_PATH, async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const teamId = requireTeamId(actorContext, reply)
    if (!teamId) return reply
    const body = parseInput(CreateDeepWaterBriefRequestSchema, request.body, reply)
    if (!body) return reply

    return refusing(reply, async () => {
      const organizationId = actorContext.tenant.organizationId
      const userId = actorContext.actor.actorId
      const viewer = await resolveDeepWaterResearchViewer(prisma, actorContext)
      const replayed = await findDeepWaterBriefRunByOrigin(prisma, {
        organizationId,
        requestedByUserId: userId,
        origin: { kind: 'person', actionId: body.actionId },
      })
      if (replayed) return sendBrief(reply, viewer, replayed, 200)

      assertNoSecrets([body.topic, body.context, ...(body.pillars ?? [])])
      // Readiness in the order every doorway shows it, before the origin is
      // resolved (which may set up the person's Personal Assistant); the team
      // switch and connector are checked again under the transition lock.
      const access = await resolveDeepWaterResearchAccess(prisma, actorContext, {
        teamId,
        ledgerIdentity: deps.ledgerIdentity,
      })
      if (access.state !== 'ready') throw notReady(access.state)
      const { identity } = access
      const origin = await resolveBriefOrigin(deps, actorContext, teamId, body.origin)
      const context = body.context?.trim() ?? ''
      let created
      try {
        created = await createPersonDeepWaterBrief(prisma, {
          organizationId,
          teamId,
          requestedByUserId: userId,
          channelId: origin.channelId,
          threadId: origin.threadId,
          identity,
          actionId: body.actionId,
          input: {
            schemaVersion: 1,
            topic: body.topic,
            context: context.length > 0 ? context : null,
            pillars: body.pillars ?? null,
            settings: body.settings && Object.keys(body.settings).length > 0 ? body.settings : null,
            originRootMessageId: origin.rootMessageId,
          },
        })
      } catch (error) {
        if (error instanceof DeepWaterBriefNotReadyError) throw notReady(error.reason)
        if (error instanceof DeepWaterBriefOriginNotFoundError) {
          throw new DeepWaterBriefRefusal(404, 'THREAD_NOT_FOUND', 'Thread not found')
        }
        throw error
      }
      if (created.created) await publishDeepWaterRunUpdated(realtimeHub, created.run)
      return sendBrief(reply, viewer, created.run, created.created ? 202 : 200)
    })
  })

  app.post(`${RESEARCH_RUNS_PATH}/:runId/messages`, async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const params = ResearchRunParamsSchema.safeParse(request.params)
    if (!params.success) return sendBriefRefusal(reply, notFound())
    const body = parseInput(DeepWaterBriefReplyRequestSchema, request.body, reply)
    if (!body) return reply

    return refusing(reply, async () => {
      assertNoSecrets([body.message, ...(body.pillars ?? [])])
      const userId = actorContext.actor.actorId
      const { viewer, run } = await openRun(actorContext, params.data.runId)
      if (run.scopeState === null) throw BRIEF_NOT_EDITABLE
      const identity = await requireRequesterIdentity(prisma, actorContext, run.teamId)
      const outcome = await prisma.$transaction((tx) => beginDeepWaterPersonAction(tx, {
        job: {
          organizationId: run.organizationId,
          runId: run.id,
          actionId: body.actionId,
          actor: { userId, role: 'requester', identity },
          action: deepWaterReplyAction(body),
        },
        precondition: (locked) => {
          assertEditable(locked, userId)
          if (body.baseRevision !== undefined) assertRevision(locked, body.baseRevision)
        },
      }))
      if (outcome.kind === 'not_found') throw notFound()
      if (outcome.kind === 'busy') throw BRIEF_BUSY
      if (outcome.kind === 'started') await publishDeepWaterRunUpdated(realtimeHub, outcome.run)
      return sendBrief(reply, viewer, outcome.run, outcome.kind === 'started' ? 202 : 200)
    })
  })

  app.post(`${RESEARCH_RUNS_PATH}/:runId/start`, async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const params = ResearchRunParamsSchema.safeParse(request.params)
    if (!params.success) return sendBriefRefusal(reply, notFound())
    const body = parseInput(StartDeepWaterBriefRequestSchema, request.body, reply)
    if (!body) return reply

    return refusing(reply, async () => {
      assertNoSecrets(body.pillars ?? [])
      const userId = actorContext.actor.actorId
      const { viewer, run } = await openRun(actorContext, params.data.runId)
      if (run.scopeState === null) throw BRIEF_NOT_EDITABLE
      const identity = await requireRequesterIdentity(prisma, actorContext, run.teamId)
      const outcome = await prisma.$transaction((tx) => beginDeepWaterPersonAction(tx, {
        job: {
          organizationId: run.organizationId,
          runId: run.id,
          actionId: body.actionId,
          actor: { userId, role: 'requester', identity },
          action: {
            kind: 'launch',
            revision: body.revision,
            ...(body.pillars !== undefined ? { pillars: body.pillars } : {}),
            ...(body.settings !== undefined ? { settings: body.settings } : {}),
            public: body.public === true,
          },
        },
        precondition: (locked) => {
          assertEditable(locked, userId)
          assertRevision(locked, body.revision)
          // The pillars the launch will run: the ones sent with it, else the
          // brief's (amendments-fable F8), so hand-written pillars can launch
          // even after the planner failed.
          const pillars = body.pillars ?? locked.scopeState?.brief?.pillars ?? []
          if (pillars.length === 0) {
            throw new DeepWaterBriefRefusal(
              422,
              DEEP_WATER_BRIEF_ERROR_CODES.BRIEF_INCOMPLETE,
              'Add at least one pillar before you start the research.',
            )
          }
        },
      }))
      if (outcome.kind === 'not_found') throw notFound()
      if (outcome.kind === 'busy') throw BRIEF_BUSY
      if (outcome.kind === 'started') await publishDeepWaterRunUpdated(realtimeHub, outcome.run)
      return sendRun(reply, viewer, outcome.run, outcome.kind === 'started' ? 202 : 200)
    })
  })

  app.post(`${RESEARCH_RUNS_PATH}/:runId/deliver`, async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const params = ResearchRunParamsSchema.safeParse(request.params)
    if (!params.success) return sendBriefRefusal(reply, notFound())
    const body = parseInput(DeepWaterResearchRunActionRequestSchema, request.body, reply)
    if (!body) return reply

    return refusing(reply, async () => {
      const { viewer, run } = await openRun(actorContext, params.data.runId)
      const notBlocked = new DeepWaterBriefRefusal(
        409,
        DEEP_WATER_BRIEF_ERROR_CODES.DELIVERY_NOT_BLOCKED,
        'There is nothing to retry for this research.',
      )
      // Only the requester retries: the delivery is addressed to them.
      if (run.requestedByUserId !== actorContext.actor.actorId) throw notBlocked
      const identity = await requireRequesterIdentity(prisma, actorContext, run.teamId)
      const outcome = await prisma.$transaction((tx) => beginDeepWaterDeliveryRetry(tx, {
        organizationId: run.organizationId,
        runId: run.id,
        actionId: body.actionId,
        identity,
      }))
      if (outcome.kind === 'not_found') throw notFound()
      if (outcome.kind === 'not_blocked') throw notBlocked
      if (outcome.kind === 'identity_mismatch') throw notReady('account_not_linked')
      if (outcome.kind === 'started') await publishDeepWaterRunUpdated(realtimeHub, outcome.run)
      return sendRun(reply, viewer, outcome.run, outcome.kind === 'started' ? 202 : 200)
    })
  })

  registerResearchRunCancelRoute(app, deps, { refusing, sendRun })
}
