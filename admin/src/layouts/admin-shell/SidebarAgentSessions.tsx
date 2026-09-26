import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useStartAgentConversation } from '../../facades/agents/hooks'
import { parseThreadIdFromPath } from '../../lib/channel-route'
import { focusComposerState } from '../../components/features/agents/conversations/conversation-intent'
import {
  AgentConversationList,
  conversationPath,
} from '../../components/features/agents/conversations/AgentConversationList'
import { SidebarTreeChevron } from '../../components/primitives/SidebarTree'

type SidebarAgentSessionsProps = {
  agentId: string
  agentName: string
  channelId: string
  currentChannelId?: string
  entry: ReactNode
  pathname: string
}

/** The same agent conversation list as the detail panel, drawn as channel-tree children. */
export const SidebarAgentSessions = ({
  agentId,
  agentName,
  channelId,
  currentChannelId,
  entry,
  pathname,
}: SidebarAgentSessionsProps) => {
  const { t } = useTranslation('agentConversations')
  const navigate = useNavigate()
  const start = useStartAgentConversation()
  const selected = currentChannelId === channelId
  const [expanded, setExpanded] = useState(selected)
  const [error, setError] = useState<string | null>(null)
  const childrenId = `sidebar-agent-sessions-${agentId}`

  useEffect(() => {
    if (selected) setExpanded(true)
  }, [pathname, selected])

  const startConversation = async () => {
    if (start.isPending) return
    setError(null)
    try {
      const result = await start.mutateAsync({ agentId, channelId })
      void navigate(conversationPath(result.conversation), { state: focusComposerState() })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('sidebar.startFailed'))
    }
  }

  return (
    <div className="sidebar-agent-group">
      <div className="relative">
        {entry}
        <button
          aria-controls={childrenId}
          aria-expanded={expanded}
          aria-label={expanded
            ? t('sidebar.collapse', { name: agentName })
            : t('sidebar.expand', { name: agentName })}
          className="sidebar-agent-disclosure"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <SidebarTreeChevron expanded={expanded} />
        </button>
      </div>
      {expanded ? (
        <div className="sidebar-agent-children" id={childrenId}>
          <button
            aria-label={t('sidebar.newWith', { name: agentName })}
            className="admin-sb-item sidebar-child sidebar-agent-new group"
            disabled={start.isPending}
            onClick={() => void startConversation()}
            type="button"
          >
            <span aria-hidden="true">＋</span>
            <span>{start.isPending ? t('starting') : t('newConversation')}</span>
          </button>
          {error ? <p className="px-2 py-1 text-xs text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
          <AgentConversationList
            activeChannelId={channelId}
            activeThreadId={selected ? parseThreadIdFromPath(pathname) : null}
            agentId={agentId}
            presentation="sidebar"
          />
        </div>
      ) : null}
    </div>
  )
}
