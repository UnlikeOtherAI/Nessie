import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  useLocalInferenceHostAction,
  useLocalInferenceCapacity,
  useLocalInferenceHosts,
  type LocalInferenceHost,
} from '../../../facades/local-inference/hooks'
import { FormField } from '../../shared/FormField'
import { Select } from '../../shared/FormControls'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { QueryState } from '../../shared/QueryState'

type LocalInferenceHostStatusProps = {
  /** Use the shared blocking confirmation when this surface is in a dialog. */
  confirmInDialog?: boolean
  /** Restricts the shared controls to one paired executor when it is known. */
  executorId?: string
  /** A task set selects one authorized processor host, not every own machine. */
  hostId?: string
  /** The owning surface supplies the only useful empty-state doorway. */
  empty: ReactNode
}

const hostCopy = (host: LocalInferenceHost): string => {
  if (host.status === 'revoked') return 'Revoked — connect it again before an agent can use it.'
  if (host.status === 'needs_rebinding') return 'Needs reconsent before it can run an agent.'
  if (host.resource?.healthReason === 'termination_uncertain') {
    return 'Confirm on this computer that the previous Ollama request has stopped before resuming local models.'
  }
  if (host.resource?.paused ?? host.paused) return 'Paused — resume when this computer is ready to accept an agent request.'
  if (host.availability === 'unknown') return 'Unknown — Nessie cannot currently verify this connection.'
  if (host.availability === 'offline') return 'Offline — start Nessie Desktop or its executor on this computer.'
  return host.models.length === 0
    ? 'Online — no verified local chat model has been published.'
    : 'Online — ready for a selected local model.'
}

/**
 * The one owner-facing status and repair surface for a local Ollama host.
 * Connections passes every own host; an executor detail passes just that
 * executor, so following either doorway reaches the same control and facts.
 */
export const LocalInferenceHostStatus = ({
  executorId, hostId, empty, confirmInDialog = false,
}: LocalInferenceHostStatusProps) => {
  const hosts = useLocalInferenceHosts()
  const action = useLocalInferenceHostAction()
  const capacity = useLocalInferenceCapacity()
  const [actionError, setActionError] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<LocalInferenceHost | null>(null)

  const performHostAction = (
    hostId: string,
    nextAction: 'pause' | 'resume' | 'revoke',
    onSuccess?: () => void,
  ) => {
    setActionError(null)
    action.mutate(
      { action: nextAction, hostId },
      {
        onError: () => setActionError('Nessie could not update this local Ollama connection. Try again.'),
        onSuccess,
      },
    )
  }

  const visibleHosts = (hosts.data?.hosts ?? []).filter((host) =>
    (executorId === undefined || host.executorId === executorId) && (hostId === undefined || host.id === hostId),
  )

  return (
    <div className="grid gap-3">
      {actionError ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{actionError}</p> : null}
      <QueryState
        errorLabel="Could not load your local Ollama connections."
        loadingLabel="Loading local Ollama connections…"
        query={hosts}
      >
        {() => visibleHosts.length ? (
          <div className="divide-y divide-[color:var(--sep)] border-y border-[color:var(--sep)]">
            {visibleHosts.map((host) => (
              <div
                className="flex flex-wrap items-center justify-between gap-3 py-3"
                id={`local-inference-host-${host.id}`}
                key={host.id}
              >
                <div>
                  <p className="text-sm font-medium text-[color:var(--tx)]">
                    {host.transport === 'desktop' ? 'Nessie Desktop' : 'Paired computer'} · {host.availability}
                  </p>
                  <p className="mt-1 text-xs text-[color:var(--tx3)]">{hostCopy(host)}</p>
                  {host.resource ? <p className="mt-1 text-xs text-[color:var(--tx3)]">
                    Shared capacity: {host.resource.capacity}. Pause applies to all local models using this resource.
                  </p> : null}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  {host.resource ? <FormField label="Shared parallel requests">
                    <Select disabled={capacity.isPending} onChange={(event) => {
                      setActionError(null)
                      capacity.mutate({ hostId: host.id, capacity: Number(event.target.value) }, {
                        onError: () => setActionError('Could not update shared capacity. Try again.'),
                      })
                    }} value={host.resource.capacity}>
                      {Array.from({ length: 16 }, (_, index) => index + 1).map((value) =>
                        <option key={value} value={value}>{value}</option>)}
                    </Select>
                  </FormField> : null}
                  {executorId === undefined && host.transport === 'executor' && host.executorId ? (
                    <Link className="admin-button admin-button-secondary" to={`/admin/computers/${host.executorId}`}>
                      Open computer
                    </Link>
                  ) : null}
                  {host.status !== 'revoked' ? (
                    <button
                      className="admin-button admin-button-secondary"
                      disabled={action.isPending || host.resource?.healthReason === 'termination_uncertain'}
                      onClick={() => performHostAction(host.id, (host.resource?.paused ?? host.paused) ? 'resume' : 'pause')}
                      type="button"
                    >
                      {(host.resource?.paused ?? host.paused) ? 'Resume local models' : 'Pause local models'}
                    </button>
                  ) : null}
                  <button
                    className="admin-button admin-button-danger"
                    disabled={action.isPending || host.status === 'revoked'}
                    onClick={() => setRevokeTarget(host)}
                    type="button"
                  >
                    Disconnect local models
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : empty}
      </QueryState>
      <ConfirmDialog
        blocking={confirmInDialog}
        body="Agents will stop using this computer’s local models. The computer pairing and other computer permissions stay connected."
        confirmLabel="Disconnect"
        destructive
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (!revokeTarget) return
          performHostAction(revokeTarget.id, 'revoke', () => setRevokeTarget(null))
        }}
        open={revokeTarget !== null}
        pending={action.isPending}
        title="Disconnect local models?"
      />
    </div>
  )
}
