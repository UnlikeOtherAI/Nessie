import { useNavigate } from 'react-router-dom'
import { AdminPageHeader } from '../components/shared/AdminPageHeader'
import { useThreadActivity, useThreadActivityEvents } from '../facades/threads/activity-hooks'

const preview = (content: string): string => content.replace(/\s+/g, ' ').trim() || 'Message removed'
const author = (message: { author?: { displayName: string }; agentId?: string }): string =>
  message.author?.displayName ?? (message.agentId ? 'Agent' : 'Unknown sender')

export const ThreadsPage = () => {
  const navigate = useNavigate()
  const activity = useThreadActivity()
  useThreadActivityEvents()
  const items = activity.data?.items ?? []

  return (
    <section className="flex h-full min-h-0 flex-col">
      <AdminPageHeader title="Threads" />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {activity.isLoading ? <div className="py-8 text-center text-[color:var(--tx3)]">Loading threads…</div> : null}
        {activity.isError ? <div className="py-8 text-center text-[color:var(--danger-text)]">Threads could not be loaded. Try again.</div> : null}
        {!activity.isLoading && !activity.isError && items.length === 0 ? (
          <div className="py-8 text-center text-[color:var(--tx3)]">No thread activity yet</div>
        ) : null}
        <div className="grid gap-2">
          {items.map((item) => (
            <button
              className={[
                'admin-card w-full p-4 text-left transition-colors hover:bg-[color:var(--surface-hover)]',
                item.unread ? 'border-l-4 border-l-[color:var(--accent)]' : '',
              ].join(' ')}
              key={item.rootMessageId}
              onClick={() => navigate(`/channels/${item.channelId}/threads/${item.threadId}/replies/${item.rootMessageId}`)}
              type="button"
            >
              <div className="mb-1 text-sm text-[color:var(--tx3)]"># {item.channelLabel}</div>
              <div className={item.unread ? 'font-semibold text-[color:var(--tx)]' : 'text-[color:var(--tx)]'}>
                {author(item.root)} · {preview(item.root.content)}
              </div>
              <div className="mt-2 flex items-center gap-2 text-sm text-[color:var(--tx2)]">
                <span>{item.replyCount} {item.replyCount === 1 ? 'reply' : 'replies'}</span>
                <span>Latest: {author(item.latestReply)} · {preview(item.latestReply.content)}</span>
                {item.unread ? <span className="font-semibold text-[color:var(--accent)]">New</span> : null}
              </div>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
