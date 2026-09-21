import { Link } from 'react-router-dom'
import type { ExecutorAccessViewWithLocalMcp } from '../../../facades/executors/local-mcp'
import { DataTable } from '../../shared/DataTable'

const activityNames: Record<string, string> = {
  workspace_sandbox: 'Workspace session',
  connected_browser: 'Connected browser', coding_session: 'Coding session',
}
const activityStates: Record<string, string> = {
  pending: 'Starting', active: 'Running', attention: 'Needs review',
  detached: 'Disconnected', stopped: 'Finished', failed: 'Failed',
}

export const ExecutorActivityPanel = ({ sessions }: {
  sessions: NonNullable<ExecutorAccessViewWithLocalMcp['sessions']>
}) => (
  <div className="grid gap-3">
  {sessions.length === 20 ? <p className="text-sm text-[color:var(--tx3)]">Showing the 20 most recent sessions.</p> : null}
  <DataTable
    columns={[
      { key: 'work', header: 'Work', render: (row) => <div className="grid gap-1">
        <span>{activityNames[row.profile] ?? row.profile}</span>
        <span className="text-xs text-[color:var(--tx3)] sm:hidden">{activityStates[row.status] ?? row.status}</span>
        <time className="text-xs text-[color:var(--tx3)] sm:hidden" dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time>
      </div> },
      { key: 'status', header: 'Status', secondary: true, render: (row) => activityStates[row.status] ?? row.status },
      { key: 'created', header: 'Started', secondary: true, render: (row) => <time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time> },
      { key: 'conversation', header: '', width: '1px', render: (row) => row.originChannelId ? (
        <Link aria-label="Open conversation" className="admin-button admin-button-secondary" to={`/channels/${row.originChannelId}`}>
          <span className="sm:hidden">Open</span><span className="hidden sm:inline">Open conversation</span>
        </Link>
      ) : null },
    ]}
    empty={<p className="py-6 text-center text-sm text-[color:var(--tx3)]">No activity yet.</p>}
    expandable={false}
    label="Recent activity (up to 20 sessions)"
    rowKey={(row) => row.id}
    rows={sessions}
  />
  </div>
)
