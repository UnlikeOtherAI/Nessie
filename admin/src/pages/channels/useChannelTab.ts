import { useEffect } from 'react'
import type { AgentRecord, ChannelRecord } from '../../lib/api-client'
import { useTabParam } from '../../navigation/useTabParam'
import { CHANNEL_TABS, isAgentsTabAvailable, isConversationAgentTabAvailable, isConversationTriggersTabAvailable, isConversationTodosTabAvailable, resolveConversationAgent, type ChannelTab } from '../../components/features/channels/channel-tabs'

// Which section of a conversation is showing, in one place.
//
// The section lives in `?tab=` (docs/navigation/overview.md §1, "Tab hosts"), so a link
// to a channel's Files opens on Files, a refresh keeps it, and Back leaves the
// channel rather than walking its sections.
//
// Most sections are conditional — Agents needs an agent to show, Automations is
// not offered on a one-to-one conversation, and To-dos/Triggers exist only when
// the conversation is with a single agent that has them — so the selected tab
// and the *visible* tab are separate answers. The visible one is derived rather
// than stored, so a channel swap re-decides it from that channel's own facts
// instead of leaving a stale panel behind.

type ChannelTabInput = {
  activeChannel: ChannelRecord | null | undefined
  boundAgents: AgentRecord[]
  isConversationSurface: boolean
  isOwner: boolean
  isPersonalAssistantConversation: boolean
  // Whether the channel and agent reads have landed. Every conditional section
  // is decided from them, so before they do, "unavailable" only means "not
  // known yet" — and rewriting `?tab=` on that would make a deep link to a
  // conversation's To-dos land on Messages every time.
  participantsSettled: boolean
  personalAssistantAgent: AgentRecord | null
}

export type ChannelTabState = {
  agentTabAvailable: boolean
  agentsTabAvailable: boolean
  conversationAgent: AgentRecord | null
  triggersTabAvailable: boolean
  setActiveTab: (tab: ChannelTab) => void
  todosTabAvailable: boolean
  visibleActiveTab: ChannelTab
}

export const useChannelTab = ({
  activeChannel,
  boundAgents,
  isConversationSurface,
  isOwner,
  isPersonalAssistantConversation,
  participantsSettled,
  personalAssistantAgent,
}: ChannelTabInput): ChannelTabState => {
  const [activeTab, setActiveTab] = useTabParam('tab', CHANNEL_TABS, 'messages')
  const conversationAgent = resolveConversationAgent({
    boundAgents,
    isConversationSurface,
    isPersonalAssistantConversation,
    personalAssistantAgent,
  })
  const agentsTabAvailable = isAgentsTabAvailable({
    boundAgentCount: boundAgents.length,
    conversationAgent,
    isConversationSurface,
    isPersonalAssistantConversation,
    personalAssistantPresenceCount: activeChannel?.personalAssistantPresences?.length ?? 0,
  })
  const agentTabAvailable = isConversationAgentTabAvailable(conversationAgent)
  const todosTabAvailable = isConversationTodosTabAvailable(conversationAgent)
  const triggersTabAvailable = isConversationTriggersTabAvailable({
    conversationAgent,
    isOwner,
  })

  // One record maps every conditional section to the fact that makes it
  // reachable, so the strip, the panel, and the fallback below can never
  // disagree about whether a tab exists.
  const tabAvailability: Record<ChannelTab, boolean> = {
    agent: agentTabAvailable,
    agents: agentsTabAvailable,
    automations: !isConversationSurface,
    files: true,
    messages: true,
    triggers: triggersTabAvailable,
    'to-dos': todosTabAvailable,
  }
  const selectedTabAvailable = tabAvailability[activeTab]
  // Hold the selection through the loading window rather than falling back to
  // Messages; the panels render nothing until their agent resolves, so the
  // cost is an empty pane for a beat instead of a lost deep link.
  const visibleActiveTab: ChannelTab =
    selectedTabAvailable || !participantsSettled ? activeTab : 'messages'

  // A channel whose last agent left keeps `?tab=agents` in the address bar
  // otherwise, and the URL would then describe a tab nobody can see. The
  // writer is deliberately outside the dependency list: it is re-created each
  // render, and the facts above are what the reset actually depends on.
  useEffect(() => {
    if (participantsSettled && !selectedTabAvailable) setActiveTab('messages')
  }, [
    activeTab,
    participantsSettled,
    selectedTabAvailable,
    agentTabAvailable,
    agentsTabAvailable,
    isConversationSurface,
    triggersTabAvailable,
    todosTabAvailable,
  ])

  return {
    agentTabAvailable,
    agentsTabAvailable,
    conversationAgent,
    triggersTabAvailable,
    setActiveTab,
    todosTabAvailable,
    visibleActiveTab,
  }
}
