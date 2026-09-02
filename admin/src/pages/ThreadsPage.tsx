import { useNavigate } from 'react-router-dom'
import { useIsOwner } from '../components/shared/OwnerGate'
import type { PageHeaderAction } from '../components/shared/ResponsivePageHeader'
import { useAgents } from '../facades/agents/hooks'
import { useChannels } from '../facades/channels/hooks'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { useThreadActivity } from '../facades/threads/activity-hooks'
import { useUsers } from '../facades/users/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { ThreadInboxCard } from './channels/ThreadInboxCard'
import { useThreadInboxUnreadOnly } from './thread-inbox-filter'

export const ThreadsPage = () => {
  const navigate = useNavigate()
  const { me, token } = useAuthSession()
  const { toggleUnreadOnly, unreadOnly } = useThreadInboxUnreadOnly()
  const activity = useThreadActivity({ unreadOnly })
  const { data: agents = [] } = useAgents()
  const { data: channels = [] } = useChannels()
  const isOwner = useIsOwner()
  const { data: users = [] } = useUsers(isOwner)
  const items = activity.data?.items ?? []
  const headerActions: PageHeaderAction[] = [{
    id: 'unread-only',
    label: 'Unread only',
    onSelect: toggleUnreadOnly,
    pressed: unreadOnly,
    priority: 80,
    selected: unreadOnly,
    title: unreadOnly ? 'Show all threads' : 'Show only unread threads',
  }]

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ScreenHeader actions={headerActions} title="Threads" />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {activity.isLoading ? <div className="py-8 text-center text-[color:var(--tx3)]">Loading threads…</div> : null}
        {activity.isError ? <div className="py-8 text-center text-[color:var(--danger-text)]">Threads could not be loaded. Try again.</div> : null}
        {!activity.isLoading && !activity.isError && items.length === 0 ? (
          <div className="py-8 text-center text-[color:var(--tx3)]">
            {unreadOnly ? 'No unread threads' : 'No thread activity yet'}
          </div>
        ) : null}
        <div className="grid gap-5">
          {me ? items.map((item) => (
            <ThreadInboxCard
              activity={item}
              agents={agents}
              channels={channels}
              currentUser={me.user}
              key={item.rootMessageId}
              token={token}
              users={users}
              onOpen={() => navigate(`/channels/${item.channelId}/threads/${item.threadId}/replies/${item.rootMessageId}`)}
            />
          )) : null}
        </div>
        {activity.hasNextPage ? (
          <div className="flex justify-center py-5">
            <button
              className="admin-button-secondary"
              disabled={activity.isFetchingNextPage}
              onClick={() => void activity.fetchNextPage()}
              type="button"
            >
              {activity.isFetchingNextPage ? 'Loading threads…' : 'Load more threads'}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
