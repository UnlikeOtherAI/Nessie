import {
  CardPostToolInputSchema,
  CardPostToolOutputSchema,
  type AgentCardSpec,
  type CardPostToolInput,
} from '@nessie/schemas'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { postAgentCard } from './agent-card-post.js'
import { assertCardSecretDestinations } from './card-secrets.js'

/**
 * `card_post` — the one tool behind every agent chat card.
 *
 * The card row is the authority and the message carries only its id; the
 * message exists so the card sits in the thread, the unread counters, search,
 * notifications and the model's own transcript window like anything else said
 * in the conversation.
 *
 * Design: docs/plans/2026-09-01-agent-chat-cards.md
 */

/**
 * An image block names an attachment, never a URL, so a card can only show
 * something the run could already see. Reach is the `attachment_read` rule:
 * message-linked, same organisation, and inside a channel the reader can see —
 * with an autonomous run bounded by its own channel.
 */
const assertReachableImages = async (
  context: BuiltinToolRuntimeContext,
  spec: AgentCardSpec,
): Promise<void> => {
  const attachmentIds = spec.blocks.flatMap((block) =>
    block.type === 'image' ? [block.attachmentId] : [],
  )
  if (attachmentIds.length === 0) return

  const readerId =
    context.actorContext.actor.actorType === 'user'
      ? context.actorContext.actor.actorId
      : context.actorContext.actionContext.effectiveUserId ?? null

  for (const attachmentId of attachmentIds) {
    const attachment = await context.prisma.attachment.findUnique({
      select: { id: true, messageId: true, mime: true, organizationId: true },
      where: { id: attachmentId },
    })
    if (
      !attachment
      || attachment.organizationId !== context.channel.organizationId
      || !attachment.messageId
    ) {
      throw new Error(`Attachment ${attachmentId} is not available to show on a card.`)
    }
    if (!attachment.mime.startsWith('image/')) {
      throw new Error(`Attachment ${attachmentId} is not an image.`)
    }
    const visibleMessage = await context.prisma.message.findFirst({
      select: { id: true },
      where: {
        id: attachment.messageId,
        thread: {
          channel: readerId
            ? { members: { some: { userId: readerId } }, organizationId: attachment.organizationId }
            : { id: context.channel.id, organizationId: attachment.organizationId },
        },
      },
    })
    if (!visibleMessage) {
      throw new Error(`Attachment ${attachmentId} is not available to show on a card.`)
    }
  }
}

/**
 * Who the agent asked. `requester` is the default when a person actually asked
 * for this run: an "Allow" pressed by a bystander on somebody else's behalf is
 * the failure worth avoiding. An unattended run has no requester, so it falls
 * back to the thread — whoever reads the channel answers.
 */
const resolveRespondentUserIds = async (
  context: BuiltinToolRuntimeContext,
  respondents: ReturnType<typeof CardPostToolInputSchema.parse>['respondents'],
): Promise<string[]> => {
  const requesterId = context.run.originatingUserId ?? context.run.principalUserId ?? null
  const choice = respondents ?? (requesterId ? 'requester' : 'thread')

  if (choice === 'thread') return []
  if (choice === 'requester') {
    if (!requesterId) {
      throw new Error(
        'This run has no requesting person, so respondents:"requester" has nobody to ask. '
        + 'Use "thread" or name userIds.',
      )
    }
    return [requesterId]
  }

  const requested = [...new Set(choice.userIds)]
  // Never ask somebody who cannot see the card: they would be named as the
  // blocker on a card they can never open.
  const reachable = await context.prisma.channelMember.findMany({
    select: { userId: true },
    where: { channelId: context.channel.id, userId: { in: requested } },
  })
  const reachableIds = new Set(reachable.map((member) => member.userId))
  const unreachable = requested.filter((userId) => !reachableIds.has(userId))
  if (unreachable.length > 0) {
    throw new Error(
      `These people are not in this conversation and cannot answer a card here: ${unreachable.join(', ')}.`,
    )
  }
  return requested
}

/** A prepared call's arguments are stored on the row; a card is not a file store. */
const MAX_PREPARED_ARGUMENT_BYTES = 16_000

/**
 * A prepared call runs when its button is pressed, without the model reading
 * anything first, so it may only stand for a decision the press makes whole:
 * a plain button (not a doorway), on a card with nothing to fill in (entered
 * values could never reach the prepared arguments), posted by a run that
 * finishes its turn rather than waiting on the answer (a waiting run is
 * resumed to carry on its own work). Refused here, where the agent can still
 * fix it, rather than at the press.
 */
const assertPreparedActions = (input: CardPostToolInput): void => {
  const prepared = Object.entries(input.prepared ?? {})
  if (prepared.length === 0) return
  if (input.wait) throw new Error('A card with prepared buttons cannot also wait: drop wait or prepared.')
  if (input.card.blocks.some((block) => block.type === 'input' || block.type === 'secret')) {
    throw new Error('Prepared buttons need a card with no input or secret fields: '
      + 'what the person types could never reach the prepared arguments.')
  }
  for (const [key, call] of prepared) {
    const action = input.card.actions.find((candidate) => candidate.key === key)
    if (!action) throw new Error(`prepared names "${key}", which is not one of this card's buttons.`)
    if (action.href) throw new Error(`The "${action.label}" button opens a page, so it cannot also run a call.`)
    if (call.tool === 'card_post') throw new Error('A prepared button cannot post another card.')
    if (Buffer.byteLength(JSON.stringify(call.arguments), 'utf8') > MAX_PREPARED_ARGUMENT_BYTES) {
      throw new Error(`The "${action.label}" button's prepared arguments are too large.`)
    }
  }
}

export const runCardPostTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const parsed = CardPostToolInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'That card is not valid.')
  }
  const args = parsed.data
  assertPreparedActions(args)
  const runContext = context.runContext
  if (!runContext) {
    throw new Error('Unable to resolve the current conversation.')
  }

  await assertReachableImages(context, args.card)
  // Validated at post time, not at press time: a card offering to store a
  // credential somewhere it cannot go should never be shown to anybody.
  const secretDestinations = await assertCardSecretDestinations(context, args.card)

  const respondentUserIds = await resolveRespondentUserIds(context, args.respondents)
  const expiresAt = args.expiresIn
    ? new Date(Date.now() + args.expiresIn * 1000)
    : null

  const created = await postAgentCard(context, runContext, {
    card: args.card,
    expiresAt,
    ...(args.prepared && Object.keys(args.prepared).length > 0 ? { preparedActions: args.prepared } : {}),
    respondentUserIds,
  })

  const output = CardPostToolOutputSchema.parse({
    cardId: created.cardId,
    messageId: created.messageId,
    status: 'open' as const,
  })

  return {
    // The card is this turn's message in the conversation, so the run owes the
    // person nothing further and may end without a word.
    deliveredToConversation: true,
    inputSummary:
      `title=${args.card.title}; actions=${args.card.actions.length}`
      + `; respondents=${respondentUserIds.length === 0 ? 'thread' : respondentUserIds.length}`
      + `${args.wait ? '; wait' : ''}`
      + `${args.prepared ? `; prepared=${Object.keys(args.prepared).length}` : ''}`
      + `${secretDestinations.length > 0 ? `; secrets=${secretDestinations.length}` : ''}`,
    outputPreview: JSON.stringify(output),
    ...(args.wait ? { pendingInput: { cardId: created.cardId } } : {}),
    toolName: 'card_post',
  }
}
