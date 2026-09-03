import type { Prisma } from '@prisma/client'
import type { FastifyInstance } from 'fastify'

import {
  ReportVoiceUsageRequestSchema,
  StartVoiceSessionRequestSchema,
  VoiceSessionCredentialSchema,
  VoiceSessionRotationSchema,
  VoiceToolCallRequestSchema,
  VoiceToolCallResponseSchema,
} from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { relayVoiceUsage } from '../services/voice/ledger-gemini-live.js'
import {
  buildVoiceFunctionDeclarations,
  buildVoiceSystemInstruction,
  loadVoiceSeedTurns,
  resolveVoiceName,
  voiceToolNames,
} from '../services/voice/voice-context.js'
import {
  endVoiceSession,
  requireActiveSession,
  requireOwnedInstallation,
  rotateVoiceSession,
  startVoiceSession,
} from '../services/voice/voice-session.js'
import {
  hashToolArguments,
  isVoiceTool,
  runVoiceTool,
} from '../services/voice/voice-tools.js'

import { registerVoiceCallRecordRoute } from './voice-call-record.js'
import { registerVoiceConversationRoutes } from './voice-conversation.js'
import { registerVoiceEnrolmentRoutes } from './voice-enrolment.js'
import { sendVoiceError } from './voice-route-errors.js'

import type { RouteDeps } from './types.js'

/**
 * Calling the Personal Assistant with live voice.
 *
 * The API is the credential broker and nothing more during the call itself:
 * it mints Google's one-use ephemeral credential through Ledger, and audio
 * then flows straight between the client and Google. `LEDGER_PROXY_TOKEN`
 * never leaves this process.
 *
 * Authorization matrix. `session` is ordinary cookie/bearer auth; `device` is
 * the voice-scoped credential the native layer holds during a call, which the
 * global auth hook accepts on exactly the rows marked for it and refuses with
 * `403 VOICE_CREDENTIAL_OUT_OF_SCOPE` everywhere else in the API — never on
 * the generic message or thread routes:
 *
 * | Method | Path                                 | Who                 | Auth            |
 * |--------|--------------------------------------|---------------------|-----------------|
 * | GET    | /api/voice/capability                | any active member   | session         |*
 * | POST   | /api/voice/installations             | any active member   | session         |*
 * | DELETE | /api/voice/installations/:id         | its owner           | session         |*
 * | POST   | /api/voice/device-token              | any active member   | session         |*
 * | POST   | /api/voice/device-token/refresh      | the device itself   | device          |*
 * | POST   | /api/voice/sessions                  | any active member   | session, device |
 * | POST   | /api/voice/sessions/:id/rotate       | the call's own user | session, device |
 * | POST   | /api/voice/sessions/:id/usage        | the call's own user | session, device |
 * | POST   | /api/voice/sessions/:id/tool-call    | the call's own user | session, device |
 * | POST   | /api/voice/sessions/:id/pa-send      | the call's own user | session, device |†
 * | GET    | /api/voice/sessions/:id/replies      | the call's own user | session, device |†
 * | POST   | /api/voice/sessions/:id/transcript   | the call's own user | session, device |‡
 * | POST   | /api/voice/sessions/:id/end          | the call's own user | session, device |
 *
 * The rows marked * are enrolment rather than calling — whether this
 * deployment can call, which device is calling, and what that device holds —
 * and live in `voice-enrolment.ts`. They are listed here because this is the
 * subsystem's front door and the matrix is only useful whole. Minting is
 * `session` on purpose: a credential that could mint its successor would
 * outlive the sign-out that should have ended it, so renewal is the refresh
 * row, which carries the original sign-in forward.
 *
 * The row marked ‡ is the durable record a call leaves behind, in
 * `voice-call-record.ts`. The rows marked † are the conversation bridge and
 * live in
 * `voice-conversation.ts`; they are the voice-scoped equivalents of the
 * generic message routes, which this credential is refused on: the thread is
 * the call's own and is never named by the caller, which is what keeps the
 * scope from widening into "write to any thread this person can see".
 *
 * Spec: docs/plans/2026-09-02-gemini-voice-calling/overview.md
 */
export const registerVoiceRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    authSecret,
    ledgerIdentity,
    loadPersonalAssistantState,
    requireActorContext,
    requireUserActor,
  } = deps

  /**
   * The routes a native call reaches while the phone is locked.
   *
   * Marking them here is the scope itself: the voice-scoped device credential
   * is accepted on exactly these, and rejected everywhere else in the API —
   * there is no generic route-scoping machinery to lean on, so widening the
   * scope has to be a visible edit at a route. Enrolment is deliberately not
   * on this list: provisioning is the WebView's job, on an ordinary session.
   */
  const duringACall = { config: { voiceCredential: true } } as const

  registerVoiceEnrolmentRoutes(app, deps)
  registerVoiceConversationRoutes(app, deps, duringACall)
  registerVoiceCallRecordRoute(app, deps, duringACall)

  app.post('/api/voice/sessions', duringACall, async (request, reply) => {
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
            // The agent's own voice, falling back to the deployment default.
            voiceName: resolveVoiceName(assistant.agent.voiceName),
            systemInstruction: buildVoiceSystemInstruction({
              agentName: assistant.agent.name,
              agentSpeakingStyle: assistant.agent.speakingStyle ?? null,
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

  app.post('/api/voice/sessions/:sessionId/rotate', duringACall, async (request, reply) => {
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

  app.post('/api/voice/sessions/:sessionId/usage', duringACall, async (request, reply) => {
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
  app.post('/api/voice/sessions/:sessionId/tool-call', duringACall, async (request, reply) => {
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

  app.post('/api/voice/sessions/:sessionId/end', duringACall, async (request, reply) => {
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

