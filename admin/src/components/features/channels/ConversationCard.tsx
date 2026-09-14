import { Link } from 'react-router-dom'
import { readConversationRef } from '@nessie/schemas'

import { useConversation } from '../../../facades/threads/hooks'
import { RAIL_POLL_MS, WATCHING_POLL_MS } from '../../../facades/browser-cloud/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { Pill } from '../../primitives/Pill'
import { SkeletonBlock } from '../../primitives/Skeleton'
import { UnreadBadge } from '../../primitives/UnreadBadge'
import { AgentAvatar } from '../../shared/AgentAvatar'
import {
  conversationRoomLabel,
  formatConversationTime,
} from '../agents/conversations/conversation-presentation'
import {
  conversationBodyLine,
  conversationStatus,
} from '../agents/conversations/conversation-status'
import { ChatCardShell } from './ChatCardShell'

/**
 * A live doorway into another conversation, in this one.
 *
 * The `agentHandoffDoorway` pattern generalised: the message metadata carries
 * a pointer (`conversationRef`, server-written only, never from model text)
 * and the card renders whatever `GET /api/threads/:threadId/conversation` says
 * *right now*. It deliberately holds no state of its own — a status stored in
 * the metadata would be a snapshot that lies within a minute — and it resolves
 * nothing: pressing it goes to the conversation, which is where cancelling,
 * approving and replying already have their doors. That is what keeps it a
 * presentational doorway rather than an `AgentCard`.
 *
 * Several cards pointing at one thread share the query key, so a feed holding
 * five references polls once.
 *
 * Spec: docs/plans/2026-09-08-agent-conversations.md § "The conversation card".
 */
export const ConversationCard = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const doorway = readConversationRef(metadata)
  return doorway ? <ResolvedConversationCard threadId={doorway.threadId} /> : null
}

const ResolvedConversationCard = ({ threadId }: { threadId: string }) => {
  const { token } = useAuthSession()
  // The cadence follows the newest answer: watch a run closely, let a finished
  // conversation settle to the rail's slower beat.
  const conversation = useConversation(threadId, {
    // A thread this viewer cannot see stays that way until something outside
    // this card changes; asking every twenty seconds would learn nothing.
    refetchInterval: (record, error) =>
      isNotFound(error) ? false : record?.activeRun ? WATCHING_POLL_MS : RAIL_POLL_MS,
  })
  const record = conversation.data ?? null

  if (conversation.isPending) {
    return (
      <ChatCardShell testId="conversation-card">
        <div className="flex flex-col gap-2">
          <SkeletonBlock className="h-3 w-40" />
          <SkeletonBlock className="h-3 w-full" />
        </div>
      </ChatCardShell>
    )
  }

  // A conversation in a room this reader cannot see. The withheld idiom rather
  // than nothing: a silent gap reads as a bug, and the reader cannot tell
  // whether the message jumped or the product broke.
  if (!record) {
    const notVisible = isNotFound(conversation.error)
    return (
      <div
        className="mt-2 max-w-[42rem] rounded-md border border-dashed p-3 text-xs"
        data-testid="conversation-card"
        style={{
          borderColor: 'var(--border-muted)',
          background: 'var(--surface-muted)',
          color: 'var(--text-muted)',
        }}
      >
        {notVisible ? 'A conversation you can’t see.' : 'Couldn’t load this conversation'}
      </div>
    )
  }

  const status = conversationStatus(record)
  const age = formatConversationTime(record.lastActivityAt)

  return (
    <ChatCardShell testId="conversation-card">
      <Link
        className="flex flex-col gap-2 no-underline"
        to={`/channels/${encodeURIComponent(record.channel.id)}/threads/${encodeURIComponent(record.id)}`}
      >
        <span className="flex items-center gap-2">
          <AgentAvatar agentId={record.agentId} size="xs" token={token} />
          <span className="min-w-0 flex-1 truncate font-semibold text-[color:var(--tx)]">
            {record.title}
          </span>
          <Pill tone={status.tone} uppercase={false}>
            <span className="flex items-center gap-1">
              {status.dot ? (
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    background: status.dot === 'success' ? 'var(--success)' : 'var(--tx3)',
                  }}
                />
              ) : null}
              {status.label}
            </span>
          </Pill>
        </span>
        <span className="block truncate text-[color:var(--tx2)]">
          {conversationBodyLine(record)}
        </span>
        <span className="flex items-center gap-2 text-[color:var(--tx3)]">
          <span className="min-w-0 truncate">{conversationRoomLabel(record.channel)}</span>
          {age ? <span aria-hidden="true">·</span> : null}
          {age ? <span>{age}</span> : null}
          <UnreadBadge value={record.unreadCount} />
          <span className="ml-auto flex-shrink-0 font-semibold text-[color:var(--accent)]">
            Open →
          </span>
        </span>
      </Link>
    </ChatCardShell>
  )
}

/**
 * A 404 is the honest answer for a conversation this reader is not privy to —
 * the same words every other thread read uses, so an id confirms nothing. Any
 * other failure is a failure, and says so instead of claiming a permission
 * boundary that may not exist.
 */
const isNotFound = (error: unknown): boolean =>
  error instanceof Error && /THREAD_NOT_FOUND|not found|404/i.test(error.message)
