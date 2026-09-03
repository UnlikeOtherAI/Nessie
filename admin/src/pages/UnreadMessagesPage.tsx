import { useNavigate } from 'react-router-dom'

import { EmptyState } from '../components/shared/EmptyState'
import { PageBody } from '../components/shared/PageBody'
import { QueryState } from '../components/shared/QueryState'
import { Row, RowList } from '../components/shared/RowList'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { Pill } from '../components/primitives/Pill'
import { formatRelativeTime } from '../components/features/workflows/presentation'
import { useUnreadDirectMessages } from '../facades/threads/unread-direct-messages'

const previewFor = (item: {
  latestMessage: { content: string; deleted?: true; restricted?: true }
}): string => {
  if (item.latestMessage.restricted) return 'A message you cannot read'
  if (item.latestMessage.deleted) return 'Message deleted'
  return item.latestMessage.content || 'New message'
}

const MessageIcon = () => (
  <span
    aria-hidden="true"
    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-soft)] text-[color:var(--accent)]"
  >
    <svg fill="none" height="20" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" width="20">
      <path d="M5 18.5 3.5 21l3.2-.9A8.5 8.5 0 1 0 5 18.5Z" />
      <path d="M8 12h.01M12 12h.01M16 12h.01" strokeLinecap="round" strokeWidth="2.5" />
    </svg>
  </span>
)

export const UnreadMessagesPage = () => {
  const navigate = useNavigate()
  const unreadMessages = useUnreadDirectMessages()
  const items = unreadMessages.data ?? []

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ScreenHeader title="Unread messages" />
      <PageBody>
        <QueryState
          errorLabel="Unread messages could not be loaded."
          loadingLabel="Loading unread messages…"
          query={unreadMessages}
        >
          {() => (
            items.length === 0 ? (
              <EmptyState title="You are all caught up">
                Nothing here needs your attention right now.
              </EmptyState>
            ) : (
              <RowList label="Unread messages">
                {items.map((item) => (
                  <Row
                    key={item.channelId}
                    leading={<MessageIcon />}
                    onClick={() => void navigate(`/channels/${item.channelId}`)}
                    subtitle={previewFor(item)}
                    title={item.channelLabel}
                    trailing={
                      <span className="flex flex-col items-end gap-1">
                        <span className="text-xs text-[color:var(--tx3)]">
                          {formatRelativeTime(item.latestMessage.createdAt) ?? 'now'}
                        </span>
                        <Pill height="control" radius="capsule" size="sm" tone="accent">
                          {item.unreadCount}
                        </Pill>
                      </span>
                    }
                  />
                ))}
              </RowList>
            )
          )}
        </QueryState>
      </PageBody>
    </section>
  )
}
