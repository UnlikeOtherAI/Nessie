import { useNavigate } from 'react-router-dom'

import { AdminPageHeader } from '../components/shared/AdminPageHeader'
import { formatRelativeTime } from '../components/features/workflows/presentation'
import { useUnreadDirectMessages } from '../facades/threads/unread-direct-messages'

const previewFor = (item: {
  latestMessage: { content: string; deleted?: true; restricted?: true }
}): string => {
  if (item.latestMessage.restricted) return 'A message you cannot read'
  if (item.latestMessage.deleted) return 'Message deleted'
  return item.latestMessage.content || 'New message'
}

export const UnreadMessagesPage = () => {
  const navigate = useNavigate()
  const unreadMessages = useUnreadDirectMessages()
  const items = unreadMessages.data ?? []

  return (
    <section className="flex h-full min-h-0 flex-col">
      <AdminPageHeader title="Unread messages" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {unreadMessages.isLoading ? (
          <div className="py-8 text-center text-[color:var(--tx3)]">Loading unread messages…</div>
        ) : null}
        {unreadMessages.isError ? (
          <div className="py-8 text-center text-[color:var(--danger-text)]">
            Unread messages could not be loaded. Try again.
          </div>
        ) : null}
        {!unreadMessages.isLoading && !unreadMessages.isError && items.length === 0 ? (
          <div className="flex min-h-full items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-lg border border-dashed border-[color:var(--sep)] bg-[color:var(--panel)] px-5 py-4 text-center font-semibold text-[color:var(--tx2)]">
              You are all caught up
            </div>
          </div>
        ) : null}
        <div className="divide-y divide-[color:var(--sep)]">
          {items.map((item) => (
            <button
              className="flex w-full items-start gap-3 px-5 py-4 text-left outline-none transition-colors hover:bg-[color:var(--surface-hover)] focus-visible:bg-[color:var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
              key={item.channelId}
              onClick={() => void navigate(`/channels/${item.channelId}`)}
              type="button"
            >
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-soft)] text-[color:var(--accent)]"
              >
                <svg fill="none" height="20" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" width="20">
                  <path d="M5 18.5 3.5 21l3.2-.9A8.5 8.5 0 1 0 5 18.5Z" />
                  <path d="M8 12h.01M12 12h.01M16 12h.01" strokeLinecap="round" strokeWidth="2.5" />
                </svg>
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate font-semibold text-[color:var(--tx)]">
                    {item.channelLabel}
                  </span>
                  <span className="shrink-0 text-xs text-[color:var(--tx3)]">
                    {formatRelativeTime(item.latestMessage.createdAt) ?? 'now'}
                  </span>
                </span>
                <span className="mt-1 block truncate text-sm text-[color:var(--tx2)]">
                  {previewFor(item)}
                </span>
              </span>
              <span className="mt-1 rounded-full bg-[color:var(--accent)] px-2 py-0.5 text-xs font-semibold text-[color:var(--on-accent)]">
                {item.unreadCount}
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
