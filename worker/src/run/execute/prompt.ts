import type { PrismaClient } from '@prisma/client'
import type { ProviderMessage } from '@nessie/runtime'
import type { RunContext, StoredConversationMessage } from './types.js'

/**
 * Render a stored conversation turn as a provider message. Assistant turns
 * authored by a *different* agent than the one now acting are prefixed with the
 * author's name so the model can tell "someone else said this" from "I said
 * this" — the acting agent's own turns stay unprefixed. Human turns pass through
 * unchanged (they are already the distinct `user` role).
 */
const toProviderConversationMessage = (
  message: StoredConversationMessage,
  actingAgentId: string,
): ProviderMessage => {
  const isOtherAgent =
    message.role === 'assistant'
    && !!message.authorAgentId
    && message.authorAgentId !== actingAgentId

  if (!isOtherAgent) {
    return { content: message.content, role: message.role }
  }

  const authorName = message.authorAgentName?.trim() || 'Another agent'
  return { content: `${authorName}: ${message.content}`, role: 'assistant' }
}

export const buildModelPrompt = (
  conversation: StoredConversationMessage[],
  context: RunContext,
  prompt: string,
  memoryContext: string | null,
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
  ].filter((part) => part.length > 0)

  const messages: ProviderMessage[] = [{ content: systemParts.join('\n\n'), role: 'system' }]

  if (memoryContext) {
    messages.push({
      content: memoryContext,
      role: 'system',
    })
  }

  if (conversation.length > 0) {
    messages.push(
      ...conversation.map((message) =>
        toProviderConversationMessage(message, context.agent.id),
      ),
    )
  }

  const lastConversationMessage = conversation.at(-1)
  const shouldAppendPrompt =
    !lastConversationMessage
    || lastConversationMessage.role !== 'user'
    || lastConversationMessage.content.trim() !== prompt.trim()

  if (shouldAppendPrompt) {
    messages.push({ content: prompt.trim(), role: 'user' })
  }

  return messages
}

export const loadConversation = async (
  prisma: PrismaClient,
  threadId: string,
): Promise<StoredConversationMessage[]> => {
  const messages = await prisma.message.findMany({
    // Exclude internal `system`-role messages (e.g. a PA scheduled kickoff
    // prompt) so they never leak into the model's conversation window. The
    // current run still receives its prompt directly via payload.messageId.
    where: { threadId, role: { not: 'system' } },
    orderBy: { createdAt: 'desc' },
    select: {
      content: true,
      role: true,
      agentId: true,
      // Live agent name — resolved via the FK join at run time, so an agent
      // rename is always reflected and no stale name is ever baked into the
      // prompt path.
      agent: { select: { name: true } },
    },
    take: 20,
  })

  return messages.reverse().map((message) => ({
    content: message.content,
    role: message.role,
    authorAgentId: message.agentId,
    authorAgentName: message.agent?.name ?? null,
  }))
}
