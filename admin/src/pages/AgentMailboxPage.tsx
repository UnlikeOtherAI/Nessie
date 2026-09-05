import { useEffect, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { MailConversation } from '../components/features/mailbox/MailConversation'
import { MailboxThreadList, MailboxWorkspace } from '../components/features/mailbox/MailboxWorkspace'
import { TabBar } from '../components/primitives/TabBar'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import {
  useAgentMailbox,
  useMailboxConversation,
  useMailboxConversations,
} from '../facades/agent-mailbox/hooks'
import { useAgents } from '../facades/agents/queries'
import { useNavigationLayout } from '../navigation/mobile-shell'
import { useTabParam } from '../navigation/useTabParam'

type MailboxFilter = 'all' | 'inbox' | 'sent'

/**
 * The mailbox: a hosted agent's correspondence, as a real two-pane mailbox.
 *
 * This is the capability's home. It is deliberately *not* the chat feed — the
 * mail has its own store because delivery state, MIME identity and external
 * participants are not a chat thread's semantics — while the backing channel
 * next door carries the run reports and approval gates about that same
 * correspondence.
 */
export const AgentMailboxPage = () => {
  const { agentId } = useParams<{ agentId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  // In the URL, not component state: a filtered mailbox is a place, so it
  // survives a reload and can be linked to.
  const [filter, setFilter] = useTabParam<MailboxFilter>(
    'mailboxFilter',
    ['all', 'inbox', 'sent'],
    'all',
  )

  const agentsQuery = useAgents()
  const layout = useNavigationLayout()
  const mailboxQuery = useAgentMailbox(agentId)
  const conversationsQuery = useMailboxConversations(agentId, filter)

  // Memoised so the empty-array fallback is not a fresh literal every render.
  const conversations = useMemo(
    () => conversationsQuery.data?.data ?? [],
    [conversationsQuery.data?.data],
  )
  const selectedId = searchParams.get('conversation') ?? conversations[0]?.id
  const messagesQuery = useMailboxConversation(agentId, selectedId)

  // Keep the URL honest about what is open, so a conversation is linkable.
  useEffect(() => {
    if (!selectedId || searchParams.get('conversation') === selectedId) return
    const next = new URLSearchParams(searchParams)
    next.set('conversation', selectedId)
    setSearchParams(next, { replace: true })
  }, [searchParams, selectedId, setSearchParams])

  const selected = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId),
    [conversations, selectedId],
  )

  const mailbox = mailboxQuery.data
  const agentName =
    agentsQuery.data?.find((agent) => agent.id === agentId)?.name ?? 'Agent'

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader
        subtitle={
          mailbox
            ? `${mailbox.address}${
              mailbox.sendPolicy === 'approval'
                ? ' · replies need approval'
                : mailbox.sendPolicy === 'auto_reply'
                  ? ' · replies send automatically'
                  : ' · sends automatically'
            }`
            : 'No address yet'
        }
        title={`${agentName} — Mailbox`}
      />

      {mailboxQuery.isSuccess && !mailbox ? (
        <p className="px-6 py-8 text-center text-sm text-[color:var(--tx3)]">
          This agent has no address. An organisation owner can give it one from the agent’s
          Email section.
        </p>
      ) : (
        <MailboxWorkspace
          layout={layout}
          conversationList={(
            <aside className="flex min-h-0 flex-col gap-3 overflow-hidden" data-testid="mailbox-conversation-list">
              <TabBar
                ariaLabel="Filter conversations"
                fullWidth
                items={[
                  { label: 'All', value: 'all' },
                  { label: 'Inbox', value: 'inbox' },
                  { label: 'Sent', value: 'sent' },
                ]}
                onChange={(value) => setFilter(value)}
                role="radiogroup"
                size="sm"
                value={filter}
              />
              <QueryState
                emptyLabel="No conversations yet."
                errorLabel="Could not load this mailbox."
                isEmpty={conversations.length === 0}
                loadingLabel="Loading conversations…"
                query={conversationsQuery}
              >
                {() => (
                  <MailboxThreadList
                    onSelect={(conversationId) => {
                      const next = new URLSearchParams(searchParams)
                      next.set('conversation', conversationId)
                      setSearchParams(next, { replace: true })
                    }}
                    selectedId={selectedId}
                    threads={conversations}
                  />
                )}
              </QueryState>
            </aside>
          )}
          conversation={(
            <QueryState
              emptyLabel="Select a conversation to read it."
              errorLabel="Could not load this conversation."
              isEmpty={!selectedId || (messagesQuery.data?.length ?? 0) === 0}
              loadingLabel="Loading messages…"
              query={messagesQuery}
            >
              {() => <MailConversation messages={messagesQuery.data ?? []} thread={selected} />}
            </QueryState>
          )}
        />
      )}
    </div>
  )
}

export default AgentMailboxPage
