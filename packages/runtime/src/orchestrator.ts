import type { LedgerAttribution } from './ledger.js'
import type { ModelClient, ModelMessage } from './model.js'

export type OrchestratorAgent = {
  id: string
  name: string
  role: string
  systemPrompt: string | null
}

export type OrchestratorDecision =
  | { action: 'reply'; agentId: string }
  | { action: 'acknowledge'; agentId: string; emoji: string }
  | { action: 'none' }

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
        mentionedReplies.push({ action: 'reply', agentId: agent.id })
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
      '4. If the message is a short acknowledgement of agent work',
      '   (e.g. "thanks", "ok", "noted") that does not need a full',
      '   reply, return:',
      '   {"action":"acknowledge","agentId":"<id>","emoji":"<emoji>"}',
      '5. If the message is clearly a conversation between users,',
      '   a greeting to a specific named human,',
      '   or not relevant to any agent, return: {"action":"none"}',
      '6. When the topic is unclear AND no agent is contextually',
      '   relevant, return: {"action":"none"}.',
      '   Agents should not intrude on purely human conversations,',
      '   but they SHOULD answer direct questions in their own',
      '   working channels.',
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
  } catch {
    // A router failure must never block a user message from being stored.
    // Fall back to "no action" and let the user re-prompt or @mention.
    return []
  }

  try {
    const parsed = JSON.parse(raw.trim()) as { action?: string; agentId?: string; emoji?: string }
    if (parsed.action === 'reply' && input.agents.some((a) => a.id === parsed.agentId)) {
      return [{ action: 'reply', agentId: parsed.agentId! }]
    }
    if (
      parsed.action === 'acknowledge' &&
      parsed.emoji &&
      input.agents.some((a) => a.id === parsed.agentId)
    ) {
      return [{ action: 'acknowledge', agentId: parsed.agentId!, emoji: String(parsed.emoji) }]
    }
    return []
  } catch {
    return []
  }
}
