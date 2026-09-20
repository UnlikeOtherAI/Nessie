import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import {
  useEnrollLocalInferenceDesktopHost,
  useLocalInferenceHostAction,
  useLocalInferenceHosts,
  type LocalInferenceHost,
} from '../../../facades/local-inference/hooks'
import { QueryState } from '../../../components/shared/QueryState'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { isDesktopApp } from '../../../lib/desktop'
import {
  prepareLocalInferenceDesktopEnrollment,
  startLocalInferenceDirectHost,
} from '../../../lib/local-inference-desktop'

const hostCopy = (host: LocalInferenceHost): string => {
  if (host.status === 'revoked') return 'Revoked — connect it again before an agent can use it.'
  if (host.status === 'needs_rebinding') return 'Needs reconsent before it can run an agent.'
  if (host.paused) return 'Paused — resume when this computer is ready to accept an agent request.'
  if (host.availability === 'unknown') return 'Unknown — Nessie cannot currently verify this connection.'
  if (host.availability === 'offline') return 'Offline — start Nessie Desktop or its executor on this computer.'
  return host.models.length === 0 ? 'Online — no verified local chat model has been published.' : 'Online — ready for a selected local model.'
}

/** Own-host status and repairs. A browser is deliberately never offered a local scan. */
export const LocalOllamaSection = () => {
  const hosts = useLocalInferenceHosts()
  const action = useLocalInferenceHostAction()
  const enroll = useEnrollLocalInferenceDesktopHost()
  const [actionError, setActionError] = useState<string | null>(null)
  const [startingHostId, setStartingHostId] = useState<string | null>(null)

  useEffect(() => {
    if (!startingHostId) return
    const host = hosts.data?.hosts.find((candidate) => candidate.id === startingHostId)
    if (host?.availability === 'online' && host.models.length > 0) setStartingHostId(null)
  }, [hosts.data?.hosts, startingHostId])

  const performHostAction = (hostId: string, nextAction: 'pause' | 'resume' | 'revoke') => {
    setActionError(null)
    action.mutate(
      { action: nextAction, hostId },
      { onError: () => setActionError('Nessie could not update this local Ollama connection. Try again.') },
    )
  }

  const prepareDesktop = async () => {
    setActionError(null)
    try {
      const enrollment = await prepareLocalInferenceDesktopEnrollment()
      const host = await enroll.mutateAsync({ displayLabel: 'Nessie Desktop', publicKey: enrollment.publicKey })
      await startLocalInferenceDirectHost(host)
      setStartingHostId(host.hostId)
      await hosts.refetch()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Nessie could not prepare this computer.')
    }
  }

  return (
    <section className="grid gap-4">
      <div>
        <SectionLabel as="h2">Local Ollama</SectionLabel>
        <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
          Run your own agents on a model installed on your own computer. Nessie Desktop or a paired executor
          discovers Ollama there after you give that computer permission; this browser never scans your device.
        </p>
      </div>
      {startingHostId ? (
        <p className="text-sm text-[color:var(--tx2)]" role="status">
          Looking for local Ollama models on this computer. Keep Nessie Desktop and Ollama open; this connection
          will appear when a local chat model is verified.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {isDesktopApp() ? (
          <button
            className="admin-button admin-button-secondary"
            disabled={enroll.isPending}
            onClick={() => void prepareDesktop()}
            type="button"
          >
            {enroll.isPending ? 'Preparing this computer…' : 'Prepare this computer'}
          </button>
        ) : null}
        <Link className="text-sm text-[color:var(--lnk)] hover:underline" to="/agents/executors">
          Open paired executors
        </Link>
      </div>
      {actionError ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{actionError}</p> : null}
      <QueryState
        errorLabel="Could not load your local Ollama connections."
        loadingLabel="Loading local Ollama connections…"
        query={hosts}
      >
        {() => hosts.data?.hosts.length ? (
          <div className="divide-y divide-[color:var(--sep)] border-y border-[color:var(--sep)]">
            {hosts.data.hosts.map((host) => (
              <div
                className="flex flex-wrap items-center justify-between gap-3 py-3"
                id={`local-inference-host-${host.id}`}
                key={host.id}
              >
                <div>
                  <p className="text-sm font-medium text-[color:var(--tx)]">
                    {host.transport === 'desktop' ? 'Nessie Desktop' : 'Paired executor'} · {host.availability}
                  </p>
                  <p className="mt-1 text-xs text-[color:var(--tx3)]">{hostCopy(host)}</p>
                </div>
                <div className="flex gap-2">
                  {host.transport === 'executor' && host.executorId ? (
                    <Link
                      className="admin-button admin-button-secondary"
                      to={`/agents/executors/${host.executorId}`}
                    >
                      Open executor
                    </Link>
                  ) : null}
                  {host.status !== 'revoked' ? (
                    <button
                      className="admin-button admin-button-secondary"
                      disabled={action.isPending}
                      onClick={() => performHostAction(host.id, host.paused ? 'resume' : 'pause')}
                      type="button"
                    >
                      {host.paused ? 'Resume' : 'Pause'}
                    </button>
                  ) : null}
                  <button
                    className="admin-button admin-button-danger"
                    disabled={action.isPending || host.status === 'revoked'}
                    onClick={() => performHostAction(host.id, 'revoke')}
                    type="button"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[color:var(--tx2)]">
            No local computer is connected yet. On this computer, prepare Nessie Desktop; on another computer,
            {' '}<Link className="underline" to="/agents/executors">open its paired executor</Link>. Once it reports a
            local model, select it from an <Link className="underline" to="/agents">agent’s Model section</Link>.
          </p>
        )}
      </QueryState>
    </section>
  )
}
