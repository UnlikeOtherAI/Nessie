import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import type { EmailMessageRecord } from '@nessie/schemas'

import { ScreenHeader } from '../components/shared/ScreenHeader'
import { QueryState } from '../components/shared/QueryState'
import { TabBar } from '../components/primitives/TabBar'
import {
  useAgentMailbox,
  useMailboxConversation,
  useMailboxConversations,
} from '../facades/agent-mailbox/hooks'
import { useAgents } from '../facades/agents/queries'
import { EmailMessageBody } from '../components/features/mailbox/EmailMessageBody'

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
  const [filter, setFilter] = useState<MailboxFilter>('all')

  const agentsQuery = useAgents()
  const mailboxQuery = useAgentMailbox(agentId)
  const conversationsQuery = useMailboxConversations(agentId, filter)

  const conversations = conversationsQuery.data?.data ?? []
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
        <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
          <aside
            className="flex w-[22rem] shrink-0 flex-col gap-3 overflow-hidden"
            data-testid="mailbox-conversation-list"
          >
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
              <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                {conversations.map((conversation) => {
                  const isSelected = conversation.id === selectedId
                  return (
                    <li key={conversation.id}>
                      <button
                        className={[
                          'w-full border-b border-[var(--border)] px-3 py-3 text-left',
                          isSelected ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-2)]',
                        ].join(' ')}
                        onClick={() => {
                          const next = new URLSearchParams(searchParams)
                          next.set('conversation', conversation.id)
                          setSearchParams(next)
                        }}
                        type="button"
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-[color:var(--tx1)]">
                            {conversation.subject}
                          </span>
                          <span className="shrink-0 text-xs text-[color:var(--tx3)]">
                            {new Date(conversation.lastMessageAt).toLocaleDateString()}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-[color:var(--tx3)]">
                          {conversation.participants.join(', ')}
                        </span>
                        <span className="mt-1 block truncate text-xs text-[color:var(--tx2)]">
                          {conversation.snippet}
                        </span>
                        {(conversation.awaitingApproval || conversation.hasBounce) && (
                          <span className="mt-1.5 flex gap-1.5">
                            {conversation.awaitingApproval && (
                              <span className="rounded-full bg-[var(--warning-bg)] px-2 py-0.5 text-[11px] text-[color:var(--warning-text)]">
                                Awaiting approval
                              </span>
                            )}
                            {conversation.hasBounce && (
                              <span className="rounded-full bg-[var(--danger-bg)] px-2 py-0.5 text-[11px] text-[color:var(--danger-text)]">
                                Delivery problem
                              </span>
                            )}
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
              )}
            </QueryState>
          </aside>

          <section
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
            data-testid="mailbox-reading-pane"
          >
            {selected && (
              <h2 className="mb-3 text-lg font-semibold text-[color:var(--tx1)]">
                {selected.subject}
              </h2>
            )}
            <QueryState
              emptyLabel="Select a conversation to read it."
              errorLabel="Could not load this conversation."
              isEmpty={!selectedId || (messagesQuery.data?.length ?? 0) === 0}
              loadingLabel="Loading messages…"
              query={messagesQuery}
            >
              {() => (
                <ol className="flex flex-col gap-4">
                  {(messagesQuery.data ?? []).map((message) => (
                    <EmailMessageItem key={message.id} message={message} />
                  ))}
                </ol>
              )}
            </QueryState>
          </section>
        </div>
      )}
    </div>
  )
}

const EmailMessageItem = ({ message }: { message: EmailMessageRecord }) => (
  <li className="border-b border-[var(--border)] pb-4 last:border-b-0">
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span className="font-medium text-[color:var(--tx1)]">
        {message.direction === 'inbound'
          ? message.fromName ?? message.fromAddress
          : `You (${message.fromAddress})`}
      </span>
      <span className="text-xs text-[color:var(--tx3)]">to {message.toAddresses.join(', ')}</span>
      <span className="ml-auto text-xs text-[color:var(--tx3)]">
        {new Date(message.occurredAt).toLocaleString()}
      </span>
    </div>
    {message.deliveryState && message.deliveryState !== 'sent' && (
      <p className="mb-2 text-xs text-[color:var(--warning-text)]">
        {deliveryLabel(message.deliveryState)}
      </p>
    )}
    <EmailMessageBody message={message} />
    {message.attachments.length > 0 && (
      <ul className="mt-2 flex flex-wrap gap-2">
        {message.attachments.map((attachment) => (
          <li
            className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[color:var(--tx2)]"
            key={attachment.id}
          >
            {attachment.filename}
          </li>
        ))}
      </ul>
    )}
  </li>
)

const deliveryLabel = (state: NonNullable<EmailMessageRecord['deliveryState']>): string => {
  switch (state) {
    case 'queued':
      return 'Queued to send.'
    case 'sending':
      return 'Sending…'
    case 'bounced':
      return 'This message bounced. The recipient will not receive it.'
    case 'complained':
      return 'The recipient reported this message as spam.'
    case 'delivery_unknown':
      // Deliberately not retried: a retry would be a duplicate email.
      return 'Delivery is unconfirmed — it may or may not have been sent. It was not retried.'
    default:
      return ''
  }
}

export default AgentMailboxPage
