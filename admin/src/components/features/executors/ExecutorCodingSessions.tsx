import {
  EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
  type ExecutorCodingSessionRecord,
  type ExecutorCodingSessionStatus,
  type ExecutorLocalMcpStatus,
} from '@nessie/schemas'
import { useState } from 'react'

import { useCloseExecutorCodingSession, useExecutorCodingSessions } from '../../../facades/executors/coding-sessions'
import { formErrorMessage } from '../../../facades/forms/form-errors'
import { Pill, type PillTone } from '../../primitives/Pill'
import { FormError } from '../../shared/FormActions'
import { QueryState } from '../../shared/QueryState'
import { EXECUTOR_CODING_AGENT_LABELS, executorObservedAge } from './executor-presentation'

/**
 * The coding sessions open on this machine, under the built-in bridge's own
 * status in Local apps. Every one of them acts as the person who paired the
 * machine — their files, their git and SSH credentials, their coding-agent
 * login — so this is where that person sees what is still running there and
 * ends it, and where the others who manage the machine see it without being
 * able to.
 *
 * The rows are the machine's last local-MCP report, read through the API so
 * it can add what the report cannot say: which agent drives each session
 * (named only when this reader could see that agent) and whether a close is
 * already on its way. Close is accepted, not done — it rides the next
 * heartbeat — so the row reads "Closing…" until a report no longer carries
 * the session. Nothing a session said or did is here; the report has none.
 */

const STATUS: Record<ExecutorCodingSessionStatus, { label: string; tone: PillTone }> = {
  closed: { label: 'closed', tone: 'muted' },
  failed: { label: 'failed', tone: 'danger' },
  interrupted: { label: 'interrupted', tone: 'warning' },
  starting: { label: 'starting', tone: 'muted' },
  waiting_for_input: { label: 'waiting for input', tone: 'info' },
  working: { label: 'working', tone: 'accent' },
}

type SessionRowProps = {
  canClose: boolean
  closing: boolean
  onClose: () => void
  pending: boolean
  session: ExecutorCodingSessionRecord
}

const SessionRow = ({ canClose, closing, onClose, pending, session }: SessionRowProps) => (
  <li className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2" data-testid="executor-coding-session">
    <div className="grid min-w-0 flex-1 gap-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words font-medium text-[color:var(--tx)]">{session.title}</span>
        <Pill size="sm" tone={STATUS[session.status].tone} uppercase={false}>{STATUS[session.status].label}</Pill>
        {/* A categorical reason (`host_lost`, `agent_missing`), never free text. */}
        {session.reason ? <span className="text-[color:var(--tx3)]">{session.reason.replaceAll('_', ' ')}</span> : null}
      </div>
      <p className="text-[color:var(--tx3)]">
        {EXECUTOR_CODING_AGENT_LABELS[session.agent]} in {session.root}
        {' · '}driven by {session.ownerAgentName ?? 'an agent you cannot see'}
        {' · '}updated <span title={session.updatedAt}>{executorObservedAge(session.updatedAt)}</span>
      </p>
    </div>
    {closing ? (
      <span
        className="py-1 text-[color:var(--tx3)]"
        data-testid="executor-coding-session-closing"
        title="The machine closes it the next time it checks in."
      >
        Closing…
      </span>
    ) : canClose ? (
      <button
        aria-label={`Close ${session.title}`}
        className="admin-button admin-button-secondary admin-button-compact"
        disabled={pending}
        onClick={onClose}
        type="button"
      >
        Close
      </button>
    ) : null}
  </li>
)

const CodingSessionList = ({ executorId }: { executorId: string }) => {
  const query = useExecutorCodingSessions(executorId)
  const close = useCloseExecutorCodingSession(executorId)
  const [error, setError] = useState<string | null>(null)
  const closeSession = (session: ExecutorCodingSessionRecord) => {
    setError(null)
    close.mutate({ ownerKey: session.ownerKey, sessionId: session.sessionId }, {
      onError: (cause) => setError(formErrorMessage(cause, 'That session could not be closed. Try again.')),
    })
  }
  return (
    <QueryState
      className="py-2"
      errorLabel="The open coding sessions could not be loaded."
      loadingLabel="Loading coding sessions…"
      query={query}
    >
      {() => {
        const list = query.data ?? { canClose: false, sessions: [] }
        if (list.sessions.length === 0) {
          return <p className="mt-1 text-[color:var(--tx2)]">No coding sessions are open on this machine.</p>
        }
        const pressed = close.isPending ? close.variables?.sessionId : undefined
        return (
          <div className="mt-1 grid gap-1">
            <FormError>{error}</FormError>
            <ul aria-label="Open coding sessions" className="grid divide-y divide-[color:var(--sep)]">
              {list.sessions.map((session) => (
                <SessionRow
                  canClose={list.canClose}
                  closing={session.closing || pressed === session.sessionId}
                  key={session.sessionId}
                  onClose={() => closeSession(session)}
                  pending={close.isPending}
                  session={session}
                />
              ))}
            </ul>
            {list.canClose ? null : (
              <p className="text-[color:var(--tx3)]">
                Only the person who paired this machine can close its coding sessions; they run as that person.
              </p>
            )}
          </div>
        )
      }}
    </QueryState>
  )
}

export const ExecutorCodingSessions = ({ executorId, status }: {
  executorId: string
  status: ExecutorLocalMcpStatus
}) => {
  if (status.server !== EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME) return null
  // Absent means the daemon did not ask the bridge, which says nothing about
  // what is open — the same distinction Kelpie's inventory keeps.
  if (!status.codingSessions) {
    return <p className="mt-1 text-[color:var(--tx3)]">Open coding sessions have not been checked yet.</p>
  }
  return <CodingSessionList executorId={executorId} />
}
