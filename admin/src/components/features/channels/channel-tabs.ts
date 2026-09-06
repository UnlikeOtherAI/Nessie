import type { AgentRecord } from '../../../lib/api-client'

/**
 * Which sections a conversation offers, and when.
 *
 * The array is what `useTabParam` validates `?tab=` against; the type is
 * derived from it so a new section cannot be added to one and forgotten in the
 * other. The predicates below decide availability, and each one drives both
 * the tab button and the fallback to Messages, so a tab can never be selected
 * without a panel behind it.
 */

// The conversation's sections, in the order the strip lists them. The array is
// what `useTabParam` validates `?tab=` against; the type is derived from it so
// a new section cannot be added to one and forgotten in the other.
export const CHANNEL_TABS = [
  'messages',
  'files',
  'agent',
  'to-dos',
  'triggers',
  'automations',
  'agents',
] as const

export type ChannelTab = (typeof CHANNEL_TABS)[number]

// The Agents *list* only exists where a room has several agents to choose
// between: any ordinary channel, or a group conversation carrying more than
// one. Talking to a single agent is not a list — that conversation gets the
// Agent section instead (see `resolveConversationAgent` below), so a DM never
// renders a roster of one with a "create an agent" card beside it.
//
// One predicate drives both the tab button and the fallback to Messages, so a
// tab can never be selected without a panel behind it.
export const isAgentsTabAvailable = (input: {
  boundAgentCount: number
  conversationAgent: AgentRecord | null
  personalAssistantPresenceCount?: number
  isConversationSurface: boolean
  isPersonalAssistantConversation: boolean
}): boolean => {
  // A conversation with one subject renders the Agent section instead. The
  // Personal Assistant DM is that case by definition, even in the moment
  // before its agent record has loaded, so it never flashes a roster first.
  if (input.conversationAgent || input.isPersonalAssistantConversation) return false
  return (
    !input.isConversationSurface ||
    input.boundAgentCount + (input.personalAssistantPresenceCount ?? 0) > 0
  )
}

// Messaging one agent directly is the place a person asks "what is it working
// on?" and "what does it do on its own?", so the agent's own To-dos and
// Triggers panels get a doorway here rather than only on `/agents/:id`. Both
// are the *same* components that page renders, parameterised by this agent —
// never a second implementation (Rule zero, check 4).
//
// It resolves only when the conversation is with exactly one agent: a group DM
// carrying two agents has no single subject, and neither panel takes a set.
export const resolveConversationAgent = (input: {
  boundAgents: AgentRecord[]
  isConversationSurface: boolean
  personalAssistantAgent: AgentRecord | null
  isPersonalAssistantConversation: boolean
}): AgentRecord | null => {
  if (!input.isConversationSurface) return null
  if (input.isPersonalAssistantConversation) return input.personalAssistantAgent
  return input.boundAgents.length === 1 ? input.boundAgents[0] ?? null : null
}

// Each tab is offered only where it can answer something. The Agent section —
// who this agent is, what it can reach, and the way in to edit it — exists
// wherever a conversation has a single subject; To-dos follows the agent's own
// `todosEnabled` switch — the panel's "To-dos are off" card is the
// right answer on the agent's configuration page and pure noise as a whole tab
// in a chat. Triggers follows `GET /api/agents/:id/triggers`, which is
// owner-only: for anyone else the tab could render nothing but a refusal.
export const isConversationAgentTabAvailable = (
  conversationAgent: AgentRecord | null,
): boolean => conversationAgent !== null

export const isConversationTodosTabAvailable = (
  conversationAgent: AgentRecord | null,
): boolean => Boolean(conversationAgent?.todosEnabled)

export const isConversationTriggersTabAvailable = (input: {
  conversationAgent: AgentRecord | null
  isOwner: boolean
}): boolean => Boolean(input.conversationAgent) && input.isOwner
