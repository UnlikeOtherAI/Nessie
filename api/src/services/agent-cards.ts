import { type Prisma, type PrismaClient } from '@prisma/client'
import { applyReplyBookkeeping, canUserReadDisclosureBasis } from '@nessie/runtime'
import { z } from 'zod'
import {
  AgentCardResponseMetadataSchema,
  AgentCardSpecSchema,
  AuthorizedActionContextSchema,
  parseChannelId,
  parseThreadId,
  type AgentCardPresenter,
  type AgentCardSpec,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import {
  presentAgentCardBlocks,
  renderAgentCardResponseText,
  validateAgentCardSubmission,
  AgentCardValueError,
} from '@nessie/team-admin'

import { findThreadForUser } from './messages.js'

/**
 * Reading and answering an agent chat card.
 *
 * The row is the authority for everything mutable; the message carries only
 * its id. Every read here is viewer-scoped and an unreadable card is shaped
 * exactly like an absent one — a card id is a global UUID, so a thread gate
 * alone would leak across organisations.
 *
 * Design: docs/plans/2026-09-01-agent-chat-cards.md
 */

export type LoadedAgentCard = NonNullable<Awaited<ReturnType<typeof loadReadableCard>>>

/**
 * A card the viewer may see at all: same organisation, a thread they can
 * reach, and the card message's own disclosure basis satisfied. Failure is
 * always `null` so the route can answer one indistinguishable 404.
 */
export const loadReadableCard = async (
  prisma: PrismaClient,
  input: { cardId: string; organizationId: string; userId: string },
) => {
  const card = await prisma.agentCard.findFirst({
    select: {
      agent: { select: { id: true, name: true, role: true, systemPrompt: true } },
      agentId: true,
      channelId: true,
      expiresAt: true,
      id: true,
      message: {
        select: {
          basisScopes: { select: { scopeId: true, scopeType: true } },
          id: true,
          rootMessageId: true,
        },
      },
      messageId: true,
      organizationId: true,
      resolutionValues: true,
      browserLogin: true,
      resumeState: true,
      resolvedActionKey: true,
      resolvedAt: true,
      resolvedBy: { select: { displayName: true, id: true } },
      respondentUserIds: true,
      secretOutcomes: true,
      spec: true,
      status: true,
      threadId: true,
      waitRunId: true,
    },
    where: { id: input.cardId, organizationId: input.organizationId },
  })
  if (!card) return null

  const thread = await findThreadForUser(
    prisma,
    card.threadId,
    input.userId,
    input.organizationId,
  )
  if (!thread) return null

  if (card.message.basisScopes.length > 0) {
    const readable = await canUserReadDisclosureBasis(prisma, {
      agentId: card.agentId,
      basis: card.message.basisScopes,
      channelId: card.channelId,
      messageId: card.messageId,
      organizationId: card.organizationId,
      userId: input.userId,
    })
    if (!readable) return null
  }

  return card
}

/** Expiry is a property of the clock, so a lapsed row reads as expired before any sweep runs. */
const effectiveStatus = (card: {
  expiresAt: Date | null
  status: 'open' | 'resolved' | 'expired' | 'cancelled'
}): 'open' | 'resolved' | 'expired' | 'cancelled' =>
  card.status === 'open' && card.expiresAt && card.expiresAt.getTime() <= Date.now()
    ? 'expired'
    : card.status

/**
 * The service mark. Resolved server-side from the agent's key against the app
 * catalogue under the viewer's own store floor — the model never supplies an
 * icon URL, and an upstream URL never reaches a browser.
 */
const resolveServiceIcon = async (
  prisma: PrismaClient,
  input: { organizationId: string; serviceKey: string },
): Promise<string | null> => {
  const entry = await prisma.mcpCatalogEntry.findFirst({
    select: { iconAttachmentId: true, id: true },
    where: {
      OR: [{ organizationId: null }, { organizationId: input.organizationId }],
      moderationState: { in: ['curated', 'approved'] },
      name: input.serviceKey,
      trustLevel: { not: 'blocked' },
    },
  })
  return entry?.iconAttachmentId ? `/api/apps/${entry.id}/icon` : null
}

export const presentAgentCard = async (
  prisma: PrismaClient,
  card: LoadedAgentCard,
  viewerUserId: string,
): Promise<AgentCardPresenter | null> => {
  const parsed = AgentCardSpecSchema.safeParse(card.spec)
  if (!parsed.success) return null
  const spec: AgentCardSpec = parsed.data
  const status = effectiveStatus(card)

  // The one "is this still actionable?" decision, made here so the client
  // never has to fold status, expiry and respondent membership itself.
  const isRespondent =
    card.respondentUserIds.length === 0 || card.respondentUserIds.includes(viewerUserId)
  const action = status === 'open' && isRespondent ? ('respond' as const) : ('none' as const)

  const waitingFor =
    status === 'open' && card.respondentUserIds.length > 0
      ? (
          await prisma.user.findMany({
            select: { displayName: true, id: true },
            where: { id: { in: card.respondentUserIds } },
          })
        ).map((user) => user.displayName)
      : []

  const secretLabels: Record<string, string> = {}
  for (const block of spec.blocks) {
    if (block.type !== 'secret') continue
    if (block.destination.kind === 'dashboard_source_credential') {
      const source = await prisma.dashboardDataSource.findFirst({
        select: { name: true },
        where: {
          archivedAt: null,
          id: block.destination.sourceId,
          organizationId: card.organizationId,
        },
      })
      secretLabels[block.key] = source ? `the ${source.name} dashboard source` : 'the dashboard source'
      continue
    }
    const instance = await prisma.mcpServerInstance.findFirst({
      select: { catalogEntry: { select: { displayName: true } } },
      where: {
        id: block.destination.instanceId,
        organizationId: card.organizationId,
      },
    })
    secretLabels[block.key] = instance?.catalogEntry?.displayName ?? 'the connector'
  }

  const values = (card.resolutionValues ?? {}) as Record<string, string | number | boolean>
  const secretOutcomes = (card.secretOutcomes ?? {}) as Record<string, unknown>

  return {
    action,
    actions: spec.actions,
    agentId: card.agent.id,
    agentName: card.agent.name,
    blocks: presentAgentCardBlocks(spec, secretLabels),
    cardId: card.id,
    expiresAt: card.expiresAt?.toISOString() ?? null,
    messageId: card.messageId,
    resolution:
      status === 'resolved' && card.resolvedActionKey
        ? {
            actionKey: card.resolvedActionKey,
            actionLabel:
              spec.actions.find((candidate) => candidate.key === card.resolvedActionKey)?.label
              ?? card.resolvedActionKey,
            at: (card.resolvedAt ?? new Date()).toISOString(),
            byName: card.resolvedBy?.displayName ?? null,
            byUserId: card.resolvedBy?.id ?? null,
            secrets: Object.fromEntries(
              Object.keys(secretOutcomes).map((key) => [key, 'provided' as const]),
            ),
            values,
          }
        : null,
    service: spec.service
      ? {
          iconUrl: await resolveServiceIcon(prisma, {
            organizationId: card.organizationId,
            serviceKey: spec.service.key,
          }),
          key: spec.service.key,
          label: spec.service.label,
        }
      : null,
    status,
    ...(spec.subtitle === undefined ? {} : { subtitle: spec.subtitle }),
    threadId: card.threadId,
    title: spec.title,
    waitingFor,
  }
}

/**
 * What a card-waiting run needs to come back. Written by the worker when the
 * run parked, and parsed rather than trusted: it is Json on the row, exactly
 * like `ApprovalRequest.resumeState`.
 */
export const AgentCardResumeStateSchema = z
  .object({
    actorContext: AuthorizedActionContextSchema,
    interactive: z.boolean(),
    messageId: z.string().min(1),
  })
  .strict()

export type RespondFailure =
  | { code: 'CARD_NOT_RESPONDENT'; message: string }
  | { code: 'CARD_NOT_OPEN'; message: string; status: string }
  | { code: 'CARD_INVALID_VALUES'; fieldKeys: string[]; message: string }
  | { code: 'CARD_SECRET_REFUSED'; message: string }

export type RespondResult =
  | { kind: 'resolved'; responseMessageId: string; resumedRunId: string | null }
  | { kind: 'failed'; failure: RespondFailure }

export { AgentCardValueError }

/**
 * Build the response message body. Server-authored from the card's own spec
 * and the validated values — never anything the client sent verbatim — and a
 * secret is reported as `provided`, never by value.
 */
export const buildResponseContent = (input: {
  actionKey: string
  secretKeys: string[]
  spec: AgentCardSpec
  values: Record<string, string | number | boolean>
}): string =>
  renderAgentCardResponseText({
    actionLabel:
      input.spec.actions.find((action) => action.key === input.actionKey)?.label ?? input.actionKey,
    secretKeys: input.secretKeys,
    spec: input.spec,
    values: input.values,
  })

export const buildResponseMetadata = (input: {
  actionKey: string
  cardId: string
}): Prisma.InputJsonValue =>
  AgentCardResponseMetadataSchema.parse({
    agentCardResponse: {
      actionKey: input.actionKey,
      cardId: input.cardId,
      schemaVersion: 1,
    },
  }) as unknown as Prisma.InputJsonValue

export const validateSubmission = (input: {
  actionKey: string
  secrets: Record<string, string>
  spec: AgentCardSpec
  values: Record<string, unknown>
}) => validateAgentCardSubmission(input)

export type CardOrchestrationPayload = {
  actorContext: AuthorizedActionContext
  channelId: ReturnType<typeof parseChannelId>
  content: string
  messageId: string
  threadId: ReturnType<typeof parseThreadId>
}

export const buildCardOrchestrationPayload = (input: {
  actorContext: AuthorizedActionContext
  agent: { id: string; name: string; role: string; systemPrompt: string | null }
  channelId: string
  content: string
  messageId: string
  threadId: string
}) => ({
  actorContext: input.actorContext,
  // Only the card's own agent is offered: a press answers the agent that
  // asked, and is not an invitation for the room's other agents to weigh in.
  channelAgents: [
    {
      id: input.agent.id,
      name: input.agent.name,
      role: input.agent.role,
      systemPrompt: input.agent.systemPrompt,
    },
  ],
  channelId: parseChannelId(input.channelId),
  content: input.content,
  messageId: input.messageId,
  role: 'user' as const,
  threadId: parseThreadId(input.threadId),
})

export const applyCardReplyBookkeeping = applyReplyBookkeeping
