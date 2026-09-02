import { useEffect } from 'react'
import type { ChannelRecord } from '../../lib/api-client'
import { useTabParam } from '../../navigation/useTabParam'
import {
  CHANNEL_TABS,
  isAgentsTabAvailable,
  type ChannelTab,
} from '../../components/features/channels/channel-helpers'

// Which section of a conversation is showing, in one place.
//
// The section lives in `?tab=` (docs/navigation.md §1, "Tab hosts"), so a link
// to a channel's Files opens on Files, a refresh keeps it, and Back leaves the
// channel rather than walking its sections.
//
// Two of the four sections are conditional — Agents needs an agent to show, and
// Automations is not offered on a one-to-one conversation — so the selected tab
// and the *visible* tab are separate answers. The visible one is derived rather
// than stored, so a channel swap re-decides it from that channel's own facts
// instead of leaving a stale panel behind.

type ChannelTabInput = {
  activeChannel: ChannelRecord | null | undefined
  boundAgentCount: number
  isConversationSurface: boolean
  isPersonalAssistantConversation: boolean
}

export type ChannelTabState = {
  agentsTabAvailable: boolean
  setActiveTab: (tab: ChannelTab) => void
  visibleActiveTab: ChannelTab
}

export const useChannelTab = ({
  activeChannel,
  boundAgentCount,
  isConversationSurface,
  isPersonalAssistantConversation,
}: ChannelTabInput): ChannelTabState => {
  const [activeTab, setActiveTab] = useTabParam('tab', CHANNEL_TABS, 'messages')
  const agentsTabAvailable = isAgentsTabAvailable({
    boundAgentCount,
    isConversationSurface,
    isPersonalAssistantConversation,
    personalAssistantPresenceCount: activeChannel?.personalAssistantPresences?.length ?? 0,
  })
  const visibleActiveTab: ChannelTab =
    (activeTab === 'agents' && !agentsTabAvailable) ||
    (activeTab === 'automations' && isConversationSurface)
      ? 'messages'
      : activeTab

  // A channel whose last agent left keeps `?tab=agents` in the address bar
  // otherwise, and the URL would then describe a tab nobody can see. The
  // writer is deliberately outside the dependency list: it is re-created each
  // render, and the two facts above are what the reset actually depends on.
  useEffect(() => {
    if (activeTab === 'agents' && !agentsTabAvailable) setActiveTab('messages')
  }, [activeTab, agentsTabAvailable])

  return { agentsTabAvailable, setActiveTab, visibleActiveTab }
}
