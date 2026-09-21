import { useEffect, useState } from 'react'
import {
  changeExecutorWorkspaceWithCompanion,
  configureExecutorWorkspaceWithCompanion,
  executorCompanionStatus,
  forgetExecutorWithCompanion,
  NO_MENU_BAR_COMPANION,
  openExecutorMenuBarApp,
  startExecutorWithCompanion,
  stopExecutorWithCompanion,
  type ExecutorCompanionAvailability,
  type ExecutorCompanionStatus,
  type ExecutorCompanionStatusResponse,
  type ExecutorMenuBarCompanion,
} from '../../../lib/executor-companion'
import { useShellEnvironment } from '../../../providers/ShellEnvironmentProvider'

const workspaceOperations = [
  { key: 'file.list', label: 'List files' },
  { key: 'file.read', label: 'Read files' },
  { key: 'file.write', label: 'Edit draft copies' },
  { key: 'workspace.review', label: 'Review draft changes' },
  { key: 'sandbox.stop', label: 'Stop work sessions' },
] as const

type ExecutorDesktopCompanionPanelProps = {
  executorId?: string
}

const failureMessage = (cause: unknown): string => {
  if (typeof cause === 'string') return cause
  if (cause instanceof Error) return cause.message
  if (cause && typeof cause === 'object' && 'message' in cause
    && typeof cause.message === 'string') return cause.message
  return 'Nessie Desktop could not complete that executor action.'
}

type CompanionAction = 'forget' | 'menuBar' | 'policy' | 'start' | 'stop' | 'workspace'

/**
 * Nessie Desktop ships the Nessie Executor menu bar app inside its own bundle,
 * so a Mac needs no second download to run an executor. Once that app is
 * supervising the daemon it owns this Mac: Desktop says so and offers the way
 * across rather than a start button that would race it for the daemon lease.
 */
const MENU_BAR_SUPERVISING_COPY =
  'Nessie Executor is running this Mac. Use its menu bar icon to start or stop it.'

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
  <section className="grid gap-2">
    <h2 className="text-sm font-semibold text-[color:var(--tx)]">
      {availabilityHeadline[status.availability]}
    </h2>
    <p className="text-xs text-[color:var(--tx3)]">{status.reason}</p>
  </section>
)

/**
 * The doorway to the menu bar app. It is offered whether or not this Mac has a
 * Desktop pairing, because a person who wants the menu bar app is exactly the
 * person who has not paired one here — and the app Desktop ships is the one they
 * would otherwise go and download.
 */
const MenuBarSection = ({
  busy,
  menuBar,
  onOpen,
}: {
  busy: CompanionAction | null
  menuBar: ExecutorMenuBarCompanion
  onOpen: () => void
}) => (
  <div className="grid gap-1">
    <button
      className="admin-button admin-button-secondary w-fit"
      disabled={busy !== null}
      onClick={onOpen}
      type="button"
    >
      {busy === 'menuBar' ? 'Opening…' : 'Open Nessie Executor'}
    </button>
    <p className="text-xs text-[color:var(--tx3)]">
      {menuBar.supervising
        ? MENU_BAR_SUPERVISING_COPY
        : 'Choose folders and permitted programs in Nessie Executor.'}
    </p>
  </div>
)

export const ExecutorDesktopCompanionPanel = ({
  executorId,
}: ExecutorDesktopCompanionPanelProps) => {
  const { desktopPlatform } = useShellEnvironment()
  const [companion, setCompanion] = useState<ExecutorCompanionStatusResponse | null>(null)
  const [status, setStatus] = useState<ExecutorCompanionStatus | null>(null)
  const [operationKeys, setOperationKeys] = useState<string[]>([])
  const [busy, setBusy] = useState<CompanionAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const activeExecutorId = executorId

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

  const openMenuBarApp = async () => {
    setBusy('menuBar')
    setError(null)
    try {
      await openExecutorMenuBarApp()
    } catch (cause) {
      setError(failureMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  if (desktopPlatform === null) return null
  if (!companion) {
    return error ? (
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold text-[color:var(--tx)]">Nessie Desktop companion</h2>
        <p className="text-xs text-[color:var(--danger-text)]">{error}</p>
      </section>
    ) : null
  }

  const controls = offersControls(companion.availability)
  if (!controls) return <AvailabilityCard status={companion} />
  const menuBar = companion.menuBar ?? NO_MENU_BAR_COMPANION
  const menuBarSection = menuBar.openable ? (
    <MenuBarSection busy={busy} menuBar={menuBar} onOpen={() => void openMenuBarApp()} />
  ) : null
  if (!activeExecutorId) {
    const availabilityCard = companion.availability === 'workspace_only'
      ? <AvailabilityCard status={companion} />
      : null
    if (!availabilityCard && !menuBarSection) return null
    return (
      <>
        {availabilityCard}
        {menuBarSection ? (
          <section className="grid gap-3">
            <h2 className="text-sm font-semibold text-[color:var(--tx)]">Nessie Executor on this Mac</h2>
            {menuBarSection}
          </section>
        ) : null}
      </>
    )
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
      <section className="grid gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[color:var(--tx)]">Nessie Desktop companion</h2>
          <p className="mt-1 text-xs text-[color:var(--tx3)]">
            Changes require confirmation on this computer. Files an agent reads are sent to
            Nessie and its model provider.
          </p>
        </div>

        {menuBarSection}

        {status ? (
          <div className="grid gap-3">
            <p className="text-xs text-[color:var(--tx2)]">
              Executor: <span className="font-semibold text-[color:var(--tx)]">{status.daemonStatus.replaceAll('_', ' ')}</span>
              {' · '}Folder: <span className="font-semibold text-[color:var(--tx)]">{status.workspaceLabel}</span>
            </p>
            {status.daemonStatus === 'awaiting_confirmation' ? (
              <p className="text-xs text-[color:var(--tx3)]">
                Finish pairing in Nessie Executor on this machine before starting it.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {menuBar.supervising ? (
                <span className="text-xs text-[color:var(--tx3)]">{MENU_BAR_SUPERVISING_COPY}</span>
              ) : status.daemonStatus === 'running' ? (
                <button className="admin-button admin-button-secondary" disabled={busy !== null} onClick={() => void run('stop', () => stopExecutorWithCompanion(activeExecutorId))} type="button">{busy === 'stop' ? 'Stopping…' : 'Stop executor'}</button>
              ) : status.daemonStatus === 'stopping' ? (
                <span className="text-xs text-[color:var(--tx3)]">Waiting for the executor to stop…</span>
              ) : (
                <button className="admin-button admin-button-secondary" disabled={busy !== null} onClick={() => void run('start', () => startExecutorWithCompanion(activeExecutorId))} type="button">{busy === 'start' ? 'Starting…' : 'Start executor'}</button>
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
              <legend className="text-xs font-semibold text-[color:var(--tx2)]">Folder permissions</legend>
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
                {busy === 'policy' ? 'Saving…' : 'Save permissions'}
              </button>
              <p className="text-xs text-[color:var(--tx3)]">
                Permission changes need approval in Nessie after the executor connects.
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
        ) : (
          <p className="text-xs text-[color:var(--tx3)]">This executor is not paired with this Nessie Desktop device.</p>
        )}

        {error ? <p className="text-xs text-[color:var(--danger-text)]">{error}</p> : null}
      </section>
    </>
  )
}
