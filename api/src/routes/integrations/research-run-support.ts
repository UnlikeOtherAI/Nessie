import type { FastifyReply } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { DeepWaterBriefRun } from '@nessie/runtime'
import {
  DEEP_WATER_BRIEF_ERROR_CODES,
  detectSecrets,
  parseChannelId,
  parseOrganizationId,
  parseUserId,
  type AuthorizedActionContext,
  type DeepWaterRequesterIdentity,
  type DeepWaterResearchReadinessState,
} from '@nessie/schemas'
import { z } from 'zod'

import { sendApiError } from '../../lib/api.js'
import { resolveDeepWaterRequesterIdentity } from '../../services/deepwater-research-readiness.js'
import type { RealtimeHub } from '../types.js'

/**
 * What every DeepWater brief route shares: its prefix, its parameters, the
 * refusals a route decides under the run's row lock, and the realtime notice a
 * committed change owes (Water plan nessie.md §7.1, §7.7).
 */

export const RESEARCH_RUNS_PATH = '/api/integrations/products/deep-water/research-runs'

export const ResearchRunParamsSchema = z.object({ runId: z.string().uuid() }).strict()

/**
 * A refusal decided inside a transaction — usually under the run's row lock —
 * and answered once it has rolled back.
 */
export class DeepWaterBriefRefusal extends Error {
  override readonly name = 'DeepWaterBriefRefusal'

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export const sendBriefRefusal = (reply: FastifyReply, refusal: DeepWaterBriefRefusal): FastifyReply => {
  sendApiError(reply, refusal.statusCode, refusal.code, refusal.message, undefined, refusal.details)
  return reply
}

export const notFound = (): DeepWaterBriefRefusal =>
  new DeepWaterBriefRefusal(404, DEEP_WATER_BRIEF_ERROR_CODES.RESEARCH_NOT_FOUND, 'Research not found')

/** Customer copy for each reason DeepWater cannot start research now. No infrastructure words. */
const NOT_READY_MESSAGES: Record<Exclude<DeepWaterResearchReadinessState, 'ready'>, string> = {
  team_off: 'DeepWater is turned off for this team. A team owner can turn it on.',
  contract_outdated: 'DeepWater needs an update for this team. A team owner can update it.',
  account_not_linked: 'Sign in again to use DeepWater in this team.',
  unavailable: 'DeepWater is not available right now. Try again later.',
}

export const notReady = (reason: Exclude<DeepWaterResearchReadinessState, 'ready'>): DeepWaterBriefRefusal =>
  new DeepWaterBriefRefusal(409, DEEP_WATER_BRIEF_ERROR_CODES.NOT_READY, NOT_READY_MESSAGES[reason], { reason })

/** The team a brief lives in: the session's team context. */
export const requireTeamId = (actorContext: AuthorizedActionContext, reply: FastifyReply): string | null => {
  const teamId = actorContext.tenant.teamId ?? actorContext.actionContext.teamId ?? null
  if (!teamId) sendApiError(reply, 400, 'TEAM_CONTEXT_REQUIRED', 'A team context is required')
  return teamId
}

/**
 * The acting person's live UOA identity, which the worker acts with for this
 * request. Without one DeepWater cannot be asked for anything on their behalf.
 */
export const requireRequesterIdentity = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  teamId: string,
): Promise<DeepWaterRequesterIdentity> => {
  const identity = await resolveDeepWaterRequesterIdentity(prisma, actorContext, teamId)
  if (!identity) throw notReady('account_not_linked')
  return identity
}

/**
 * Words sent to DeepWater leave Nessie, so a pasted credential is refused
 * before anything is stored or enqueued — the chat composer's rule.
 */
export const assertNoSecrets = (texts: ReadonlyArray<string | null | undefined>): void => {
  if (texts.some((text) => text && detectSecrets(text).length > 0)) {
    throw new DeepWaterBriefRefusal(
      422,
      'SECRET_INTERCEPTED',
      'Nessie did not send this because it contains a credential. Save it through Secrets instead.',
    )
  }
}

/**
 * `integration.run.updated` for a committed change (§7.7): content-free, on
 * the requester's own lane and, once the run is visible in its room (a card
 * there, or an agent opened it there), on the room's. A publish failure is
 * logged and never undoes the change: the row is the record, and a missed
 * event costs a refresh.
 */
export const publishDeepWaterRunUpdated = async (
  realtimeHub: RealtimeHub,
  run: Pick<DeepWaterBriefRun, 'id' | 'organizationId' | 'requestedByUserId' | 'channelId' | 'cardMessageId' | 'originKind'>,
): Promise<void> => {
  const data = { productSlug: 'deep-water', runId: run.id }
  try {
    if (run.requestedByUserId) {
      await realtimeHub.publishWs([{
        kind: 'user',
        organizationId: parseOrganizationId(run.organizationId),
        userId: parseUserId(run.requestedByUserId),
      }], { data, event: 'integration.run.updated' })
    }
    if (run.channelId && (run.cardMessageId !== null || run.originKind === 'agent')) {
      await realtimeHub.publishWs([{ kind: 'channel', channelId: parseChannelId(run.channelId) }], {
        data,
        event: 'integration.run.updated',
      })
    }
  } catch (error) {
    console.error(`[deep-water] realtime update for run ${run.id} failed; the change is committed`, error)
  }
}
