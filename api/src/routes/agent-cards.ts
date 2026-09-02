import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import {
  canManageInstanceScope,
  getCatalogEntry,
  getInstance,
  isManagedIntegrationInstance,
  listInstancesVisibleToUser,
  resolveMcpUserAccess,
  storeInstanceSecret,
} from '@nessie/mcp-manage'
import {
  AgentCardRespondBodySchema,
  AgentCardSpecSchema,
  parseChannelId,
  parseOrganizationId,
  parseThreadId,
  parseUserId,
} from '@nessie/schemas'
import { applyReplyBookkeeping } from '@nessie/runtime'

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
import { ResumeRollback, resumeSuspendedRun } from '../services/run-resume-core.js'
import { enqueueOrchestrateDecide } from '../queue/pgqueue.js'
import type { RouteDeps } from './types.js'

/**
 * Reading and answering an agent chat card.
 *
 * The press is one transaction: claim the card, place any secret, write the
 * response message. Either all of it happened or none of it did, so a card can
 * never read "resolved" beside a credential that was not stored.
 */
export const registerAgentCardRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, realtimeHub, requireActorContext } = deps

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

    // Secret placement mirrors `POST /api/mcp/instances/:id/secret` exactly —
    // no weaker, no stronger — and is resolved before the transaction so a
    // refusal never leaves a half-claimed card.
    // Resolved once while validating placements, reused inside the transaction.
    let mcpAccess: Awaited<ReturnType<typeof resolveMcpUserAccess>> | null = null
    const secretPlacements: {
      authConfig: unknown
      authMethod: string
      instance: Awaited<ReturnType<typeof getInstance>>
      key: string
      shared: boolean | undefined
      value: string
    }[] = []
    for (const block of spec.data.blocks) {
      if (block.type !== 'secret') continue
      const value = submission.secrets[block.key]
      if (value === undefined) continue

      const instance = await getInstance(prisma, organizationId, block.destination.instanceId)
      if (!instance) {
        sendApiError(reply, 409, 'CARD_SECRET_REFUSED', 'That connector no longer exists.')
        return reply
      }
      if (await isManagedIntegrationInstance(prisma, organizationId, instance.id)) {
        sendApiError(
          reply,
          409,
          'INTEGRATION_MANAGED_CREDENTIAL',
          'This first-party connector manages its own credentials.',
        )
        return reply
      }
      const access = await resolveMcpUserAccess(prisma, organizationId, userId)
      mcpAccess = access
      const manageable = canManageInstanceScope(
        access,
        userId,
        instance.scopeType,
        instance.scopeId,
      )
      if (!manageable) {
        const visible = await listInstancesVisibleToUser(prisma, organizationId, userId)
        if (!visible.some((row) => row.id === instance.id)) {
          sendApiError(
            reply,
            403,
            'CARD_SECRET_REFUSED',
            'You do not have access to that connector.',
          )
          return reply
        }
      }
      const catalogEntry = await getCatalogEntry(prisma, organizationId, instance.catalogEntryId)
      if (!catalogEntry) {
        sendApiError(reply, 409, 'CARD_SECRET_REFUSED', 'That connector is not set up.')
        return reply
      }
      secretPlacements.push({
        authConfig: catalogEntry.authConfig,
        authMethod: catalogEntry.authMethod,
        instance,
        key: block.key,
        shared: block.destination.shared,
        value,
      })
    }

    const content = buildResponseContent({
      actionKey: body.actionKey,
      secretKeys: Object.keys(submission.secrets),
      spec: spec.data,
      values: submission.values,
    })

    let outcome: {
      responseMessageId: string
      resumedRunId: string | null
      rootMessageId: string | null
      replyMetadata: Awaited<ReturnType<typeof applyReplyBookkeeping>> | null
    }
    try {
      outcome = await prisma.$transaction(async (tx) => {
        // The claim carries the decision: two presses, or a press racing the
        // expiry sweep, have exactly one winner.
        const claimed = await tx.agentCard.updateMany({
          data: {
            resolutionValues: submission.values as unknown as Prisma.InputJsonValue,
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

        const secretOutcomes: Record<string, unknown> = {}
        for (const placement of secretPlacements) {
          if (!placement.instance) continue
          const stored = await storeInstanceSecret(tx, deps.mcpSecretStore, {
            access: mcpAccess ?? { role: null },
            authConfig: placement.authConfig,
            authMethod: placement.authMethod,
            instance: placement.instance,
            secret: placement.value,
            ...(placement.shared === undefined ? {} : { shared: placement.shared }),
            userId,
          })
          // The reference is deliberately absent: the row records that a
          // secret was provided and where it landed, never how to read it.
          secretOutcomes[placement.key] = {
            instanceId: placement.instance.id,
            kind: 'connector_credential',
            placement: stored.placement,
          }
        }

        const rootMessageId = card.message.rootMessageId ?? card.messageId
        const responseMessage = await tx.message.create({
          data: {
            content,
            metadata: buildResponseMetadata({ actionKey: body.actionKey, cardId: card.id }),
            role: 'user',
            rootMessageId,
            threadId: card.threadId,
            userId,
          },
          select: { createdAt: true, id: true },
        })
        const replyMetadata = await applyReplyBookkeeping(tx, {
          authorId: userId,
          replyCreatedAt: responseMessage.createdAt,
          rootMessageId,
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
              resumedRunId: resumed.runId,
              rootMessageId,
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
          resumedRunId: null,
          rootMessageId,
        }
      })
    } catch (error) {
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
      action: 'agent_card.responded' as Parameters<typeof emitAuditEvent>[1]['action'],
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

    const scopes = [
      { channelId: parseChannelId(card.channelId), kind: 'channel' as const },
      { kind: 'organization' as const, organizationId: parseOrganizationId(organizationId) },
    ]
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
    // refresh through the path they already use.
    await realtimeHub.publishWs(scopes, {
      data: {
        authorUserId: parseUserId(userId),
        channelId: parseChannelId(card.channelId),
        contentPreview: content.slice(0, 200),
        messageId: outcome.responseMessageId,
        role: 'user' as const,
        rootMessageId: outcome.rootMessageId ?? undefined,
        threadId: parseThreadId(card.threadId),
      },
      event: 'message.reply',
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
