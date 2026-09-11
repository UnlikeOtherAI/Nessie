import { useNavigate } from 'react-router-dom'
import type { AgentConversationRecord } from '@nessie/schemas'

import { useAgentConversations } from '../../../../facades/agents/hooks'
import { prewarmRowHandlers, usePrewarm } from '../../../../navigation/prewarm'
import { Notice } from '../../../primitives/Notice'
import { Pill } from '../../../primitives/Pill'
import { Skeleton } from '../../../primitives/Skeleton'
import { UnreadBadge } from '../../../primitives/UnreadBadge'
import {
  conversationRoomLabel,
  formatConversationTime,
} from './conversation-presentation'
import { conversationBodyLine } from './conversation-status'

/** Where a conversation lives — one spelling of the route, for every caller. */
export const conversationPath = (conversation: AgentConversationRecord): string =>
  `/channels/${encodeURIComponent(conversation.channel.id)}`
  + `/threads/${encodeURIComponent(conversation.id)}`

type AgentConversationListProps = {
  agentId: string | undefined
  /**
   * The conversation on screen. Its row is `aria-current` and takes the
   * selected background; absent on the agent page, where no thread is open.
   */
  activeThreadId?: string | null
  /**
   * The room on screen. A row from anywhere else carries a chip saying where
   * it goes — a list is only honest about "switch between them" if a row that
   * leaves the room admits it.
   */
  activeChannelId?: string | null
  /** How often the list refreshes while it is visible; the caller decides. */
  refetchInterval?: number | ((conversations: AgentConversationRecord[]) => number)
  /** Selected after the navigation — the panel focuses its composer with it. */
  onSelect?: (conversation: AgentConversationRecord) => void
}

/**
 * Every conversation an agent is in that the reader may see.
 *
 * One component, two homes: the column beside a chat (`AgentConversationsPanel`)
 * and the agent's own page tab, which renders it at page width. They are the
 * same list — same rows, same order, same scope rule — so it is parameterised
 * rather than copied.
 *
 * Rows are buttons rather than links because the row is a switch between
 * conversations rather than a document to open in a new tab; the destination
 * is one function (`conversationPath`) so nothing hand-builds it.
 */
export const AgentConversationList = ({
  activeChannelId = null,
  activeThreadId = null,
  agentId,
  onSelect,
  refetchInterval,
}: AgentConversationListProps) => {
  const navigate = useNavigate()
  const prewarm = usePrewarm()
  const query = useAgentConversations(agentId, {
    ...(refetchInterval === undefined ? {} : { refetchInterval }),
  })
  const conversations = query.data

  if (query.isPending) {
    return <Skeleton className="p-3" count={3} variant="list" />
  }

  if (query.isError) {
    return (
      <div className="p-3">
        <Notice role="alert" size="sm" tone="danger">
          <div className="flex flex-wrap items-center gap-2">
            <span>Couldn’t load these conversations.</span>
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              onClick={() => void query.refetch()}
              type="button"
            >
              Try again
            </button>
          </div>
        </Notice>
      </div>
    )
  }

  if (conversations.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-sm text-[color:var(--tx3)]">
        No conversations yet
      </p>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-col" role="list">
        {conversations.map((conversation) => {
          const current = conversation.id === activeThreadId
          const running = conversation.activeRun !== null
          const elsewhere =
            activeChannelId !== null && conversation.channel.id !== activeChannelId
          const age = formatConversationTime(conversation.lastActivityAt)
          const to = conversationPath(conversation)
          return (
            <div key={conversation.id} role="listitem">
              <button
                aria-current={current ? 'true' : undefined}
                className={[
                  'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors',
                  'border-b border-[color:var(--sep)]',
                  current
                    ? 'bg-[color:var(--main-hover)]'
                    : 'hover:bg-[color:var(--main-hover)] focus-visible:bg-[color:var(--main-hover)]',
                ].join(' ')}
                data-testid="agent-conversation-row"
                onClick={() => {
                  void navigate(to)
                  onSelect?.(conversation)
                }}
                type="button"
                {...prewarmRowHandlers(prewarm, to)}
              >
                {/*
                  The reserved gutter: a run dot, an unread count, or nothing,
                  so every title in the list starts at the same x. It is as wide
                  as the widest of the three rather than as wide as the dot —
                  a badge that grew the slot would undo the alignment the slot
                  exists for.
                */}
                <span className="flex w-6 flex-shrink-0 justify-center pt-1.5">
                  {running ? (
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 rounded-full bg-[color:var(--success)]"
                    />
                  ) : (
                    <UnreadBadge value={conversation.unreadCount} />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold text-[color:var(--tx)]">
                    {conversation.title}
                  </span>
                  <span className="truncate text-xs text-[color:var(--tx2)]">
                    {conversationBodyLine(conversation, 'No messages yet')}
                  </span>
                </span>
                <span className="flex flex-shrink-0 flex-col items-end gap-1 pt-0.5">
                  {age ? (
                    <span className="text-[11px] text-[color:var(--tx3)]">{age}</span>
                  ) : null}
                  {elsewhere ? (
                    <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
                      {conversationRoomLabel(conversation.channel)}
                    </Pill>
                  ) : null}
                </span>
                {running ? <span className="sr-only">Running now</span> : null}
              </button>
            </div>
          )
        })}
      </div>
      {query.hasNextPage ? (
        <div className="p-3">
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
            type="button"
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Show older'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
