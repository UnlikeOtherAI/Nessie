import { Link } from 'react-router-dom'
import { useExecutorHostSessions } from '../../../facades/executors/session-sharing'
import { QueryState } from '../../shared/QueryState'

/** The same entitled list in Executors → Sessions and one machine's Sessions tab. */
export const ExecutorHostSessionList = ({ executorId }: { executorId?: string }) => {
  const query = useExecutorHostSessions(executorId)
  return <QueryState query={query} loadingLabel="Loading sessions…" errorLabel="Could not load sessions.">
    {() => query.data?.length ? <ul className="grid divide-y divide-[color:var(--sep)]" aria-label="Executor sessions">
      {query.data.map((session) => <li key={session.executorId + session.sessionId}>
        <Link className="flex items-center justify-between gap-3 py-3"
          to={`/admin/computers/${session.executorId}/sessions/${session.sessionId}`}>
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
}
