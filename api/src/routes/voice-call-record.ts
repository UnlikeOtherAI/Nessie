import type { FastifyInstance, RouteShorthandOptions } from 'fastify'

import { SubmitVoiceTranscriptRequestSchema, type MessageRole } from '@nessie/schemas'

import { createApiResponse, parseInput } from '../lib/api.js'
import { publishMessageNew } from '../services/message-delivery.js'
import { requireRecordableSession } from '../services/voice/voice-session.js'
import {
  assertTranscriptPlausible,
  writeVoiceCallRecord,
} from '../services/voice/voice-transcript.js'
import { sendVoiceError } from './voice-route-errors.js'

import type { RouteDeps } from './types.js'

/**
 * What a call leaves behind.
 *
 * A call is unreproducible, so this route's whole job is that the record
 * survives everything that can go wrong around it: the summariser, the
 * storage backend, a second tab racing the hang-up. The message is written in
 * the assistant's voice with the verbatim transcript attached as a file, and
 * the set-once transcript slot on the session is what makes it exactly one
 * record no matter how many clients submit it.
 */
export const registerVoiceCallRecordRoute = (
  app: FastifyInstance,
  deps: RouteDeps,
  /** The voice-credential scope marker, granted by the subsystem's front door. */
  duringACall: RouteShorthandOptions,
): void => {
  const { prisma, fileService, requireActorContext, requireUserActor } = deps

  app.post('/api/voice/sessions/:sessionId/transcript', duringACall, async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply
    const { sessionId } = request.params as { sessionId: string }

    const body = parseInput(SubmitVoiceTranscriptRequestSchema, request.body ?? {}, reply)
    if (!body) return reply

    try {
      // Not `requireActiveSession`: a client that died mid-call submits its
      // record on a later launch, by which point the call may have been ended
      // by its duration cap or another tab.
      const session = await requireRecordableSession(prisma, {
        organizationId: actorContext.tenant.organizationId,
        sessionId,
        userId: actorContext.actor.actorId,
      })
      assertTranscriptPlausible(session, body.lines)

      const [agent, user] = await Promise.all([
        prisma.agent.findUnique({ where: { id: session.agentId }, select: { name: true } }),
        prisma.user.findUnique({
          where: { id: session.userId },
          select: { displayName: true },
        }),
      ])

      const record = await writeVoiceCallRecord(prisma, {
        actorContext,
        agentName: agent?.name ?? 'Personal Assistant',
        durationMs: body.durationMs,
        fileService,
        lines: body.lines,
        // Null on a deployment with no model service. The record is written
        // either way — compaction is the nicety, not the record.
        modelClient: deps.sharedModelClient,
        onCompactionFailure: (err) =>
          request.log.warn({ err }, 'voice compaction failed; recording verbatim'),
        // Leaked bytes and an over-counted storage ledger. Nothing else would
        // ever report it, and the request itself fails for its own reason.
        onTranscriptCleanupFailure: (err) =>
          request.log.error({ err }, 'voice transcript bytes could not be freed'),
        session,
        userDisplayName: user?.displayName ?? 'You',
      })

      await publishCallRecord(deps, {
        agentId: session.agentId,
        channelId: session.channelId,
        log: request.log,
        messageId: record.messageId,
        organizationId: session.organizationId,
        role: record.role,
        threadId: session.threadId,
      })

      return reply.code(201).send(createApiResponse({ messageId: record.messageId }))
    } catch (error) {
      return sendVoiceError(reply, error) ?? Promise.reject(error)
    }
  })
}

/**
 * Announces the call record so an open feed shows it without a refetch.
 *
 * Best-effort: the message row is the record of truth, and a dropped event
 * costs a refresh rather than the record.
 */
const publishCallRecord = async (
  deps: RouteDeps,
  input: {
    agentId: string
    channelId: string
    log: { error: (details: Record<string, unknown>, message: string) => void }
    messageId: string
    organizationId: string
    role: MessageRole
    threadId: string
  },
): Promise<void> => {
  try {
    await publishMessageNew(deps, {
      channel: {
        id: input.channelId,
        organizationId: input.organizationId,
        systemChannelType: 'personal_assistant',
      },
      message: {
        agentId: input.agentId,
        // The record's own body is a call summary the feed fetches; the
        // announcement only says a call landed.
        content: 'Voice call',
        id: input.messageId,
        role: input.role,
      },
      threadId: input.threadId,
    })
  } catch (error) {
    // The feed refetches on its own, so a missed event is not worth failing the
    // request on — but it is worth knowing about: a silently discarded
    // announcement is how an invalid `role` went unnoticed here for months.
    input.log.error({ err: error, messageId: input.messageId }, 'voice_call_record_publish_failed')
  }
}
