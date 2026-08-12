import type { PrismaClient } from '@prisma/client'
import type { FileService, ProviderImage, ProviderMessage } from '@nessie/runtime'
import {
  partitionByDisclosure,
  WITHHELD_MESSAGE_PLACEHOLDER,
  type DisclosureViewer,
} from '@nessie/runtime'
import type { ConsumedSourceSink } from './disclosure-basis.js'
import {
  describeAttachments,
  loadInlineImages,
  loadMessageAttachments,
} from '../message-attachments.js'
import {
  buildResearchRoutingBlock,
  type ResearchRoutingFacts,
} from './research-routing.js'
import type { RunContext, StoredConversationMessage } from './types.js'

// A turn's text as the model sees it: what was written, plus the inventory of
// any files that came with it. The note is what makes an image-only message a
// message at all, and what tells the model which attachments it can reach with
// `attachment_read` when it cannot look at them directly.
const withAttachmentNote = (message: StoredConversationMessage): string => {
  if (!message.attachmentNote) {
    return message.content
  }
  return message.content.trim()
    ? `${message.content}\n${message.attachmentNote}`
    : message.attachmentNote
}

/**
 * Render a stored conversation turn as a provider message. Assistant turns
 * authored by a *different* agent than the one now acting are prefixed with the
 * author's name so the model can tell "someone else said this" from "I said
 * this" — the acting agent's own turns stay unprefixed. Human turns pass through
 * unchanged (they are already the distinct `user` role), carrying any inlined
 * images so a vision-capable model can look at what was posted.
 */
const toProviderConversationMessage = (
  message: StoredConversationMessage,
  actingAgentId: string,
): ProviderMessage => {
  const content = withAttachmentNote(message)
  const isOtherAgent =
    message.role === 'assistant'
    && !!message.authorAgentId
    && message.authorAgentId !== actingAgentId

  if (message.role === 'user') {
    return {
      content,
      role: 'user',
      ...(message.images?.length ? { images: message.images } : {}),
    }
  }

  if (!isOtherAgent) {
    return { content, role: message.role }
  }

  const authorName = message.authorAgentName?.trim() || 'Another agent'
  return { content: `${authorName}: ${content}`, role: 'assistant' }
}

export const buildModelPrompt = (
  conversation: StoredConversationMessage[],
  context: RunContext,
  prompt: string,
  memoryContext: string | null,
  options: {
    /**
     * Untrusted working notes from an earlier incomplete run in this thread,
     * already framed by `buildCheckpointInjection`.
     */
    checkpointNotes?: string | null
    /** Structural toolset facts driving the research routing block (§9). */
    routing?: ResearchRoutingFacts
  } = {},
): ProviderMessage[] => {
  const hasOtherAgentTurn = conversation.some(
    (message) =>
      message.role === 'assistant'
      && !!message.authorAgentId
      && message.authorAgentId !== context.agent.id,
  )

  const systemParts = [
    `You are ${context.agent.name}.`,
    hasOtherAgentTurn
      ? [
        'This thread is shared with other agents. Messages from other agents',
        'are prefixed with their name (e.g. "Aria: ..."); your own earlier',
        'replies appear with no prefix. Never attribute another agent\'s',
        'message to yourself, and do not add a name prefix to your own reply.',
      ].join(' ')
      : '',
    context.agent.systemPrompt?.trim() ?? '',
    `Current date and time: ${new Date().toISOString()} (UTC). When the user gives a `
      + 'relative or wall-clock time, resolve it against this; treat wall-clock times '
      + 'as UTC unless the user states a timezone.',
    'You have access to tools. Use them when needed to answer the request accurately.',
    'Call tools by their function name. Do not fabricate tool output — always call the tool.',
    'When you need an id for a channel, person, or thread you only know by name, '
      + 'resolve it yourself with the lookup tools (channel_find, people_search) — '
      + 'never ask the user to paste an id.',
    'Channel names are not globally unique. Use channel_find to confirm the project/team scope, scoped slug, and channelId before targeting a named channel.',
    'When referring to a duplicated channel in text, write the scoped mention from channel_find rather than a bare #general.',
    [
      'When you point someone to a specific earlier message, conversation, or',
      'piece of work that a tool result surfaced, link directly to it —',
      '`[short label](link)` using the exact `link=` value that result gave',
      'you — instead of describing where it is in prose (e.g. not "it\'s in',
      'the #general thread from last week"). Only link to a location a tool',
      'actually returned to you in this run; never construct or guess a link.',
    ].join(' '),
    'When you have enough information, respond directly without calling more tools.',
    'Use relevant memory context when it helps, but prefer the latest explicit user instructions on conflict.',
    'Keep the answer concise and concrete.',
    [
      'Write like a person in a chat thread, not a help-desk bot.',
      '- No sycophantic openers ("Sure!", "Absolutely!", "Great question!", "Of course!").',
      '- No restating what the user just asked before answering.',
      [
        '- No closing offers to help further ("feel free to ask", "let me know if',
        'you need anything else", "happy to help", "hope this helps"). The user',
        'is in a chat; they can just ask again.',
      ].join(' '),
      '- No unsolicited summaries of your own reply.',
      [
        '- No bracketed section labels at the start of a reply ("[Scene]",',
        '"[Setting]", "[Narration]", "[Note]", "[OOC]", etc.). Write the prose',
        'or answer directly.',
      ].join(' '),
      '- Match the register of the message you are replying to. Short casual question → short casual answer.',
    ].join('\n'),
    options.routing ? buildResearchRoutingBlock(options.routing) ?? '' : '',
  ].filter((part) => part.length > 0)

  const messages: ProviderMessage[] = [{ content: systemParts.join('\n\n'), role: 'system' }]

  if (memoryContext) {
    messages.push({
      content: memoryContext,
      role: 'system',
    })
  }

  // Checkpoint notes come after the system messages and before the
  // conversation, carrying their own untrusted framing (§5).
  if (options.checkpointNotes) {
    messages.push({ content: options.checkpointNotes, role: 'system' })
  }

  if (conversation.length > 0) {
    messages.push(
      ...conversation.map((message) =>
        toProviderConversationMessage(message, context.agent.id),
      ),
    )
  }

  const lastConversationMessage = conversation.at(-1)
  // Compared against the raw stored content, never the attachment-annotated
  // render: a message whose only payload is a photo has empty text, and its
  // turn is already in the window above — appending it again would duplicate
  // the turn and strip its images.
  const shouldAppendPrompt =
    prompt.trim().length > 0
    && (!lastConversationMessage
      || lastConversationMessage.role !== 'user'
      || lastConversationMessage.content.trim() !== prompt.trim())

  if (shouldAppendPrompt) {
    messages.push({ content: prompt.trim(), role: 'user' })
  }

  return messages
}

export const loadConversation = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    // The one FileService chokepoint, so the window's images can be inlined for
    // a vision-capable model. Omit it and turns still name their attachments.
    files?: FileService
    // Reply-thread placement (#233): when set, the window is scoped to that root
    // message and its replies, so a run answering inside a reply thread sees
    // that thread's context rather than the whole channel thread.
    rootMessageId?: string | undefined
    threadId: string
    /**
     * Who this window is being assembled for. Required, not optional: a new
     * caller must decide rather than silently bypass the predicate. Autonomous
     * runs pass `{ kind: 'autonomous' }` and see only unrestricted turns.
     */
    viewer: DisclosureViewer
    /**
     * The run's provenance sink. Admitted turns' bases are unioned into it so a
     * reply derived from the transcript inherits their restriction.
     */
    consumedSources: ConsumedSourceSink
  },
): Promise<StoredConversationMessage[]> => {
  const messages = await prisma.message.findMany({
    // Exclude internal `system`-role messages (e.g. a PA scheduled kickoff
    // prompt) so they never leak into the model's conversation window. The
    // current run still receives its prompt directly via payload.messageId.
    where: input.rootMessageId
      ? {
          threadId: input.threadId,
          role: { not: 'system' },
          OR: [{ id: input.rootMessageId }, { rootMessageId: input.rootMessageId }],
        }
      : { threadId: input.threadId, role: { not: 'system' } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      content: true,
      role: true,
      agentId: true,
      // Live agent name — resolved via the FK join at run time, so an agent
      // rename is always reflected and no stale name is ever baked into the
      // prompt path.
      agent: { select: { name: true } },
      basisScopes: { select: { scopeType: true, scopeId: true } },
    },
    take: 20,
  })

  const ordered = messages.reverse()

  // Disclosure predicate. A turn the viewer cannot satisfy becomes a fixed
  // server-authored placeholder rather than vanishing: a silent gap makes the
  // model invent continuity across a hole it cannot see.
  const { visible: readable, withheld } = partitionByDisclosure(ordered, input.viewer)
  const withheldIds = new Set(withheld.map((message) => message.id))

  // Transitive inheritance. A reply built from the transcript rather than from
  // retrieval would otherwise compute an empty basis, so "summarise that" would
  // launder a restricted turn into an unrestricted one in a single turn. Every
  // admitted turn's basis therefore joins the run's sink, and anything this run
  // writes inherits it.
  for (const message of readable) {
    input.consumedSources.addAll(message.basisScopes)
  }

  // Attachments and inlined images are loaded only for admitted turns — a
  // withheld turn must not leak through its images or its attachment inventory.
  const readableIds = readable.map((message) => message.id)
  const attachments = await loadMessageAttachments(prisma, input.organizationId, readableIds)
  const images = input.files
    ? await loadInlineImages(input.files, input.organizationId, readableIds, attachments)
    : new Map<string, ProviderImage[]>()

  return ordered.map((message) => {
    if (withheldIds.has(message.id)) {
      return {
        content: WITHHELD_MESSAGE_PLACEHOLDER,
        role: message.role,
        authorAgentId: null,
        authorAgentName: null,
      }
    }
    const note = describeAttachments(attachments.get(message.id) ?? [])
    const inlined = images.get(message.id)
    return {
      content: message.content,
      role: message.role,
      authorAgentId: message.agentId,
      authorAgentName: message.agent?.name ?? null,
      ...(note ? { attachmentNote: note } : {}),
      ...(inlined?.length ? { images: inlined } : {}),
    }
  })
}
