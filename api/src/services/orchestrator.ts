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
 * Rules:
 * - If the message @mentions only users (no agents): action = 'none'
 * - If the message @mentions an agent by name: action = 'reply' for that agent
 * - Otherwise: ask the LLM which agent (if any) should engage
 */
export const decideAgentEngagement = async (
  modelClient: ModelClient,
  input: {
    agents: OrchestratorAgent[]
    content: string
    recentMessages: Array<{ role: string; content: string; agentName?: string }>
  },
): Promise<OrchestratorDecision> => {
  if (input.agents.length === 0) {
    return { action: 'none' }
  }

  // Fast path: check if any agent is explicitly @mentioned
  for (const agent of input.agents) {
    const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`@${escaped}(?:\\s|$|[^\\w])`, 'i').test(input.content)) {
      return { action: 'reply', agentId: agent.id }
    }
  }

  // If there are @mentions but no agent matched, assume user-to-user — stay silent
  if (/@\w/.test(input.content)) {
    return { action: 'none' }
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
      '2. If the message is a general statement that doesn\'t need',
      '   a full reply but an agent could acknowledge it',
      '   (e.g. "thanks", "ok", "noted"), return:',
      '   {"action":"acknowledge","agentId":"<id>",',
      '    "emoji":"<emoji>"}',
      '3. If the message is a conversation between users,',
      '   a greeting to a specific person,',
      '   or not relevant to any agent, return: {"action":"none"}',
      '4. When in doubt, return {"action":"none"}.',
      '   Agents should not intrude on human conversations.',
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

  const raw = await modelClient.chat([systemMsg, userMsg], { maxTokens: 128, temperature: 0.1 })

  try {
    const parsed = JSON.parse(raw.trim()) as { action?: string; agentId?: string; emoji?: string }
    if (parsed.action === 'reply' && input.agents.some((a) => a.id === parsed.agentId)) {
      return { action: 'reply', agentId: parsed.agentId! }
    }
    if (parsed.action === 'acknowledge' && parsed.emoji && input.agents.some((a) => a.id === parsed.agentId)) {
      return { action: 'acknowledge', agentId: parsed.agentId!, emoji: String(parsed.emoji) }
    }
    return { action: 'none' }
  } catch {
    return { action: 'none' }
  }
}
