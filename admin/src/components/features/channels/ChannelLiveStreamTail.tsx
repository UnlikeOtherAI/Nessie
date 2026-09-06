import { Fragment, useMemo, type ReactNode } from 'react'
import type { AgentIdentity } from '../../shared/agent-identity'
import type { PendingStreamMessage } from '../../../facades/threads/thinking'
import { StreamingMessageRow } from './ChannelTransientMessageRows'
import { ThinkingBubble } from './ThinkingBubble'

type ChannelLiveStreamTailProps = {
  isDedicatedAgentConversation: boolean
  onOpenThoughtProcess: (runId: string) => void
  pendingMessages: PendingStreamMessage[]
  renderContent: (text: string) => ReactNode
  resolveAgentIdentity: (agentId: string) => { agent: AgentIdentity | null; name: string }
  // Thread-anchored runs render under the message their reply will hang from
  // (`ChannelMessageFeed`'s own `pendingByRoot`); only the channel feed filters
  // those out here — a reply panel is already scoped to one root, so it owns
  // every run it is handed.
  thinkingSurface: 'channel' | 'thread'
  token: string | null
}

// The "Live" section at the bottom of the feed: in-flight runs that belong at
// the tail of this surface rather than anchored under one root message.
export const ChannelLiveStreamTail = ({
  isDedicatedAgentConversation,
  onOpenThoughtProcess,
  pendingMessages,
  renderContent,
  resolveAgentIdentity,
  thinkingSurface,
  token,
}: ChannelLiveStreamTailProps) => {
  const bottomPendingEntries = useMemo(
    () =>
      thinkingSurface === 'thread'
        ? pendingMessages
        : pendingMessages.filter((entry) => entry.rootMessageId == null),
    [pendingMessages, thinkingSurface],
  )

  if (bottomPendingEntries.length === 0) return null

  return (
    <>
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
            <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>

      {bottomPendingEntries.map((entry) => {
        const { agent: pendingAgent, name: pendingDisplayName } = resolveAgentIdentity(
          entry.agentId,
        )
        // A bubble directly above already says the agent is thinking, so the
        // streaming row waits for actual reply text instead of repeating it.
        const showStreamingRow = entry.content.length > 0

        return (
          <Fragment key={entry.runId}>
            <ThinkingBubble
              agent={pendingAgent}
              agentName={pendingDisplayName}
              entry={entry}
              token={token}
              variant="full"
              onOpen={onOpenThoughtProcess}
            />
            {showStreamingRow ? (
              <StreamingMessageRow
                agent={pendingAgent}
                displayName={pendingDisplayName}
                entry={entry}
                isDedicatedAgentConversation={isDedicatedAgentConversation}
                renderContent={renderContent}
                token={token}
              />
            ) : null}
          </Fragment>
        )
      })}
    </>
  )
}
