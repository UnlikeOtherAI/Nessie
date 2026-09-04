import { useEffect, useState } from 'react'
import type { ExecutorCreateResponse } from '@nessie/schemas'
import {
  changeExecutorWorkspaceWithCompanion,
  configureExecutorWorkspaceWithCompanion,
  executorCompanionStatus,
  forgetExecutorWithCompanion,
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

const failureMessage = (cause: unknown): string => {
  if (typeof cause === 'string') return cause
  if (cause instanceof Error) return cause.message
  if (cause && typeof cause === 'object' && 'message' in cause
    && typeof cause.message === 'string') return cause.message
  return 'Nessie Desktop could not complete that executor action.'
}

type CompanionAction = 'forget' | 'pair' | 'policy' | 'start' | 'stop' | 'workspace'

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
  const [operationKeys, setOperationKeys] = useState<string[]>([])
  const [busy, setBusy] = useState<CompanionAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const activeExecutorId = created?.executor.id ?? executorId

  useEffect(() => {
    if (desktopPlatform === null) return
    let current = true
    setStatus(null)
    setOperationKeys([])
    setError(null)
    void executorCompanionStatus()
      .then((response) => {
        if (!current) return
        setCompanion(response)
        const nextStatus = activeExecutorId
          ? response.executors.find((entry) => entry.executorId === activeExecutorId) ?? null
          : null
        setStatus(nextStatus)
        setOperationKeys(nextStatus?.operationKeys ?? [])
      })
      .catch((cause: unknown) => {
        if (current) {
          setCompanion(null)
          setError(failureMessage(cause))
        }
      })
    return () => {
      current = false
    }
  }, [activeExecutorId, desktopPlatform])

  if (desktopPlatform === null) return null
  if (!companion) {
    return error ? (
      <section className="admin-card grid gap-2 border border-[color:var(--danger)] p-4">
        <h2 className="text-sm font-semibold text-[color:var(--tx)]">Nessie Desktop companion</h2>
        <p className="text-xs text-[color:var(--danger-text)]">{error}</p>
      </section>
    ) : null
  }

  const controls = offersControls(companion.availability)
  if (!controls) return <AvailabilityCard status={companion} />
  if (!activeExecutorId) {
    return companion.availability === 'workspace_only' ? <AvailabilityCard status={companion} /> : null
  }

  const run = async (
    actionName: CompanionAction,
    action: () => Promise<ExecutorCompanionStatus>,
  ) => {
    setBusy(actionName)
    setError(null)
    try {
      const nextStatus = await action()
      setStatus(nextStatus)
      setOperationKeys(nextStatus.operationKeys)
    } catch (cause) {
      setError(failureMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const forget = async () => {
    setBusy('forget')
    setError(null)
    try {
      await forgetExecutorWithCompanion(activeExecutorId)
      setStatus(null)
      setOperationKeys([])
      setCompanion((current) => current ? {
        ...current,
        executors: current.executors.filter((entry) => entry.executorId !== activeExecutorId),
      } : current)
    } catch (cause) {
      setError(failureMessage(cause))
    } finally {
      setBusy(null)
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
            Nessie never receives the full local path or pairing secret. When an allowed action
            runs, requested file content and bounded result output are sent to Nessie and the
            configured model provider.
          </p>
        </div>

        {created ? (
          <button
            className="admin-button admin-button-primary w-fit"
            disabled={busy !== null}
            onClick={() => void run('pair', () => pairExecutorWithCompanion({
              apiBaseUrl: getBaseUrl() || 'https://api.nessie.works',
              challenge: created.invitation.challenge,
              enrollmentId: created.invitation.enrollmentId,
              executorId: created.executor.id,
            }))}
            type="button"
          >
            {busy === 'pair' ? 'Pairing…' : 'Choose workspace and pair this computer'}
          </button>
        ) : null}

        {status ? (
          <div className="grid gap-3 rounded-md bg-[color:var(--overlay-weak)] p-3">
            <p className="text-xs text-[color:var(--tx2)]">
              Local daemon: <span className="font-semibold text-[color:var(--tx)]">{status.daemonStatus}</span>
              {' · '}Folder: <span className="font-semibold text-[color:var(--tx)]">{status.workspaceLabel}</span>
            </p>
            {status.daemonStatus === 'awaiting_confirmation' ? (
              <p className="text-xs text-[color:var(--tx3)]">Confirm this executor’s fingerprint in Nessie before starting its local daemon.</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {status.daemonStatus === 'running' ? (
                <button className="admin-button admin-button-secondary" disabled={busy !== null} onClick={() => void run('stop', () => stopExecutorWithCompanion(activeExecutorId))} type="button">{busy === 'stop' ? 'Stopping…' : 'Stop daemon'}</button>
              ) : status.daemonStatus === 'stopping' ? (
                <span className="text-xs text-[color:var(--tx3)]">Waiting for the prior daemon to stop…</span>
              ) : (
                <button className="admin-button admin-button-secondary" disabled={busy !== null} onClick={() => void run('start', () => startExecutorWithCompanion(activeExecutorId))} type="button">{busy === 'start' ? 'Starting…' : 'Start daemon'}</button>
              )}
              <button
                className="admin-button admin-button-secondary"
                disabled={busy !== null || operationKeys.length === 0}
                onClick={() => void run('workspace', () => changeExecutorWorkspaceWithCompanion(activeExecutorId, operationKeys))}
                type="button"
              >
                {busy === 'workspace' ? 'Changing folder…' : 'Change folder'}
              </button>
            </div>
            <fieldset className="grid gap-2">
              <legend className="text-xs font-semibold text-[color:var(--tx2)]">Local workspace policy</legend>
              {workspaceOperations.map(({ key, label }) => (
                <label className="flex items-center gap-2 text-xs text-[color:var(--tx2)]" key={key}>
                  <input checked={operationKeys.includes(key)} disabled={busy !== null} onChange={() => toggleOperation(key)} type="checkbox" />
                  {label}
                </label>
              ))}
              <button
                className="admin-button admin-button-secondary w-fit"
                disabled={busy !== null || operationKeys.length === 0}
                onClick={() => void run('policy', () => configureExecutorWorkspaceWithCompanion(activeExecutorId, operationKeys))}
                type="button"
              >
                {busy === 'policy' ? 'Saving policy…' : 'Save local policy'}
              </button>
              <p className="text-xs text-[color:var(--tx3)]">
                A running daemon submits the signed revision for review now. If stopped, it is
                submitted the next time you start this executor.
              </p>
            </fieldset>
            <div className="grid gap-1 border-t border-[color:var(--sep)] pt-3">
              <button
                className="admin-button admin-button-secondary w-fit"
                disabled={busy !== null}
                onClick={() => void forget()}
                type="button"
              >
                {busy === 'forget' ? 'Forgetting…' : 'Forget pairing on this computer'}
              </button>
              <p className="text-xs text-[color:var(--tx3)]">
                Removes the local machine key and folder selection and permanently deletes local
                draft copies. The executor and its audit history remain in Nessie for its owner
                to revoke or retain.
              </p>
            </div>
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
