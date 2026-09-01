import { useEffect, useState } from 'react'
import type { ExecutorCreateResponse } from '@nessie/schemas'
import {
  configureExecutorWorkspaceWithCompanion,
  executorCompanionStatus,
  pairExecutorWithCompanion,
  startExecutorWithCompanion,
  stopExecutorWithCompanion,
  type ExecutorCompanionAvailability,
  type ExecutorCompanionStatus,
  type ExecutorCompanionStatusResponse,
} from '../../../lib/executor-companion'
import { getBaseUrl } from '../../../lib/api-client'
import { useShellEnvironment } from '../../../providers/ShellEnvironmentProvider'

const workspaceOperations = [
  { key: 'file.list', label: 'List files' },
  { key: 'file.read', label: 'Read files' },
  { key: 'file.write', label: 'Create COW drafts' },
  { key: 'workspace.review', label: 'Review COW drafts' },
  { key: 'sandbox.stop', label: 'Stop sandboxes' },
] as const

type ExecutorDesktopCompanionPanelProps = {
  created?: ExecutorCreateResponse | null
  executorId?: string
}

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'Nessie Desktop could not complete that executor action.'

/** Availability states that still put pairing and daemon controls on screen. */
const offersControls = (availability: ExecutorCompanionAvailability): boolean =>
  availability === 'available' || availability === 'workspace_only'

const availabilityHeadline: Record<ExecutorCompanionAvailability, string> = {
  available: 'Nessie Desktop companion',
  runtime_missing: 'Nessie Desktop companion',
  unsigned_release: 'Nessie Desktop companion',
  unsupported_platform: 'Nessie Desktop companion',
  workspace_only: 'This computer can pair for file review and drafts',
}

/**
 * One card carrying the shell's own answer about this device. `reason` is
 * written by the companion — it names the remedy and carries no local path or
 * secret — so the admin renders it verbatim rather than restating a guess about
 * why the person's computer cannot run sandboxed work.
 */
const AvailabilityCard = ({ status }: { status: ExecutorCompanionStatusResponse }) => (
  <section className="admin-card grid gap-2 border border-[color:var(--sep)] p-4">
    <h2 className="text-sm font-semibold text-[color:var(--tx)]">
      {availabilityHeadline[status.availability]}
    </h2>
    <p className="text-xs text-[color:var(--tx3)]">{status.reason}</p>
    <p className="text-xs text-[color:var(--tx3)]">
      Installing, upgrading and verifying the desktop companion is documented in{' '}
      <code className="rounded bg-[color:var(--overlay-weak)] px-1 py-0.5 text-[color:var(--tx2)]">
        docs/running-the-apps/overview.md
      </code>
      .
    </p>
  </section>
)

export const ExecutorDesktopCompanionPanel = ({
  created,
  executorId,
}: ExecutorDesktopCompanionPanelProps) => {
  const { desktopPlatform } = useShellEnvironment()
  const [companion, setCompanion] = useState<ExecutorCompanionStatusResponse | null>(null)
  const [status, setStatus] = useState<ExecutorCompanionStatus | null>(null)
  const [operationKeys, setOperationKeys] = useState<string[]>(workspaceOperations.map(({ key }) => key))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeExecutorId = created?.executor.id ?? executorId

  useEffect(() => {
    if (desktopPlatform === null) return
    let current = true
    void executorCompanionStatus()
      .then((response) => {
        if (!current) return
        setCompanion(response)
        if (activeExecutorId) {
          setStatus(response.executors.find((entry) => entry.executorId === activeExecutorId) ?? null)
        }
      })
      .catch(() => {
        // A shell too old to answer the new command is the one case left where
        // there is nothing truthful to say about this device.
        if (current) setCompanion(null)
      })
    return () => {
      current = false
    }
  }, [activeExecutorId, desktopPlatform])

  if (desktopPlatform === null || !companion) return null

  const controls = offersControls(companion.availability)
  if (!controls) return <AvailabilityCard status={companion} />
  if (!activeExecutorId) {
    return companion.availability === 'workspace_only' ? <AvailabilityCard status={companion} /> : null
  }

  const run = async (action: () => Promise<ExecutorCompanionStatus>) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await action())
    } catch (cause) {
      setError(failureMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const toggleOperation = (operationKey: string) => {
    setOperationKeys((current) => current.includes(operationKey)
      ? current.filter((key) => key !== operationKey)
      : [...current, operationKey])
  }

  return (
    <>
      {companion.availability === 'workspace_only' ? <AvailabilityCard status={companion} /> : null}
      <section className="admin-card grid gap-3 border border-[color:var(--accent)] p-4">
        <div>
          <h2 className="text-sm font-semibold text-[color:var(--tx)]">Nessie Desktop companion</h2>
          <p className="mt-1 text-xs text-[color:var(--tx3)]">
            Local workspace selection and every daemon action require a native confirmation.
            Nessie receives no local path, pairing secret, or executor runtime output.
          </p>
        </div>

        {created ? (
          <button
            className="admin-button admin-button-primary w-fit"
            disabled={busy}
            onClick={() => void run(() => pairExecutorWithCompanion({
              apiBaseUrl: getBaseUrl() || 'https://api.nessie.works',
              challenge: created.invitation.challenge,
              enrollmentId: created.invitation.enrollmentId,
              executorId: created.executor.id,
            }))}
            type="button"
          >
            {busy ? 'Pairing…' : 'Choose workspace and pair this computer'}
          </button>
        ) : null}

        {status ? (
          <div className="grid gap-3 rounded-md bg-[color:var(--overlay-weak)] p-3">
            <p className="text-xs text-[color:var(--tx2)]">
              Local daemon: <span className="font-semibold text-[color:var(--tx)]">{status.daemonStatus}</span> · local workspace selected
            </p>
            {status.daemonStatus === 'awaiting_confirmation' ? (
              <p className="text-xs text-[color:var(--tx3)]">Confirm this executor’s fingerprint in Nessie before starting its local daemon.</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {status.daemonStatus === 'running' ? (
                <button className="admin-button admin-button-secondary" disabled={busy} onClick={() => void run(() => stopExecutorWithCompanion(activeExecutorId))} type="button">Stop daemon</button>
              ) : status.daemonStatus === 'stopping' ? (
                <span className="text-xs text-[color:var(--tx3)]">Waiting for the prior daemon to stop…</span>
              ) : (
                <button className="admin-button admin-button-secondary" disabled={busy} onClick={() => void run(() => startExecutorWithCompanion(activeExecutorId))} type="button">Start daemon</button>
              )}
            </div>
            <fieldset className="grid gap-2">
              <legend className="text-xs font-semibold text-[color:var(--tx2)]">Local workspace policy</legend>
              {workspaceOperations.map(({ key, label }) => (
                <label className="flex items-center gap-2 text-xs text-[color:var(--tx2)]" key={key}>
                  <input checked={operationKeys.includes(key)} onChange={() => toggleOperation(key)} type="checkbox" />
                  {label}
                </label>
              ))}
              <button
                className="admin-button admin-button-secondary w-fit"
                disabled={busy || operationKeys.length === 0}
                onClick={() => void run(() => configureExecutorWorkspaceWithCompanion(activeExecutorId, operationKeys))}
                type="button"
              >
                Save local policy for review
              </button>
            </fieldset>
          </div>
        ) : created ? (
          <p className="text-xs text-[color:var(--tx3)]">Choose the read-only workspace in the native dialog, then confirm the new executor fingerprint in Nessie before starting its daemon.</p>
        ) : (
          <p className="text-xs text-[color:var(--tx3)]">This executor is not paired with this Nessie Desktop device.</p>
        )}

        {error ? <p className="text-xs text-[color:var(--danger-text)]">{error}</p> : null}
      </section>
    </>
  )
}
