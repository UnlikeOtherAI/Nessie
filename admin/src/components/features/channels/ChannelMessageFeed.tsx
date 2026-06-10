import type { ReactNode } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import { memberGradients } from '../../../lib/avatar'
import { MessageAttachments } from '../../shared/MessageAttachments'
import {
  formatClock,
  getAgentGlyph,
  getDisplayName,
  toolbarButtonClass,
  type FeedItem,
  type OptimisticMessage,
} from './channel-helpers'

interface PendingStreamMessage {
  agentId: string
  content: string
  reasoningContent: string
  runId: string
}

interface ChannelMessageFeedProps {
  feedItems: FeedItem[]
  optimisticMessages: OptimisticMessage[]
  pendingMessages: PendingStreamMessage[]
  agentMap: Map<string, AgentRecord>
  agentById: Map<string, AgentRecord>
  meDisplayName: string
  meUserId: string
  isPersonalAssistantConversation: boolean
  renderContent: (text: string) => ReactNode
  editingMessageId: string | null
  editingContent: string
  updatePending: boolean
  onStartEdit: (messageId: string, content: string) => void
  onChangeEditingContent: (value: string) => void
  onSubmitEdit: (messageId: string) => void
  onCancelEdit: () => void
  onConfirmDelete: (messageId: string) => void
}

export const ChannelMessageFeed = ({
  feedItems,
  optimisticMessages,
  pendingMessages,
  agentMap,
  agentById,
  meDisplayName,
  meUserId,
  isPersonalAssistantConversation,
  renderContent,
  editingMessageId,
  editingContent,
  updatePending,
  onStartEdit,
  onChangeEditingContent,
  onSubmitEdit,
  onCancelEdit,
  onConfirmDelete,
}: ChannelMessageFeedProps) => (
  <>
    {feedItems.length === 0 &&
    pendingMessages.length === 0 &&
    optimisticMessages.length === 0 ? (
      <div className="p-5">
        <div className="admin-card p-4 text-sm text-[color:var(--tx3)]">
          No messages yet. Send the first message to start this thread.
        </div>
      </div>
    ) : null}

    {feedItems.map((item, index) =>
      item.kind === 'date' ? (
        <div key={`${item.label}:${index}`} className="admin-date-sep">
          <span className="admin-date-pill">
            {item.label}
            <svg
              className="h-3 w-3 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path
                d="M19 9l-7 7-7-7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>
      ) : (
        <article
          key={item.message.id}
          id={`msg-${item.message.id}`}
          className="admin-msg-row group relative py-1"
        >
          {item.message.role === 'assistant' ? (
            <div
              className={[
                'flex h-9 w-9 flex-shrink-0 items-center justify-center',
                'rounded-lg border border-[var(--accent)]',
                'bg-[var(--accent-soft)] text-lg',
              ].join(' ')}
            >
              {getAgentGlyph(agentMap.get(item.message.agentId ?? ''))}
            </div>
          ) : (
            <div
              className="h-9 w-9 flex-shrink-0 rounded-md"
              style={{ background: memberGradients[0] }}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-bold text-[var(--tx)]">
                {getDisplayName(
                  item.message,
                  meDisplayName,
                  agentMap,
                  isPersonalAssistantConversation ? 'Personal Assistant' : 'Agent',
                )}
              </span>
              {item.message.role === 'assistant' && !isPersonalAssistantConversation ? (
                <span
                  className={[
                    'inline-flex items-center gap-1 rounded',
                    'border border-[var(--accent)]',
                    'bg-[var(--accent-soft)] px-1.5 py-0.5',
                    'text-[11px] font-semibold text-[var(--thinking)]',
                  ].join(' ')}
                >
                  agent
                </span>
              ) : null}
              <span className="text-xs text-[color:var(--tx3)]">
                {formatClock(item.message.createdAt)}
              </span>
              {item.message.editedAt && !item.message.deletedAt ? (
                <span className="text-xs italic text-[color:var(--tx3)]">
                  (edited)
                </span>
              ) : null}
            </div>
            <div
              className={
                item.message.role === 'assistant'
                  ? 'mt-0.5 border-l-2 border-[var(--accent)] pl-3'
                  : 'mt-0.5'
              }
            >
              {item.message.deletedAt ? (
                <p className="text-sm italic leading-6 text-[color:var(--tx3)]">
                  This message was deleted
                </p>
              ) : editingMessageId === item.message.id ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    autoFocus
                    className="admin-input w-full resize-y text-sm"
                    onChange={(event) => onChangeEditingContent(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        onSubmitEdit(item.message.id)
                      }
                      if (event.key === 'Escape') {
                        onCancelEdit()
                      }
                    }}
                    rows={2}
                    value={editingContent}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      className="admin-button admin-button-primary"
                      disabled={updatePending}
                      onClick={() => onSubmitEdit(item.message.id)}
                      type="button"
                    >
                      Save
                    </button>
                    <button
                      className="admin-button admin-button-secondary"
                      onClick={onCancelEdit}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx)]">
                  {renderContent(item.message.content)}
                </p>
              )}
              {!item.message.deletedAt && (
                <MessageAttachments messageId={item.message.id} />
              )}
              {item.message.reactions?.length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.entries(
                    item.message.reactions.reduce<Record<string, number>>((acc, r) => {
                      acc[r.emoji] = (acc[r.emoji] ?? 0) + 1
                      return acc
                    }, {}),
                  ).map(([emoji, count]) => (
                    <span key={emoji} className="reaction-pill">
                      {emoji}{count > 1 ? ` ${count}` : ''}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          {item.message.role === 'user' &&
          item.message.userId === meUserId &&
          !item.message.deletedAt &&
          editingMessageId !== item.message.id ? (
            <div className="absolute right-3 top-1 hidden items-center gap-1 group-hover:flex">
              <button
                className={toolbarButtonClass}
                onClick={() => onStartEdit(item.message.id, item.message.content)}
                title="Edit message"
                type="button"
              >
                Edit
              </button>
              <button
                className={toolbarButtonClass}
                onClick={() => onConfirmDelete(item.message.id)}
                title="Delete message"
                type="button"
              >
                Delete
              </button>
            </div>
          ) : null}
        </article>
      ),
    )}

    {optimisticMessages.map((entry) => (
      <article
        key={entry.clientId}
        className="admin-msg-row py-1"
        data-testid="optimistic-message"
      >
        <div
          className="h-9 w-9 flex-shrink-0 rounded-md"
          style={{ background: memberGradients[0] }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-bold text-[var(--tx)]">
              {meDisplayName}
            </span>
            {entry.status === 'failed' ? (
              <span
                className={[
                  'inline-flex items-center rounded px-1.5 py-0.5',
                  'bg-[var(--danger-soft)] text-[11px] font-semibold text-[var(--danger-text)]',
                ].join(' ')}
              >
                failed
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 text-xs text-[color:var(--tx3)]"
                title="Sending…"
              >
                sending
                <span className="streaming-dot" />
              </span>
            )}
          </div>
          <div className="mt-0.5">
            <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx)]">
              {renderContent(entry.content)}
            </p>
          </div>
        </div>
      </article>
    ))}

    {pendingMessages.length > 0 ? (
      <div className="admin-date-sep">
        <span className="admin-date-pill">
          Live
          <svg
            className="h-3 w-3 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            viewBox="0 0 24 24"
          >
            <path
              d="M19 9l-7 7-7-7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </div>
    ) : null}

    {pendingMessages.map((entry) => {
      const pendingAgent = agentById.get(entry.agentId) ?? null
      const pendingDisplayName = isPersonalAssistantConversation
        ? 'Personal Assistant'
        : pendingAgent?.name ?? 'Agent'

      return (
        <article key={entry.runId} className="admin-msg-row py-1">
          <div
            className={[
              'flex h-9 w-9 flex-shrink-0 items-center justify-center',
              'rounded-lg border border-[var(--accent)]',
              'bg-[var(--accent-soft)] text-lg',
            ].join(' ')}
          >
            {getAgentGlyph(pendingAgent)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-bold text-[var(--tx)]">
                {pendingDisplayName}
              </span>
              <span
                className={[
                  'inline-flex items-center rounded',
                  'bg-[var(--accent-soft)] px-2 py-0.5',
                  'text-[11px] font-semibold text-[var(--thinking)]',
                ].join(' ')}
              >
                {isPersonalAssistantConversation ? 'responding' : 'running'}
              </span>
            </div>
            <div className="mt-0.5 border-l-2 border-[var(--accent)] pl-3">
              <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx)]">
                {entry.content ? renderContent(entry.content) : 'Streaming response'}
                <span className="streaming-dot" />
              </p>
            </div>
          </div>
        </article>
      )
    })}
    <div className="h-3" />
  </>
)
