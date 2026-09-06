import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import type { CredentialStore } from '@nessie/dashboard'
import {
  AgentCardRespondBodySchema,
  AgentCardSpecSchema,
  detectSecrets,
  parseThreadId,
} from '@nessie/schemas'
import { forgetMessageThoughts } from '@nessie/memory'
import type { ReplyRootMetadata } from '@nessie/runtime'
import {
  createSystemAuthoredReply,
  inheritAgentCardResponseBasis,
} from '@nessie/team-admin'
import { enqueueOrchestrateDecide } from '@nessie/db'

import { toInputJson } from '../db/prisma-json.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  AgentCardResumeStateSchema,
  AgentCardValueError,
  buildCardOrchestrationPayload,
  buildResponseContent,
  buildResponseMetadata,
  loadReadableCard,
  presentAgentCard,
  validateSubmission,
} from '../services/agent-cards.js'
import {
  AgentCardSecretPlacementError,
  resolveAgentCardSecretPlacements,
  rollbackAgentCardSecretPlacements,
  storeAgentCardSecrets,
} from '../services/agent-card-secret-placement.js'
import { publishMessageReply } from '../services/message-delivery.js'
import { ResumeRollback, resumeSuspendedRun } from '../services/run-resume-core.js'
import type { RouteDeps } from './types.js'

/**
 * Reading and answering an agent chat card.
 *
 * The press is one transaction: claim the card, place any secret, write the
 * response message. Either all of it happened or none of it did, so a card can
 * never read "resolved" beside a credential that was not stored.
 */
export const registerAgentCardRoutes = (
  app: FastifyInstance,
  deps: RouteDeps & { dashboardCredentials: CredentialStore },
): void => {
  const { buildChannelRealtimeScopes, prisma, realtimeHub, requireActorContext } = deps

  app.get('/api/agent-cards/:cardId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { cardId } = request.params as { cardId: string }
    const card = await loadReadableCard(prisma, {
      cardId,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    if (!card) {
      sendApiError(reply, 404, 'CARD_NOT_FOUND', 'Card not found')
      return reply
    }
    const presented = await presentAgentCard(prisma, card, actorContext.actor.actorId)
    if (!presented) {
      sendApiError(reply, 404, 'CARD_NOT_FOUND', 'Card not found')
      return reply
    }
    return createApiResponse(presented)
  })

  app.post('/api/agent-cards/:cardId/respond', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(AgentCardRespondBodySchema, request.body, reply)
    if (!body) return reply

    const { cardId } = request.params as { cardId: string }
    const userId = actorContext.actor.actorId
    const organizationId = actorContext.tenant.organizationId

    // Gate one: can this person see the card at all? An indistinguishable 404,
    // because a card id is a global UUID.
    const card = await loadReadableCard(prisma, { cardId, organizationId, userId })
    if (!card) {
      sendApiError(reply, 404, 'CARD_NOT_FOUND', 'Card not found')
      return reply
    }

    // Gate two: is this person one the agent asked? The presenter already told
    // the client, so the button was never enabled — this is the server's copy.
    if (card.respondentUserIds.length > 0 && !card.respondentUserIds.includes(userId)) {
      sendApiError(
        reply,
        403,
        'CARD_NOT_RESPONDENT',
        'This card is waiting for somebody else to answer it.',
      )
      return reply
    }

    const spec = AgentCardSpecSchema.safeParse(card.spec)
    if (!spec.success) {
      sendApiError(reply, 409, 'CARD_NOT_OPEN', 'This card can no longer be answered.')
      return reply
    }

    let submission
    try {
      submission = validateSubmission({
        actionKey: body.actionKey,
        secrets: body.secrets ?? {},
        spec: spec.data,
        values: body.values ?? {},
      })
    } catch (error) {
      if (error instanceof AgentCardValueError) {
        sendApiError(
          reply,
          422,
          'CARD_INVALID_VALUES',
          error.message,
          error.fieldKeys[0],
          { fieldKeys: error.fieldKeys },
        )
        return reply
      }
      throw error
    }

    // An `input` block is ordinary text: its value is written to
    // `resolutionValues`, to the response message, to realtime and into the
    // agent's next context. A credential typed into one — an agent asking
    // "paste your API key" in a plain field rather than a `secret` block —
    // would therefore persist in the clear, so it is refused here with the
    // same interception the composer and message routes use. The `secret`
    // blocks are exempt: their values never reach any of those sinks.
    const interceptedField = Object.entries(submission.values).find(
      ([, value]) => typeof value === 'string' && detectSecrets(value).length > 0,
    )
    if (interceptedField) {
      sendApiError(
        reply,
        422,
        'SECRET_INTERCEPTED',
        'A possible credential was intercepted before this card was answered. '
          + 'Save it through Secrets instead.',
        interceptedField[0],
        { fieldKeys: [interceptedField[0]] },
      )
      return reply
    }

    // Destination access is re-checked before the conditional claim. A card
    // which could no longer store a secret remains answerable once the person
    // repairs that access, and placement still commits with the press below.
    let secretPlacements
    try {
      secretPlacements = await resolveAgentCardSecretPlacements(prisma, {
        isOwner: actorContext.actor.roles?.includes('owner') ?? false,
        organizationId,
        secrets: submission.secrets,
        spec: spec.data,
        userId,
      })
    } catch (error) {
      if (error instanceof AgentCardSecretPlacementError) {
        sendApiError(reply, error.httpStatus, error.code, error.message)
        return reply
      }
      throw error
    }

    const content = buildResponseContent({
      actionKey: body.actionKey,
      secretKeys: Object.keys(submission.secrets),
      spec: spec.data,
      values: submission.values,
    })

    let outcome: {
      responseMessageId: string
      responseRestricted: boolean
      resumedRunId: string | null
      rootMessageId: string
      replyMetadata: ReplyRootMetadata | null
      secretOutcomes: Record<string, unknown>
    }
    try {
      outcome = await prisma.$transaction(async (tx) => {
        // The claim carries the decision: two presses, or a press racing the
        // expiry sweep, have exactly one winner.
        const claimed = await tx.agentCard.updateMany({
          data: {
            resolutionValues: toInputJson(submission.values),
            resolvedActionKey: body.actionKey,
            resolvedAt: new Date(),
            resolvedByUserId: userId,
            status: 'resolved',
          },
          where: {
            id: card.id,
            status: 'open',
            ...(card.expiresAt ? { expiresAt: { gt: new Date() } } : {}),
          },
        })
        if (claimed.count !== 1) throw new ResumeRollback('run_not_waiting')

        // A sign-in handoff records who signed this browser into what, in
        // the same claim that resolves the card — so a person who signs in and
        // presses Done is recorded even if the run they unblock then fails.
        const handoff = readBrowserLoginHandoff(card.browserLogin)
        if (handoff) {
          await tx.agentBrowserLogin.create({
            data: {
              agentBrowserId: handoff.agentBrowserId,
              organizationId,
              serviceHint: handoff.service,
              userId,
            },
          })
        }

        const secretOutcomes = await storeAgentCardSecrets(tx, {
          dashboardCredentials: deps.dashboardCredentials,
          mcpSecretStore: deps.mcpSecretStore,
          organizationId,
          placements: secretPlacements,
          threadId: card.threadId,
          userId,
        })

        const rootMessageId = card.message.rootMessageId ?? card.messageId
        // The press writes a message the person authored through a form, so it
        // goes through the same door as any other server-authored row rather
        // than a ninth hand-rolled `message.create`. Follower decision: the
        // presser, because answering a card *is* participating in the reply
        // thread the card opened (docs/standards/reply-threads.md), and the
        // agent's answer to their press has to reach their Threads inbox.
        const { message: responseMessage, replyMetadata } = await createSystemAuthoredReply(
          tx,
          {
            authorId: userId,
            content,
            followedByUserIds: [userId],
            metadata: buildResponseMetadata({ actionKey: body.actionKey, cardId: card.id }),
            role: 'user',
            rootMessageId,
            threadId: card.threadId,
            userId,
          },
        )
        await inheritAgentCardResponseBasis(tx, {
          organizationId,
          responseMessageId: responseMessage.id,
          sourceBasis: card.message.basisScopes,
        })

        await tx.agentCard.update({
          data: {
            responseMessageId: responseMessage.id,
            ...(Object.keys(secretOutcomes).length > 0
              ? { secretOutcomes: secretOutcomes as Prisma.InputJsonValue }
              : {}),
          },
          where: { id: card.id },
        })

        // A run parked on this card is brought back by the press itself; its
        // continuation is the follow-up, so no engagement decision is enqueued.
        if (card.waitRunId) {
          const resumeState = AgentCardResumeStateSchema.safeParse(card.resumeState)
          if (resumeState.success) {
            const resumed = await resumeSuspendedRun(tx, {
              eventPayload: { fromCardId: card.id },
              interactive: resumeState.data.interactive,
              organizationId,
              queueKeyPrefix: 'run:card',
              resumeActorContext: resumeState.data.actorContext,
              runId: card.waitRunId,
              suspendedStatus: 'waiting_input',
              triggerMessageId: resumeState.data.messageId,
            })
            await tx.agentCard.update({
              data: { resumedByRunId: resumed.runId },
              where: { id: card.id },
            })
            return {
              replyMetadata,
              responseMessageId: responseMessage.id,
              responseRestricted: card.message.basisScopes.length > 0,
              resumedRunId: resumed.runId,
              rootMessageId,
              secretOutcomes,
            }
          }
        }

        // Nothing is waiting: the press is an ordinary human turn, and the
        // card's own agent is woken to answer it.
        await enqueueOrchestrateDecide(
          tx,
          buildCardOrchestrationPayload({
            actorContext,
            agent: {
              id: card.agent.id,
              name: card.agent.name,
              role: card.agent.role,
              systemPrompt: card.agent.systemPrompt,
            },
            channelId: card.channelId,
            content,
            messageId: responseMessage.id,
            threadId: card.threadId,
          }),
          `orchestrate:card:${card.id}`,
        )
        return {
          replyMetadata,
          responseMessageId: responseMessage.id,
          responseRestricted: card.message.basisScopes.length > 0,
          resumedRunId: null,
          rootMessageId,
          secretOutcomes,
        }
      })
    } catch (error) {
      // A vault write is the one placement that already happened by now, so
      // a press that did not commit must not leave it behind.
      await rollbackAgentCardSecretPlacements(secretPlacements)
      // A secret name is unique per scope. Without this the person sees a bare
      // 500 on a card that stays open, and every retry repeats the same wall.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        sendApiError(
          reply,
          409,
          'SECRET_NAME_TAKEN',
          'A secret with that name already exists in this scope. Rename or replace it in Secrets.',
        )
        return reply
      }
      if (error instanceof ResumeRollback) {
        sendApiError(
          reply,
          409,
          'CARD_NOT_OPEN',
          'This card has already been answered or is no longer open.',
        )
        return reply
      }
      throw error
    }

    await emitAuditEvent(prisma, {
      action: 'agent_card.responded',
      actorContext,
      metadata: {
        actionKey: body.actionKey,
        // Key names only. The values a person typed are theirs, and a secret's
        // value must never reach an audit row even through redaction.
        secretKeys: Object.keys(submission.secrets),
        valueKeys: Object.keys(submission.values),
      },
      outcome: 'success',
      resourceId: card.id,
      resourceType: 'agent_card',
    })

    // Every announcement below is scoped by the destination, not by the
    // organisation the presser happens to belong to: a card answered inside a
    // delegated system DM — the Personal Assistant's, or a global agent's home
    // — announces to that channel alone. This route used to build the pair by
    // hand and always included the organization scope, so a press in a private
    // assistant DM put its response preview on every connected member's socket.
    const scopes = buildChannelRealtimeScopes({
      channelId: card.channelId,
      organizationId,
      systemChannelType: card.channel.systemChannelType,
    })

    for (const [key, value] of Object.entries(outcome.secretOutcomes)) {
      const stored = value as { kind?: string; redactedMessageId?: string; reference?: string
        scopeType?: string }
      if (stored.kind !== 'vault_secret') continue

      // A secret saved through a card belongs in the same audit trail as one
      // saved on the Secrets screen, or that trail is silently incomplete.
      await emitAuditEvent(prisma, {
        action: 'secret.created',
        actorContext,
        metadata: { cardId: card.id, fieldKey: key, scopeType: stored.scopeType },
        outcome: 'success',
        resourceId: stored.reference ?? card.id,
        resourceType: 'secret',
      })

      if (!stored.redactedMessageId) continue

      // The message row is clean, but a person's message was copied into
      // memory at send time and recall would hand the credential straight
      // back. Deliberately outside the transaction: the memory store is a
      // separate pool, and forgetting a secret is safe even if nothing else
      // committed.
      if (deps.messageMemoryCaptureConfig) {
        await forgetMessageThoughts(
          { messageId: stored.redactedMessageId, organizationId },
          deps.messageMemoryCaptureConfig.pool,
        ).catch(() => undefined)
      }
      await emitAuditEvent(prisma, {
        action: 'message.redacted',
        actorContext,
        metadata: { cardId: card.id, fieldKey: key },
        outcome: 'success',
        resourceId: stored.redactedMessageId,
        resourceType: 'message',
      })
      // Viewers with the thread open keep rendering the plaintext until they
      // reload otherwise — the leak would outlive its own fix on screen.
      await realtimeHub.publishWs(scopes, {
        data: {
          editedAt: new Date().toISOString(),
          messageId: stored.redactedMessageId,
          threadId: parseThreadId(card.threadId),
        },
        event: 'message.updated',
      })
    }

    await realtimeHub.publishWs(scopes, {
      data: {
        cardId: card.id,
        messageId: card.messageId,
        status: 'resolved' as const,
        threadId: parseThreadId(card.threadId),
      },
      event: 'card.updated',
    })
    // The response is an ordinary reply, so the feed and the reply panel
    // refresh through the path they already use — and through the one
    // announcement envelope and the one channel-scope rule, so this press
    // cannot drift from a typed reply.
    await publishMessageReply({ buildChannelRealtimeScopes, realtimeHub }, {
      channel: {
        id: card.channelId,
        organizationId,
        systemChannelType: card.channel.systemChannelType,
      },
      message: {
        content,
        id: outcome.responseMessageId,
        ...(outcome.responseRestricted ? { restricted: true } : {}),
        role: 'user',
        userId,
      },
      rootMessageId: outcome.rootMessageId,
      threadId: card.threadId,
    })

    return createApiResponse({
      cardId: card.id,
      responseMessageId: outcome.responseMessageId,
      status: 'resolved' as const,
    })
  })
}

/**
 * A sign-in handoff's marker, written by `browser_login_request` at post time.
 *
 * Read defensively rather than trusted: the column is JSON, and a malformed
 * value must skip the login record rather than fail a press that a person has
 * already completed in the browser.
 */
export const readBrowserLoginHandoff = (
  value: unknown,
): { agentBrowserId: string; service: string } | null => {
  if (!value || typeof value !== 'object') return null
  const row = value as { agentBrowserId?: unknown; service?: unknown }
  if (typeof row.agentBrowserId !== 'string' || typeof row.service !== 'string') return null
  if (row.agentBrowserId.length === 0 || row.service.length === 0) return null
  return { agentBrowserId: row.agentBrowserId, service: row.service.slice(0, 200) }
}
