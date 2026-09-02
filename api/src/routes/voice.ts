import type { Prisma } from '@prisma/client'
import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  parseAgentId,
  parseChannelId,
  parseThreadId,
  RegisterVoiceInstallationRequestSchema,
  ReportVoiceUsageRequestSchema,
  StartVoiceSessionRequestSchema,
  SubmitVoiceTranscriptRequestSchema,
  VoiceCapabilitySchema,
  VoiceInstallationRecordSchema,
  VoiceSessionCredentialSchema,
  VoiceSessionRotationSchema,
  VoiceToolCallRequestSchema,
  VoiceToolCallResponseSchema,
} from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  isVoiceConfigured,
  LedgerVoiceError,
  relayVoiceUsage,
} from '../services/voice/ledger-gemini-live.js'
import {
  buildVoiceFunctionDeclarations,
  buildVoiceSystemInstruction,
  loadVoiceSeedTurns,
  resolveVoiceName,
  voiceToolNames,
} from '../services/voice/voice-context.js'
import {
  endVoiceSession,
  registerVoiceInstallation,
  requireActiveSession,
  requireOwnedInstallation,
  requireRecordableSession,
  rotateVoiceSession,
  startVoiceSession,
  VoiceSessionError,
} from '../services/voice/voice-session.js'
import {
  assertTranscriptPlausible,
  writeVoiceCallRecord,
} from '../services/voice/voice-transcript.js'
import {
  hashToolArguments,
  isVoiceTool,
  runVoiceTool,
} from '../services/voice/voice-tools.js'

import type { RouteDeps } from './types.js'

/**
 * Calling the Personal Assistant with live voice.
 *
 * The API is the credential broker and nothing more during the call itself:
 * it mints Google's one-use ephemeral credential through Ledger, and audio
 * then flows straight between the client and Google. `LEDGER_PROXY_TOKEN`
 * never leaves this process.
 *
 * Authorization matrix for these routes, all ordinary session auth in phase 1
 * (the voice-scoped device credential arrives with the native client, phase
 * 1b, and will be accepted *only* here — never on the generic message or
 * thread routes):
 *
 * | Method | Path                                   | Who                       |
 * |--------|----------------------------------------|---------------------------|
 * | GET    | /api/voice/capability                  | any active member         |
 * | POST   | /api/voice/installations               | any active member         |
 * | DELETE | /api/voice/installations/:id           | its owner                 |
 * | POST   | /api/voice/sessions                    | any active member         |
 * | POST   | /api/voice/sessions/:id/rotate         | the call's own user       |
 * | POST   | /api/voice/sessions/:id/usage          | the call's own user       |
 * | POST   | /api/voice/sessions/:id/tool-call      | the call's own user       |
 * | POST   | /api/voice/sessions/:id/transcript     | the call's own user       |
 * | POST   | /api/voice/sessions/:id/end            | the call's own user       |
 *
 * Spec: docs/plans/2026-09-02-gemini-voice-calling.md
 */
export const registerVoiceRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    authSecret,
    fileService,
    ledgerIdentity,
    loadPersonalAssistantState,
    requireActorContext,
    requireUserActor,
  } = deps

  /** Maps a service refusal onto its response; unknown errors keep bubbling. */
  const sendVoiceError = (reply: FastifyReply, error: unknown): FastifyReply | null => {
    if (error instanceof VoiceSessionError || error instanceof LedgerVoiceError) {
      return sendApiError(reply, error.status, error.code, error.message)
    }
    return null
  }

  // Asked before the call button is offered, so a deployment with no Ledger
  // shows no control instead of one that always fails.
  app.get('/api/voice/capability', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    return createApiResponse(VoiceCapabilitySchema.parse({ available: isVoiceConfigured() }))
  })

  app.post('/api/voice/installations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(RegisterVoiceInstallationRequestSchema, request.body ?? {}, reply)
    if (!body) return reply

    try {
      const installation = await registerVoiceInstallation(prisma, {
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        platform: body.platform,
        label: body.label,
      })
      return reply.code(201).send(
        createApiResponse(
          VoiceInstallationRecordSchema.parse({
            id: installation.id,
            platform: installation.platform,
            ...(installation.label ? { label: installation.label } : {}),
            lastSeenAt: installation.lastSeenAt.toISOString(),
            createdAt: installation.createdAt.toISOString(),
          }),
        ),
      )
    } catch (error) {
      return sendVoiceError(reply, error) ?? Promise.reject(error)
    }
  })

  app.delete('/api/voice/installations/:installationId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { installationId } = request.params as { installationId: string }

    // Revoked rather than deleted: sessions reference it, and the row is how
    // an owner sees which device held a Ledger reservation today.
    const revoked = await prisma.voiceInstallation.updateMany({
      where: {
        id: installationId,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    })
    if (revoked.count === 0) {
      return sendApiError(reply, 404, 'VOICE_INSTALLATION_NOT_FOUND', 'Device not found.')
    }
    return reply.code(204).send()
  })

  app.post('/api/voice/sessions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply

    const body = parseInput(StartVoiceSessionRequestSchema, request.body ?? {}, reply)
    if (!body) return reply

    // The call is always with the caller's own Personal Assistant, resolved
    // server-side: the client never names a channel, so there is no target to
    // tamper with.
    const assistant = await loadPersonalAssistantState(actorContext)
    if (!assistant?.agent || !assistant.channel || !assistant.thread) {
      return sendApiError(
        reply,
        404,
        'VOICE_ASSISTANT_UNAVAILABLE',
        'Your Personal Assistant is not set up yet.',
      )
    }

    try {
      const installation = await requireOwnedInstallation(prisma, {
        installationId: body.installationId,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      })

      const started = await startVoiceSession(prisma, {
        actorContext,
        agentId: assistant.agent.id,
        authSecret,
        channelId: assistant.channel.id,
        installation,
        ledgerIdentity,
        threadId: assistant.thread.id,
      })

      const [seedTurns, user] = await Promise.all([
        loadVoiceSeedTurns(prisma, {
          organizationId: actorContext.tenant.organizationId,
          threadId: assistant.thread.id,
          viewerUserId: actorContext.actor.actorId,
        }),
        prisma.user.findUnique({
          where: { id: actorContext.actor.actorId },
          select: { displayName: true },
        }),
      ])

      return reply.code(201).send(
        createApiResponse(
          VoiceSessionCredentialSchema.parse({
            voiceSessionId: started.session.id,
            accessToken: started.accessToken,
            websocketUrl: started.websocketUrl,
            model: started.session.model,
            expiresAt: started.session.credentialExpiresAt.toISOString(),
            newSessionExpiresAt: started.newSessionExpiresAt,
            voiceName: resolveVoiceName(),
            systemInstruction: buildVoiceSystemInstruction({
              agentName: assistant.agent.name,
              agentSystemPrompt: assistant.agent.systemPrompt ?? null,
              toolNames: voiceToolNames(),
              userDisplayName: user?.displayName ?? null,
            }),
            seedTurns,
            functionDeclarations: buildVoiceFunctionDeclarations(),
            limits: {
              maxDurationMs: started.session.maxDurationMs,
              maxToolCalls: started.session.maxToolCalls,
            },
            channelId: assistant.channel.id,
            threadId: assistant.thread.id,
            agentId: assistant.agent.id,
            agentName: assistant.agent.name,
          }),
        ),
      )
    } catch (error) {
      return sendVoiceError(reply, error) ?? Promise.reject(error)
    }
  })

  app.post('/api/voice/sessions/:sessionId/rotate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { sessionId } = request.params as { sessionId: string }

    try {
      const session = await requireActiveSession(prisma, {
        organizationId: actorContext.tenant.organizationId,
        sessionId,
        userId: actorContext.actor.actorId,
      })
      const rotated = await rotateVoiceSession(prisma, {
        actorContext,
        authSecret,
        ledgerIdentity,
        session,
      })
      return createApiResponse(
        VoiceSessionRotationSchema.parse({
          voiceSessionId: rotated.session.id,
          accessToken: rotated.accessToken,
          websocketUrl: rotated.websocketUrl,
          model: rotated.session.model,
          expiresAt: rotated.session.credentialExpiresAt.toISOString(),
          newSessionExpiresAt: rotated.newSessionExpiresAt,
        }),
      )
    } catch (error) {
      return sendVoiceError(reply, error) ?? Promise.reject(error)
    }
  })

  app.post('/api/voice/sessions/:sessionId/usage', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { sessionId } = request.params as { sessionId: string }

    const body = parseInput(ReportVoiceUsageRequestSchema, request.body ?? {}, reply)
    if (!body) return reply

    try {
      // A usage report is accepted after the call ends: the client's outbox
      // replays what it could not deliver, and refusing those reports would
      // discard exactly the spend nobody else can account for.
      const session = await prisma.voiceSession.findFirst({
        where: {
          id: sessionId,
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        },
      })
      if (!session) {
        return sendApiError(reply, 404, 'VOICE_SESSION_NOT_FOUND', 'Call not found.')
      }

      const relayed = await relayVoiceUsage({
        actorContext,
        ledgerIdentity,
        ledgerSessionId: session.ledgerSessionId,
        sequence: body.sequence,
        model: body.model,
        usage: body.usage,
        complete: body.complete === true,
      })

      await prisma.voiceSession.updateMany({
        // Monotonic: a replayed older report must not walk the watermark back.
        where: { id: session.id, lastUsageSequence: { lt: relayed.acceptedSequence } },
        data: { lastUsageSequence: relayed.acceptedSequence },
      })
      if (relayed.complete) {
        await prisma.voiceSession.update({
          where: { id: session.id },
          data: { usageComplete: true },
        })
      }

      return createApiResponse(relayed)
    } catch (error) {
      return sendVoiceError(reply, error) ?? Promise.reject(error)
    }
  })

  /**
   * Runs one tool the model asked for.
   *
   * Everything executes here, with the caller's own authority — the model
   * chooses, but never holds a credential and never reaches anything the
   * person could not reach by typing. Gemini's own call id is the idempotency
   * key, because it retries a call it did not see answered and the work must
   * not run twice.
   */
  app.post('/api/voice/sessions/:sessionId/tool-call', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply
    const { sessionId } = request.params as { sessionId: string }

    const body = parseInput(VoiceToolCallRequestSchema, request.body ?? {}, reply)
    if (!body) return reply

    try {
      const session = await requireActiveSession(prisma, {
        organizationId: actorContext.tenant.organizationId,
        sessionId,
        userId: actorContext.actor.actorId,
      })
      if (!isVoiceTool(body.name)) {
        return sendApiError(reply, 400, 'VOICE_TOOL_UNKNOWN', `Unknown tool: ${body.name}`)
      }

      const argumentsHash = hashToolArguments(body.args)
      const existing = await prisma.voiceToolCall.findUnique({
        where: {
          voiceSessionId_providerCallId: {
            voiceSessionId: session.id,
            providerCallId: body.providerCallId,
          },
        },
      })
      if (existing) {
        // A retry replays its answer. Different arguments under the same id is
        // a different action wearing a used name, and is refused.
        if (existing.argumentsHash !== argumentsHash) {
          return sendApiError(
            reply,
            409,
            'VOICE_TOOL_CALL_MISMATCH',
            'That call id was already used with different arguments.',
          )
        }
        return createApiResponse(
          VoiceToolCallResponseSchema.parse({
            result: (existing.result ?? {}) as Record<string, unknown>,
            replayed: true,
          }),
        )
      }

      // The per-call ceiling is real spend protection: each tool result is
      // re-sent to Gemini on every later turn of the conversation.
      if (session.toolCallCount >= session.maxToolCalls) {
        return sendApiError(
          reply,
          429,
          'VOICE_TOOL_LIMIT',
          'This call has used all the tool calls it is allowed.',
        )
      }

      const result = await runVoiceTool(body.name, body.args, {
        actorContext,
        ledgerIdentity,
        prisma,
        session,
      })

      await prisma.$transaction([
        prisma.voiceToolCall.create({
          data: {
            voiceSessionId: session.id,
            providerCallId: body.providerCallId,
            toolName: body.name,
            argumentsHash,
            // Prisma's JSON input type does not accept a bare index signature.
            result: result as Prisma.InputJsonValue,
          },
        }),
        prisma.voiceSession.update({
          where: { id: session.id },
          data: { toolCallCount: { increment: 1 } },
        }),
      ])

      return createApiResponse(VoiceToolCallResponseSchema.parse({ result, replayed: false }))
    } catch (error) {
      return sendVoiceError(reply, error) ?? Promise.reject(error)
    }
  })

  app.post('/api/voice/sessions/:sessionId/transcript', async (request, reply) => {
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
        session,
        userDisplayName: user?.displayName ?? 'You',
      })

      await publishCallRecord(deps, {
        agentId: session.agentId,
        channelId: session.channelId,
        messageId: record.messageId,
        organizationId: session.organizationId,
        threadId: session.threadId,
      })

      return reply.code(201).send(createApiResponse({ messageId: record.messageId }))
    } catch (error) {
      return sendVoiceError(reply, error) ?? Promise.reject(error)
    }
  })

  app.post('/api/voice/sessions/:sessionId/end', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { sessionId } = request.params as { sessionId: string }

    const session = await prisma.voiceSession.findFirst({
      where: {
        id: sessionId,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      },
      select: { id: true },
    })
    if (!session) {
      return sendApiError(reply, 404, 'VOICE_SESSION_NOT_FOUND', 'Call not found.')
    }
    await endVoiceSession(prisma, session.id)
    return reply.code(204).send()
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
    messageId: string
    organizationId: string
    threadId: string
  },
): Promise<void> => {
  try {
    await deps.realtimeHub.publishWs(
      deps.buildChannelRealtimeScopes({
        channelId: input.channelId,
        organizationId: input.organizationId,
        systemChannelType: 'personal_assistant',
      }),
      {
        data: {
          agentId: parseAgentId(input.agentId),
          authorUserId: undefined,
          channelId: parseChannelId(input.channelId),
          contentPreview: 'Voice call',
          messageId: input.messageId,
          role: 'agent',
          threadId: parseThreadId(input.threadId),
        },
        event: 'message.new',
      },
    )
  } catch {
    // The feed refetches on its own; a missed event is not worth failing on.
  }
}
