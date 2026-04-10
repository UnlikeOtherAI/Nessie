import type { ModelClient, ModelMessage } from '@nessie/runtime'

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
 * Invisible channel orchestrator. Reads a user message, considers which
 * bound agents are present and what they do, and decides if/how an agent
 * should engage.
 *
 * Returns an array of decisions so a single message can @mention multiple
 * agents and have each one respond. An empty array means no action.
 *
 * Rules:
 * - If the message @mentions only users (no agents): no action
 * - If the message @mentions one or more agents by name: reply for each
 * - Otherwise: ask the LLM which agent (if any) should engage
 */
export const decideAgentEngagement = async (
  modelClient: ModelClient,
  input: {
    agents: OrchestratorAgent[]
    content: string
    recentMessages: Array<{ role: string; content: string; agentName?: string }>
  },
): Promise<OrchestratorDecision[]> => {
  if (input.agents.length === 0) {
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

  // LLM decision: should any agent engage?
  const agentDescriptions = input.agents
    .map((a) => `- "${a.name}" (id: ${a.id}, role: ${a.role}): ${a.systemPrompt?.slice(0, 120) ?? 'general assistant'}`)
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
      '3. If the message is a short acknowledgement of agent work',
      '   (e.g. "thanks", "ok", "noted") that does not need a full',
      '   reply, return:',
      '   {"action":"acknowledge","agentId":"<id>","emoji":"<emoji>"}',
      '4. If the message is clearly a conversation between users,',
      '   a greeting to a specific named human,',
      '   or not relevant to any agent, return: {"action":"none"}',
      '5. When the topic is unclear AND no agent is contextually',
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
    raw = await modelClient.chat([systemMsg, userMsg], { maxTokens: 2048, temperature: 0.1 })
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
    if (parsed.action === 'acknowledge' && parsed.emoji && input.agents.some((a) => a.id === parsed.agentId)) {
      return [{ action: 'acknowledge', agentId: parsed.agentId!, emoji: String(parsed.emoji) }]
    }
    return []
  } catch {
    return []
  }
}
