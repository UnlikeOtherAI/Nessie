import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useContinueDesignInChat } from '../../../../facades/designer/agent-designer-identity'
import { useDesignerChat } from '../../../../facades/designer/hooks'
import type { DesignerPageContext } from '../../../../facades/designer/types'
import { formErrorMessage } from '../../../../facades/forms/form-errors'
import { useToasts } from '../../../../providers/ToastProvider'
import { useDesignerAssistantPanel } from '../designer/DesignerAssistantPanelContext'
import { revealDesignerToolCall } from '../designer/reveal-control'
import { ASSISTANT_TOOL_TABS, isAssistantToolToggle, type AgentPageTab } from './agent-page-tabs'
import type { AgentConfigForm } from './useAgentConfigForm'

type AgentDesignAssistantInput = {
  /** The agent being edited; absent while creating one. */
  agentId?: string
  form: AgentConfigForm
  pageContext: DesignerPageContext
  /** Shows the tab that holds a control before the assistant changes it. */
  showTab?: (tab: AgentPageTab) => void
}

// Two frames: the first lets React commit the tab the page just selected, the
// second lets the browser lay it out, so the reveal scrolls a visible control.
const afterTabRenders = (reveal: () => void): void => {
  window.requestAnimationFrame(() => window.requestAnimationFrame(reveal))
}

/**
 * The Design Assistant on the agent page: its conversation, where each change
 * it makes lands, and "Continue in chat".
 *
 * Everything it changes goes through a control a person could use, and the
 * page shows that control first — the tab that holds it, then the control
 * itself. An existing agent's tools are the Access tab's own form with its own
 * Save, so a toggle is handed to that tab (waiting for it to mount if the page
 * is still switching) and never written into this form, whose save leaves tools
 * alone.
 */
export const useAgentDesignAssistant = ({
  agentId,
  form,
  pageContext,
  showTab,
}: AgentDesignAssistantInput) => {
  const navigate = useNavigate()
  const panel = useDesignerAssistantPanel()

  const onToolCallStart = useCallback((name: string) => {
    const tab = ASSISTANT_TOOL_TABS[name]
    if (tab && showTab) showTab(tab)
    afterTabRenders(() => revealDesignerToolCall(name))
    return false
  }, [showTab])

  const onToolCall = useCallback((name: string, args: Record<string, unknown>) => {
    if (agentId && panel && isAssistantToolToggle(name)) return panel.dispatchToolCall(name, args)
    return false
  }, [agentId, panel])

  const chat = useDesignerChat(form.state, form.actions, form.modelOptions, {
    onToolCall,
    onToolCallStart,
    pageContext,
  })

  // The doorway into the full conversation: the draft travels as a briefing
  // the server writes, and the person lands in their own Agent Designer DM.
  const continueInChat = useContinueDesignInChat()
  const { pushToast } = useToasts()
  const handleContinueInChat = useCallback(() => {
    continueInChat.mutate(
      { ...(agentId ? { editingAgentId: agentId } : {}), formState: form.state },
      {
        onError: (error) => pushToast({
          body: formErrorMessage(error, 'The draft stays here; try again.'),
          title: 'Could not continue in chat',
        }),
        onSuccess: (result) => void navigate(`/channels/${result.channelId}`),
      },
    )
  }, [agentId, continueInChat, form.state, navigate, pushToast])

  return {
    chat,
    continuingInChat: continueInChat.isPending,
    onContinueInChat: handleContinueInChat,
  }
}
