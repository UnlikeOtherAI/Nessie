import { useNavigate } from 'react-router-dom'
import { useIsOwner } from '../components/shared/OwnerGate'
import { useAgents } from '../facades/agents/hooks'
import { useChannels } from '../facades/channels/hooks'
import { AdminPageHeader } from '../components/shared/AdminPageHeader'
import { useThreadActivity } from '../facades/threads/activity-hooks'
import { useUsers } from '../facades/users/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { ThreadInboxCard } from './channels/ThreadInboxCard'

export const ThreadsPage = () => {
  const navigate = useNavigate()
  const { me, token } = useAuthSession()
  const activity = useThreadActivity()
  const { data: agents = [] } = useAgents()
  const { data: channels = [] } = useChannels()
  const isOwner = useIsOwner()
  const { data: users = [] } = useUsers(isOwner)
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
