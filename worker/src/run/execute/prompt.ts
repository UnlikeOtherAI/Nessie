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
import { loadMessageCardNotes } from '../message-cards.js'
import {
  buildResearchRoutingBlock,
  type ResearchRoutingFacts,
} from './research-routing.js'
import {
  buildMailboxRoutingBlock,
  type MailboxRoutingFacts,
} from './mailbox-routing.js'
import { buildAgentCardsBlock } from './agent-cards-prompt.js'
import {
  buildHandoffRoutingBlock,
  type HandoffRoutingFacts,
} from './handoff-routing.js'
import {
  buildAgentDocumentsBlock,
  type AgentDocumentsPromptFacts,
} from './agent-documents.js'
import { buildAgentTodoFactsBlock } from './agent-todo-facts.js'
import type { AgentTodoPromptFacts } from '@nessie/workspace-admin'
import type { RunContext, StoredConversationMessage } from './types.js'

// A turn's text as the model sees it: what was written, plus the inventory of
// any files that came with it. The note is what makes an image-only message a
// message at all, and what tells the model which attachments it can reach with
// `attachment_read` when it cannot look at them directly.
const withMessageNotes = (message: StoredConversationMessage): string => {
  const notes = [message.attachmentNote, message.cardNote].filter(
    (note): note is string => Boolean(note),
  )
  if (notes.length === 0) {
    return message.content
  }
  return message.content.trim()
    ? `${message.content}\n${notes.join('\n')}`
    : notes.join('\n')
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
  const content = withMessageNotes(message)
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
    /** Server-authored tool-gate fact for an approval continuation. */
    approvalInstruction?: string | null
    /**
     * The email conversation this run was woken by, already carrying its own
     * untrusted framing. Mail lives outside `Message`, so this is the only path
     * its content reaches the model.
     */
    emailConversation?: string | null
    /** Structural toolset facts driving the research routing block (§9). */
    routing?: ResearchRoutingFacts
    /** Structural toolset facts driving the mailbox/calendar routing block. */
    mailbox?: MailboxRoutingFacts
    /** Structural toolset facts driving the global-agent handoff block (D8). */
    handoff?: HandoffRoutingFacts
    /** Bounded, durable to-do facts, omitted unless execution tools resolve. */
    todoFacts?: AgentTodoPromptFacts | null
    /** Structural home-space and toolset facts driving the documents block. */
    documents?: AgentDocumentsPromptFacts
    /** True when `card_post` is in this run's resolved builtin toolset. */
    hasCardTool?: boolean
    /** Clock for the volatile time message. Injectable so tests can prove the
     * stable anchor carries no time at all. */
    now?: Date
  } = {},
): ProviderMessage[] => {
  const systemParts = [
    `You are ${context.agent.name}.`,
    // Unconditional on purpose: this anchor must stay byte-identical across
    // runs for provider prompt caching, and keying the paragraph on the
    // window's contents flipped the bytes whenever another agent's turn slid
    // in or out of the 20-message window in a mixed-agent channel.
    [
      'Threads can be shared with other agents. Any message from another',
      'agent is prefixed with its author\'s name (e.g. "Aria: ..."); your own',
      'earlier replies appear with no prefix. Never attribute another agent\'s',
      'message to yourself, and do not add a name prefix to your own reply.',
    ].join(' '),
    context.agent.systemPrompt?.trim() ?? '',
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
    // Length is a judgement, not a limit. "Concise" alone did not work — a
    // routine sweep came back as ~400 words with a table — but a hard ceiling
    // is worse, because the times detail is genuinely wanted are exactly the
    // times it matters. So: name the default, name the cost of overshooting,
    // and leave the call with the model.
    [
      'Match the length to what is actually being asked. Most answers are',
      'short because most questions are — lead with the answer, add the',
      'sentence or two that makes it useful, and stop. That is a default, not',
      'a limit.',
    ].join(' '),
    [
      'Write long when long is genuinely the right answer: someone asked for',
      'detail or a full report, the work has several parts that each matter,',
      'you are walking through code or a comparison, or the findings really',
      'are that substantial. Four hundred words that someone needs is a good',
      'message.',
    ].join(' '),
    [
      'What to avoid is padding: restating the question, headers and tables',
      'over content that is a sentence, exhaustive inventories of everything',
      'you checked, a summary of what you just said. That is the cost to weigh',
      '— every extra paragraph is one more thing a colleague has to read past',
      'to find what matters, and a channel full of it stops being read at all.',
    ].join(' '),
    [
      'On a scheduled or unattended run the bar is higher, because nobody',
      'asked: report what is new or needs someone to act, and if nothing does,',
      'say so in a line.',
    ].join(' '),
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
    options.mailbox ? buildMailboxRoutingBlock(options.mailbox) ?? '' : '',
    options.handoff ? buildHandoffRoutingBlock(options.handoff) ?? '' : '',
    buildAgentTodoFactsBlock(options.todoFacts ?? null) ?? '',
    options.documents ? buildAgentDocumentsBlock(options.documents) ?? '' : '',
    buildAgentCardsBlock({ hasCardTool: options.hasCardTool ?? false }) ?? '',
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
  if (options.approvalInstruction) {
    messages.push({ content: options.approvalInstruction, role: 'system' })
  }
  // Beside the checkpoint notes and for the same reason: server-authored
  // context that carries its own untrusted framing.
  if (options.emailConversation) {
    messages.push({ content: options.emailConversation, role: 'system' })
  }

  // The clock is volatile by nature, so it rides behind the stable anchor and
  // the per-run injections rather than inside them — the anchor must stay
  // byte-identical across runs for provider prompt caching (and it is what
  // `buildPromptCacheKey` hashes). Rounding down to the hour keeps even this
  // message stable across nearby runs, extending the shared prefix into the
  // conversation window when memory and checkpoint happen to match.
  const now = options.now ?? new Date()
  const hourStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000)
  messages.push({
    content:
      `Current date and time: ${hourStart.toISOString()} (UTC, rounded down to `
      + 'the hour). When the user gives a relative or wall-clock time, resolve it '
      + 'against this; treat wall-clock times as UTC unless the user states a '
      + 'timezone.',
    role: 'system',
  })

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
  const cardNotes = await loadMessageCardNotes(prisma, input.organizationId, readableIds)
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
    const cardNote = cardNotes.get(message.id)
    const inlined = images.get(message.id)
    return {
      content: message.content,
      role: message.role,
      authorAgentId: message.agentId,
      authorAgentName: message.agent?.name ?? null,
      ...(note ? { attachmentNote: note } : {}),
      ...(cardNote ? { cardNote } : {}),
      ...(inlined?.length ? { images: inlined } : {}),
    }
  })
}
