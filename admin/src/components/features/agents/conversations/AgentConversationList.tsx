import { useState } from 'react'
import { faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
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
  /**
   * The conversation to point the eye at, and which press asked for it.
   *
   * The panel sets it when the server hands back an empty conversation instead
   * of opening another (`startAgentConversation` → `reused`): that row blinks
   * so the notice above the list has something to be about. `press` is what
   * makes a second press blink again — it re-keys the row, and a CSS animation
   * only plays when the element it is on is new.
   */
  flash?: { conversationId: string; press: number } | null
  /** How often the list refreshes while it is visible; the caller decides. */
  refetchInterval?: number | ((conversations: AgentConversationRecord[]) => number)
  /** Selected after the navigation — the panel focuses its composer with it. */
  onSelect?: (conversation: AgentConversationRecord) => void
  presentation?: 'panel' | 'sidebar'
}

/**
 * Every conversation an agent is in that the reader may see.
 *
 * One component in the chat column, the agent page and the Channels sidebar.
 * The sidebar uses compact tree rows; order and access scope stay shared.
 *
 * Rows are buttons rather than links because the row is a switch between
 * conversations rather than a document to open in a new tab; the destination
 * is one function (`conversationPath`) so nothing hand-builds it.
 *
 * A ticket's work threads fold under **Tickets**, after the agent's other
 * conversations (docs/standards/ticket-work.md → "The work thread"): an agent
 * that works twenty tickets would otherwise bury the conversations people
 * started with it. A document trigger's review threads fold the same way
 * under **Documents** (docs/standards/document-triggers.md → "Where a change
 * lands"). A fold opens by itself when the one on screen is in it.
 */
export const AgentConversationList = ({
  activeChannelId = null,
  activeThreadId = null,
  agentId,
  flash = null,
  onSelect,
  presentation = 'panel',
  refetchInterval,
}: AgentConversationListProps) => {
  const navigate = useNavigate()
  const prewarm = usePrewarm()
  const query = useAgentConversations(agentId, {
    ...(refetchInterval === undefined ? {} : { refetchInterval }),
  })
  const conversations = query.data
  const [ticketsOpen, setTicketsOpen] = useState<boolean | null>(null)
  const [documentsOpen, setDocumentsOpen] = useState<boolean | null>(null)

  if (query.isPending) {
    return presentation === 'sidebar' ? null : <Skeleton className="p-3" count={3} variant="list" />
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
    if (presentation === 'sidebar') return null
    return (
      <p className="px-3 py-6 text-center text-sm text-[color:var(--tx3)]">
        No conversations yet
      </p>
    )
  }

  const renderRow = (conversation: AgentConversationRecord) => {
    const current = conversation.id === activeThreadId
    // The press that asked for this row's blink, or null: it is the key
    // suffix as much as the flag, so pressing twice plays it twice.
    const blink = flash && flash.conversationId === conversation.id ? flash.press : null
    const running = conversation.activeRun !== null
    const elsewhere =
      activeChannelId !== null && conversation.channel.id !== activeChannelId
    const age = formatConversationTime(conversation.lastActivityAt)
    const to = conversationPath(conversation)
    return (
      <div
        key={blink === null ? conversation.id : `${conversation.id}:${blink}`}
        role="listitem"
      >
        <button
          aria-current={current ? 'true' : undefined}
          className={[
            presentation === 'sidebar'
              ? 'admin-sb-item sidebar-child group'
              : 'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors border-b border-[color:var(--sep)]',
            current
              ? presentation === 'sidebar' ? 'active' : 'bg-[color:var(--main-hover)]'
              : presentation === 'sidebar' ? '' : 'hover:bg-[color:var(--main-hover)] focus-visible:bg-[color:var(--main-hover)]',
            blink === null ? '' : 'admin-attention-pulse',
          ].filter(Boolean).join(' ')}
          data-testid={presentation === 'sidebar' ? 'agent-session-sidebar-row' : 'agent-conversation-row'}
          title={presentation === 'sidebar' ? `${conversation.title} · ${conversationRoomLabel(conversation.channel)}` : undefined}
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
          <span className={presentation === 'sidebar' ? 'flex w-3 flex-shrink-0 justify-center' : 'flex w-6 flex-shrink-0 justify-center pt-1.5'}>
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
            <span className={presentation === 'sidebar' ? 'truncate' : 'truncate text-sm font-semibold text-[color:var(--tx)]'}>
              {conversation.title}
            </span>
            {presentation === 'panel' ? <span className="truncate text-xs text-[color:var(--tx2)]">
              {conversationBodyLine(conversation, 'No messages yet')}
            </span> : null}
          </span>
          {presentation === 'panel' ? <span className="flex flex-shrink-0 flex-col items-end gap-1 pt-0.5">
            {age ? (
              <span className="text-[11px] text-[color:var(--tx3)]">{age}</span>
            ) : null}
            {elsewhere ? (
              <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
                {conversationRoomLabel(conversation.channel)}
              </Pill>
            ) : null}
          </span> : null}
          {running ? <span className="sr-only">Running now</span> : null}
        </button>
      </div>
    )
  }

  // Ticket work threads fold under Tickets, document review threads under
  // Documents; everything else lists as before.
  const ticketRows = conversations.filter((conversation) => conversation.ticket)
  const documentRows = conversations.filter((conversation) => !conversation.ticket && conversation.document)
  const otherRows = conversations.filter((conversation) => !conversation.ticket && !conversation.document)
  const onScreen = (rows: AgentConversationRecord[]) => rows.some((conversation) => conversation.id === activeThreadId)
  const fold = (input: {
    label: string
    open: boolean
    rows: AgentConversationRecord[]
    setOpen: (open: boolean) => void
    testId: string
  }) => (input.rows.length > 0 ? (
    <div className="flex flex-col" data-testid={input.testId}>
      <button
        aria-expanded={input.open}
        className={presentation === 'sidebar'
          ? 'admin-sb-item sidebar-child group text-xs text-[color:var(--tx3)]'
          : 'flex min-h-11 w-full items-center gap-2 border-b border-[color:var(--sep)] px-3 text-left text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)] hover:bg-[color:var(--main-hover)]'}
        onClick={() => input.setOpen(!input.open)}
        type="button"
      >
        <FontAwesomeIcon aria-hidden className="h-2.5 w-2.5" icon={input.open ? faChevronDown : faChevronRight} />
        <span className="flex-1">{input.label}</span>
        {/* Counted over the pages loaded so far: more may sit behind "Show older". */}
        <span
          className="font-normal normal-case tracking-normal"
          title={query.hasNextPage ? `${input.rows.length} loaded so far` : undefined}
        >
          {input.rows.length}{query.hasNextPage ? '+' : ''}
        </span>
      </button>
      {input.open ? (
        <div className="flex flex-col" role="list">
          {input.rows.map(renderRow)}
        </div>
      ) : null}
    </div>
  ) : null)

  return (
    <div className="flex flex-col">
      <div className="flex flex-col" role="list">
        {otherRows.map(renderRow)}
      </div>
      {fold({
        label: 'Tickets',
        open: ticketsOpen ?? onScreen(ticketRows),
        rows: ticketRows,
        setOpen: setTicketsOpen,
        testId: 'agent-conversation-tickets',
      })}
      {fold({
        label: 'Documents',
        open: documentsOpen ?? onScreen(documentRows),
        rows: documentRows,
        setOpen: setDocumentsOpen,
        testId: 'agent-conversation-documents',
      })}
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
