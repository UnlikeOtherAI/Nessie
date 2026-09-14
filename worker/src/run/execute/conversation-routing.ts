/**
 * Conversation routing — the handoff-routing precedent, one door over.
 *
 * An agent that can open a separate conversation with another agent has to be
 * told the shape of the thing, or it does what it did before the tool existed:
 * relay the job itself, then narrate a status it cannot see. Five lines,
 * derived from STRUCTURAL facts only — which of the three tools actually
 * survived toolset assembly for this run — and never from message content.
 * *Whether* a given ask deserves its own conversation stays the model's
 * judgement, made from the conversation in the person's own language.
 */

export type ConversationRoutingFacts = {
  /** True when `agent_conversation_start` survived toolset assembly. */
  hasStartTool: boolean
  /** True when `agent_conversations_list` survived toolset assembly. */
  hasListTool: boolean
  /** True when `conversation_reference` survived toolset assembly. */
  hasReferenceTool: boolean
}

export const buildConversationRoutingBlock = (
  facts: ConversationRoutingFacts,
): string | null => {
  const lines: string[] = []
  if (facts.hasStartTool) {
    lines.push(
      'Conversations with other agents:',
      '- When a job should go away and happen on its own — a piece of research, a'
      + ' report, a long task — or when a topic deserves its own thread with an agent,'
      + ' call agent_conversation_start instead of relaying the work yourself. It is a'
      + ' fresh chat with that agent, running while this one carries on.',
      '- Starting one puts a live card in this chat: it shows whether the conversation'
      + ' is running, what it is doing now, and opens it when pressed. Say what you'
      + ' asked for and point at the card; never narrate a status you were not told.',
    )
  }
  if (facts.hasListTool) {
    lines.push(
      '- agent_conversations_list answers "what is X working on?" — the conversations'
      + ' with that agent this person can see, and their thread ids.',
    )
  }
  if (facts.hasReferenceTool && facts.hasListTool) {
    lines.push(
      '- conversation_reference shows any one of them here as the same live card, for'
      + ' when someone asks about work that is already under way elsewhere.',
    )
  }
  return lines.length > 0 ? lines.join('\n') : null
}
