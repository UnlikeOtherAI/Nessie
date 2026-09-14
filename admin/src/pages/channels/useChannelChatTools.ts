import { useCallback, useMemo } from 'react'
import type { NavigateFunction } from 'react-router-dom'

import type { AgentRecord, ChannelRecord } from '../../lib/api-client'
import {
  parseOpenChatTool,
  resolveChatToolAgents,
  writeOpenChatTool,
  type ChatToolId,
} from '../../components/features/channels/tool-rail/chat-tools'
import { useChatToolAgent } from '../../components/features/channels/tool-rail/useChatToolAgent'
import { useChatToolRail } from '../../components/features/channels/tool-rail/useChatToolRail'

type ChannelChatToolsInput = {
  activeChannel: ChannelRecord | null
  boundAgents: AgentRecord[]
  conversationAgent: AgentRecord | null
  conversationThreadAgent: AgentRecord | null
  inConversation: boolean
  navigate: NavigateFunction
  phoneLayout: boolean
  toolId: string | undefined
}

/**
 * Resolves the agents whose tools belong beside the open conversation and owns
 * the rail's per-agent preference. The page keeps the surrounding room state;
 * this hook keeps tool selection and its route doorway together.
 */
export const useChannelChatTools = ({
  activeChannel,
  boundAgents,
  conversationAgent,
  conversationThreadAgent,
  inConversation,
  navigate,
  phoneLayout,
  toolId,
}: ChannelChatToolsInput) => {
  // Inside a conversation the tools are its agent's. In a DM they are the
  // conversation subject's; in a room they are the bound-agent set.
  const chatToolAgents = useMemo(
    () => resolveChatToolAgents({
      boundAgents,
      conversationAgent,
      conversationThreadAgent,
      inConversation,
    }),
    [boundAgents, conversationAgent, conversationThreadAgent, inConversation],
  )
  const { selectAgent, selectedAgent } = useChatToolAgent(
    activeChannel?.id ?? null,
    chatToolAgents,
  )
  const toolRail = useChatToolRail(selectedAgent?.id ?? null, { remember: !phoneLayout })
  const routeTool = parseOpenChatTool(toolId ?? null)
  const openTool = routeTool ?? toolRail.openTool
  const conversationPath = `/channels/${activeChannel?.id ?? ''}`
  const closeTool = useCallback(() => {
    if (routeTool !== null) void navigate(conversationPath)
    else toolRail.close()
  }, [conversationPath, navigate, routeTool, toolRail])
  const toggleTool = useCallback((tool: ChatToolId) => {
    if (routeTool === null) {
      toolRail.toggle(tool)
      return
    }
    // A routed tool closes by leaving its screen; choosing another reopens the
    // preferred rail column after returning to the conversation.
    void navigate(conversationPath)
    if (routeTool !== tool) toolRail.open(tool)
  }, [conversationPath, navigate, routeTool, toolRail])
  const selectChatToolAgent = useCallback((agentId: string) => {
    if (!phoneLayout && openTool !== null) writeOpenChatTool(agentId, openTool)
    selectAgent(agentId)
  }, [openTool, phoneLayout, selectAgent])
  const openToolScreen = useCallback((tool: ChatToolId) => {
    if (activeChannel) void navigate(`/channels/${activeChannel.id}/tools/${tool}`)
  }, [activeChannel, navigate])

  return {
    chatToolAgents,
    closeTool,
    openTool,
    openToolScreen,
    routeTool,
    selectChatToolAgent,
    selectedAgent,
    toggleTool,
  }
}
