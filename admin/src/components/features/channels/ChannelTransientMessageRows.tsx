import type { ReactNode } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import type { PendingStreamMessage } from '../../../facades/threads/thinking'
import type { PresenceView } from '../../../providers/PresenceProvider'
import { UserAvatar, type AvatarSources } from '../../primitives/UserAvatar'
import type { OptimisticMessage } from './channel-helpers'
import { ChannelAgentGlyph } from './ChannelAgentGlyph'
import { StatusBadge } from './ChannelMessageRow'
import { MessageMarkdown } from './MessageMarkdown'

type OptimisticMessageRowProps = {
  entry: OptimisticMessage
  getPresence: (userId: string | null | undefined) => PresenceView | null
  meAvatar: AvatarSources
  meDisplayName: string
  meUserId: string
  renderContent: (text: string) => ReactNode
  token: string | null
}

export const OptimisticMessageRow = ({
  entry,
  getPresence,
  meAvatar,
  meDisplayName,
  meUserId,
  renderContent,
  token,
}: OptimisticMessageRowProps) => (
  <article className="admin-msg-row relative py-1" data-testid="optimistic-message">
    <UserAvatar
      avatarAttachmentId={meAvatar.avatarAttachmentId}
      avatarUrl={meAvatar.avatarUrl}
      displayName={meDisplayName}
      size={36}
      token={token}
      userId={meUserId}
    />
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-bold text-[var(--tx)]">{meDisplayName}</span>
        <StatusBadge presence={getPresence(meUserId)} />
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
        <MessageMarkdown renderInlineText={renderContent}>{entry.content}</MessageMarkdown>
      </div>
    </div>
  </article>
)

type StreamingMessageRowProps = {
  agent: AgentRecord | null
  displayName: string
  entry: PendingStreamMessage
  isDedicatedAgentConversation: boolean
  renderContent: (text: string) => ReactNode
  token: string | null
}

export const StreamingMessageRow = ({
  agent,
  displayName,
  entry,
  isDedicatedAgentConversation,
  renderContent,
  token,
}: StreamingMessageRowProps) => (
  <article className="admin-msg-row relative py-1">
    <ChannelAgentGlyph agent={agent} token={token} />
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-bold text-[var(--tx)]">{displayName}</span>
        <span
          className={[
            'inline-flex items-center rounded',
            'bg-[var(--accent-soft)] px-2 py-0.5',
            'text-[11px] font-semibold text-[var(--thinking)]',
          ].join(' ')}
        >
          {isDedicatedAgentConversation ? 'thinking' : 'running'}
        </span>
      </div>
      <div className="mt-0.5 border-l-2 border-[var(--accent)] pl-3">
        <MessageMarkdown renderInlineText={renderContent}>
          {entry.content
            ? entry.content
            : isDedicatedAgentConversation
              ? `${displayName} is thinking…`
              : '... thinking ...'}
        </MessageMarkdown>
        <span className="streaming-dot" />
      </div>
    </div>
  </article>
)
