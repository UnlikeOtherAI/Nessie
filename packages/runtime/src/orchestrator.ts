import { isCreditsExhaustedError } from './inference/types.js'
import type { LedgerAttribution } from './ledger.js'
import type { ModelClient, ModelMessage } from './model.js'

export type OrchestratorAgent = {
  id: string
  name: string
  role: string
  systemPrompt: string | null
}

/**
 * Where a reply belongs. `thread` keeps the answer inside the exchange that
 * asked for it; `channel` posts it as a standalone contribution to the room.
 * Absent ≡ the default (thread). This is a judgement about meaning, so it is
 * made by the model — never by inspecting the message text in code.
 */
export type ReplyPlacementDecision = 'thread' | 'channel'

export type OrchestratorDecision =
  | { action: 'reply'; agentId: string; replyPlacement?: ReplyPlacementDecision }
  | { action: 'acknowledge'; agentId: string; emoji: string }
  | { action: 'none' }

// Accept only the two literals the contract defines; anything else (missing,
// misspelled, a sentence) yields no field, so placement falls back to the
// default. Same fail-silent style as the surrounding decision parse.
/**
 * Accept the model's acknowledgement emoji only if it actually is one.
 *
 * This value is model-authored and lands verbatim in a `MessageReaction` row
 * that is broadcast to the whole channel — a surface nothing renders as prose
 * and nobody reads as content, which is exactly what makes it a good place to
 * hide a sentence. `String(parsed.emoji)` accepted any length of anything.
 *
 * Structural, not semantic: this constrains the *shape* of a value (is it a
 * short pictographic token?), never the meaning of a message. Every character
 * must be pictographic, an emoji component, a ZWJ, or a variation selector, and
 * at least one must be pictographic — so ZWJ families and skin-tone modifiers
 * pass while "12" or a paragraph does not.
 */
const EMOJI_SHAPE =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200D|\uFE0F|\uFE0E)+$/u
const MAX_EMOJI_UTF16_UNITS = 32

export const parseAcknowledgeEmoji = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value.length === 0 || value.length > MAX_EMOJI_UTF16_UNITS) return null
  if (!/\p{Extended_Pictographic}/u.test(value)) return null
  return EMOJI_SHAPE.test(value) ? value : null
}

const parseReplyPlacement = (value: unknown): ReplyPlacementDecision | undefined =>
  value === 'thread' || value === 'channel' ? value : undefined

/**
 * Thread-following predicate. An agent *follows* a thread once it has authored a
 * message in it — provable straight from the data, no extra schema. Given the
 * candidate agent ids for a channel and the set of agent ids that have authored
 * in the thread, return the candidates that are following.
 */
export const selectFollowingAgentIds = (
  candidateAgentIds: readonly string[],
  authoredAgentIds: Iterable<string>,
): string[] => {
  const authored = new Set(authoredAgentIds)
  return [...new Set(candidateAgentIds)].filter((id) => authored.has(id))
}

/**
 * Invisible channel orchestrator. Reads a user message, considers which
 * bound agents are present and what they do, and decides if/how an agent
 * should engage.
 *
 * Returns an array of decisions so a single message can @mention multiple
 * agents and have each one respond. An empty array means no action.
 *
 * Rules:
 * - The orchestrator engages agents ONLY in response to a human message
 *   (`triggerIsHuman`). An agent's own reply — or an agent @mentioning another
 *   agent — never triggers a reply. This is the hard anti-loop guard: it stops
 *   agent↔agent ping-pong and self-retriggering after an agent has replied.
 * - If the message @mentions only users (no agents): no action
 * - If the message @mentions one or more agents by name: reply for each
 * - Thread-following: an agent in `followingAgentIds` (one that has already
 *   posted in this thread) is a strong engagement candidate for a new human
 *   message even without a fresh @mention, so it does not go deaf in a thread it
 *   joined. Following never *forces* a reply — the LLM decision below may still
 *   decline — and it still returns at most one non-mention reply, so multiple
 *   followers never stampede a thread.
 * - Otherwise: ask the LLM which agent (if any) should engage
 */
export const decideAgentEngagement = async (
  modelClient: ModelClient,
  input: {
    agents: OrchestratorAgent[]
    content: string
    recentMessages: Array<{ role: string; content: string; agentName?: string }>
    // True only when the triggering message was authored by a human. When false,
    // the orchestrator engages no one — see the anti-loop guard above.
    triggerIsHuman: boolean
    // Ids (a subset of `agents`) already following this thread. Empty for PA DMs,
    // whose single agent already answers every message on its existing path.
    followingAgentIds?: string[]
    // Attribution for the engagement-decision LLM call so its tokens are billed
    // to the originating org/channel/thread/actor.
    usage?: LedgerAttribution
  },
): Promise<OrchestratorDecision[]> => {
  if (input.agents.length === 0) {
    return []
  }

  // Anti-loop invariant: only human messages engage agents. An agent reply (or
  // an agent-authored @mention) can never cascade into another agent reply.
  if (!input.triggerIsHuman) {
    return []
  }

  // Fast path: collect every agent explicitly @mentioned.
  const mentionedReplies: OrchestratorDecision[] = []
  const mentionedIds = new Set<string>()
  for (const agent of input.agents) {
    const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`@${escaped}(?:\\s|$|[^\\w])`, 'i').test(input.content)) {
      if (!mentionedIds.has(agent.id)) {
        mentionedIds.add(agent.id)
        // Being addressed by an explicit @mention is a structural fact, not an
        // interpretation: the answer belongs to the asker's exchange, so it is
        // always threaded.
        mentionedReplies.push({ action: 'reply', agentId: agent.id, replyPlacement: 'thread' })
      }
    }
  }
  if (mentionedReplies.length > 0) {
    return mentionedReplies
  }

  // If there are @mentions but no agent matched, assume user-to-user — stay silent
  if (/@\w/.test(input.content)) {
    return []
  }

  // LLM decision: should any agent engage? Annotate the agents already
  // following this thread so the model keeps them engaged on follow-ups.
  const followingIds = new Set(
    (input.followingAgentIds ?? []).filter((id) => input.agents.some((a) => a.id === id)),
  )
  const agentDescriptions = input.agents
    .map((a) => {
      const following = followingIds.has(a.id) ? ' [already participating in this thread]' : ''
      const summary = a.systemPrompt?.slice(0, 120) ?? 'general assistant'
      return `- "${a.name}" (id: ${a.id}, role: ${a.role})${following}: ${summary}`
    })
    .join('\n')

  const conversationContext = input.recentMessages
    .slice(-5)
    .map((msg) => `${msg.agentName ?? msg.role}: ${msg.content.slice(0, 150)}`)
    .join('\n')

  const systemMsg: ModelMessage = {
    content: [
      'You are an invisible channel orchestrator.',
      'Your ONLY job is to decide whether one of the available',
      'agents should respond to the latest user message.',
      '',
      'Available agents in this channel:',
      agentDescriptions,
      '',
      'Rules:',
      '1. If the message is clearly directed at or relevant to',
      '   one agent\'s expertise, return:',
      '   {"action":"reply","agentId":"<id>"}',
      '2. If the latest message is a direct question',
      '   (e.g. ends with "?", or starts with what/why/how/when/where/who)',
      '   AND any agent has participated in the recent conversation OR',
      '   has expertise matching the question\'s topic, return',
      '   {"action":"reply","agentId":"<id>"}',
      '   — pick the agent most recently active on that topic.',
      '   Treat a leading filler like "hey" as throat-clearing,',
      '   not as addressing a specific human.',
      '3. If an agent is marked [already participating in this thread]',
      '   and the latest human message continues that conversation',
      '   (a follow-up instruction, correction, answer, or comment on',
      '   the ongoing work — not only a question), return',
      '   {"action":"reply","agentId":"<id>"} for that agent even with',
      '   no @mention: it joined the thread, so it stays engaged. If two',
      '   or more participating agents could reply, pick only the single',
      '   most relevant one. Still return {"action":"none"} when the',
      '   message is clearly aimed at another human or is unrelated',
      '   side-chatter.',
      '4. If the message wants an agent to register it but not to say',
      '   anything back, return:',
      '   {"action":"acknowledge","agentId":"<id>","emoji":"<emoji>"}',
      '   This is the colleague who reacts 👍 instead of typing "ok".',
      '   Use it for a thank-you or a short closing remark ("thanks",',
      '   "ok", "noted"), and equally for a statement that is telling',
      '   the agent something rather than asking it anything — an FYI,',
      '   a heads-up, a "the router is back up", a decision already',
      '   made. A prose reply to those is noise. Pick an emoji that',
      '   fits what was said (👍 to confirm, 🎉 for good news, 👀 when',
      '   you have seen it and will act later). Prefer this over',
      '   {"action":"reply"} whenever a reply would carry no',
      '   information the person does not already have.',
      '5. If the message is clearly a conversation between users,',
      '   a greeting to a specific named human,',
      '   or not relevant to any agent, return: {"action":"none"}',
      '6. When the topic is unclear AND no agent is contextually',
      '   relevant, return: {"action":"none"}.',
      '   Agents should not intrude on purely human conversations,',
      '   but they SHOULD answer direct questions in their own',
      '   working channels.',
      '',
      'Every "reply" decision also carries "replyPlacement",',
      'which says where the reply belongs:',
      '- "thread": the reply is owed to the latest message —',
      '  it answers it, continues that specific exchange, or',
      '  reports on what that message asked for — so it stays',
      '  attached to it and does not interrupt the room.',
      '- "channel": the reply stands on its own as a',
      '  contribution addressed to everyone in the room rather',
      '  than to the exchange that prompted it.',
      'If the distinction is unclear, use "thread".',
      'Shape: {"action":"reply","agentId":"<id>",',
      '"replyPlacement":"thread"}',
      '',
      'Return ONLY valid JSON. No explanation.',
    ].join('\n'),
    role: 'system',
  }

  const userMsg: ModelMessage = {
    content: [
      conversationContext ? `Recent conversation:\n${conversationContext}\n` : '',
      `Latest message: ${input.content}`,
    ].join('\n'),
    role: 'user',
  }

  // Reasoning models (gpt-5-mini etc.) spend most of the budget on hidden
  // thinking tokens before they emit the final JSON. 128 is nowhere near
  // enough — the call errors out with "max_tokens reached". Give it real
  // headroom; the visible output is still only ~40 tokens.
  let raw: string
  try {
    raw = await modelClient.chat([systemMsg, userMsg], {
      maxTokens: 2048,
      temperature: 0.1,
      usage: input.usage,
    })
  } catch (error) {
    // A normal routing outage must remain fail-open: the message is stored and
    // the person can explicitly @mention an agent. Ledger's typed exhausted-
    // credit refusal is different: without surfacing it here a model-judged
    // human turn would disappear without any request run to terminalize.
    if (isCreditsExhaustedError(error)) {
      throw error
    }
    // A router failure must never block a user message from being stored.
    // Fall back to "no action" and let the user re-prompt or @mention.
    return []
  }

  try {
    const parsed = JSON.parse(raw.trim()) as {
      action?: string
      agentId?: string
      emoji?: string
      replyPlacement?: unknown
    }
    if (parsed.action === 'reply' && input.agents.some((a) => a.id === parsed.agentId)) {
      const replyPlacement = parseReplyPlacement(parsed.replyPlacement)
      return [{
        action: 'reply',
        agentId: parsed.agentId!,
        ...(replyPlacement ? { replyPlacement } : {}),
      }]
    }
    if (
      parsed.action === 'acknowledge' &&
      input.agents.some((a) => a.id === parsed.agentId)
    ) {
      const emoji = parseAcknowledgeEmoji(parsed.emoji)
      // A decision that names no usable emoji is not an acknowledgement; better
      // no reaction than a reaction carrying something that is not one.
      return emoji ? [{ action: 'acknowledge', agentId: parsed.agentId!, emoji }] : []
    }
    return []
  } catch {
    return []
  }
}
