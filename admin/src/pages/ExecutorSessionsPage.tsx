import { Link, useNavigate } from 'react-router-dom'

import { useExecutorHostSessions } from '../facades/executors/session-sharing'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { QueryState } from '../components/shared/QueryState'

export const ExecutorSessionsPage = () => {
  const query = useExecutorHostSessions()
  const navigate = useNavigate()
  return <div className="flex h-full min-h-0 flex-col">
    <ScreenHeader title="Sessions" eyebrow="Executors" backLabel="Back to executors"
      onBack={() => void navigate('/agents/executors')} subtitle="Your sessions and sessions shared with you" />
    <div className="overflow-y-auto px-[var(--page-gutter)] py-4">
      <QueryState query={query} loadingLabel="Loading sessions…" errorLabel="Could not load sessions.">
        {() => query.data?.length ? <ul className="grid divide-y divide-[color:var(--sep)]" aria-label="Executor sessions">
          {query.data.map((session) => <li key={session.executorId + session.sessionId}>
            <Link className="flex items-center justify-between gap-3 py-3"
              to={`/agents/executors/${session.executorId}/sessions/${session.sessionId}`}>
              <span><span className="font-medium">{session.title}</span>
                <span className="block text-sm text-[color:var(--tx3)]">
                  {session.executorLabel} · {session.agent} · {session.shared ? 'Shared with you' : 'Yours'}
                </span>
              </span>
              <span className="text-sm text-[color:var(--tx2)]">{session.status.replaceAll('_', ' ')}</span>
            </Link>
          </li>)}
        </ul> : <p className="text-sm text-[color:var(--tx2)]">No sessions yet. Ask an agent with executor access to start one.</p>}
      </QueryState>
    </div>
  </div>
}
