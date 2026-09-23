import {
  DEEP_WATER_BRIEF_ERROR_CODES,
  type AuthorizedActionContext,
  type DeepWaterBriefOriginRequest,
} from '@nessie/schemas'

import { findThreadForUser } from '../../services/message-read-state.js'
import { ensurePersonalAssistantBootstrap } from '../../services/personal-assistant.js'
import type { RouteDeps } from '../types.js'
import { DeepWaterBriefRefusal } from './research-run-support.js'

/**
 * Where a person's brief lives, and so where its result comes back (Water plan
 * nessie.md §7.1): the conversation they opened it from, which they must be
 * able to post in, or — for `personal` — their Personal Assistant's default
 * conversation. Resolved on the server; a client never names the Personal
 * Assistant's room itself.
 */

export type ResolvedBriefOrigin = {
  channelId: string
  threadId: string
  /** The message the research card is posted under at Start; null posts it at the top level. */
  rootMessageId: string | null
}

type UserActorContext = AuthorizedActionContext & {
  actor: AuthorizedActionContext['actor'] & { actorType: 'user' }
}

const threadNotFound = (): DeepWaterBriefRefusal =>
  new DeepWaterBriefRefusal(404, 'THREAD_NOT_FOUND', 'Thread not found')

export const resolveBriefOrigin = async (
  deps: Pick<RouteDeps, 'prisma' | 'loadPersonalAssistantState'>,
  actorContext: UserActorContext,
  teamId: string,
  origin: DeepWaterBriefOriginRequest,
): Promise<ResolvedBriefOrigin> => {
  const { prisma } = deps
  const organizationId = actorContext.tenant.organizationId
  const userId = actorContext.actor.actorId

  if (origin.kind === 'personal') {
    await ensurePersonalAssistantBootstrap(prisma, { organizationId, teamId, userId })
    const assistant = await deps.loadPersonalAssistantState(actorContext)
    if (!assistant?.channel || !assistant.thread) throw threadNotFound()
    return { channelId: assistant.channel.id, threadId: assistant.thread.id, rootMessageId: null }
  }

  // The thread predicate the composer posts through: a person who cannot open
  // the room is told it does not exist.
  const thread = await findThreadForUser(prisma, origin.threadId, userId, organizationId)
  if (!thread || thread.channelId !== origin.channelId) throw threadNotFound()
  const channel = await prisma.channel.findUnique({
    where: { id: thread.channelId },
    select: { teamId: true, archivedAt: true },
  })
  if (!channel) throw threadNotFound()
  if (channel.archivedAt !== null) {
    throw new DeepWaterBriefRefusal(
      403,
      DEEP_WATER_BRIEF_ERROR_CODES.BRIEF_THREAD_FORBIDDEN,
      'This conversation is archived, so research cannot be started from it.',
    )
  }
  if (channel.teamId !== teamId) {
    throw new DeepWaterBriefRefusal(
      409,
      DEEP_WATER_BRIEF_ERROR_CODES.TEAM_MISMATCH,
      'This conversation belongs to another team. Switch to that team to start research from it.',
    )
  }
  if (origin.rootMessageId !== undefined) {
    const root = await prisma.message.findFirst({
      where: { id: origin.rootMessageId, threadId: thread.id, rootMessageId: null, deletedAt: null },
      select: { id: true },
    })
    if (!root) throw threadNotFound()
  }
  return { channelId: thread.channelId, threadId: thread.id, rootMessageId: origin.rootMessageId ?? null }
}
