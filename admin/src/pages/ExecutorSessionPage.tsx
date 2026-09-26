import { useNavigate, useParams } from 'react-router-dom'
import { useState } from 'react'

import { ExecutorTerminalScreen } from '../components/features/executors/ExecutorTerminalScreen'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { QueryState } from '../components/shared/QueryState'
import { COMPUTER_SESSIONS_PATH } from '../navigation/computers'
import { useExecutorSessionView } from '../facades/executors/coding-sessions'
import { ExecutorSessionSharing } from '../components/features/executors/ExecutorSessionSharing'

export const ExecutorSessionPage = () => {
  const { executorId = '', sessionId = '' } = useParams()
  const navigate = useNavigate()
  const [sharing, setSharing] = useState(false)
  const view = useExecutorSessionView(executorId, sessionId)
  const session = view.data?.session
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader title={session?.title ?? 'Session'} eyebrow="Sessions"
        backLabel="Back to sessions" onBack={() => void navigate(COMPUTER_SESSIONS_PATH)}
        actions={view.data?.canShare ? [{
          id: 'share-session', kind: 'button', label: 'Share session', priority: 80, onSelect: () => setSharing(true),
        }] : []}
        subtitle="View only · The agent controls this session" />
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-[var(--page-gutter)] py-4">
        <QueryState query={view} loadingLabel="Connecting to session…"
          errorLabel="This session is unavailable or you no longer have permission to view it.">
          {() => view.data ? (
            <>
              <p className="text-sm text-[color:var(--tx2)]" role="status">
                {view.data.online ? 'Connected to the computer' : 'Computer offline · waiting to reconnect'}
                {session ? ` · ${session.status.replaceAll('_', ' ')}` : ''}
              </p>
              {view.data.screen ? <>
                <ExecutorTerminalScreen screen={view.data.screen} />
                <p className="text-xs text-[color:var(--tx3)]">
                  {view.data.screen.kind === 'terminal'
                    ? 'Live terminal · current screen and up to 500 lines of scrollback. Scroll sideways on smaller screens.'
                    : 'Agent activity · recent projected messages and tool results. This session uses a structured CLI protocol.'}
                </p>
              </> : <p className="text-sm text-[color:var(--tx2)]">
                Waiting for a screen from the computer. If it stays unavailable, update the computer and
                check that the session still exists.
              </p>}
            </>
          ) : null}
        </QueryState>
      </div>
      {view.data?.canShare ? <ExecutorSessionSharing executorId={executorId} sessionId={sessionId}
        open={sharing} onClose={() => setSharing(false)} /> : null}
    </div>
  )
}
