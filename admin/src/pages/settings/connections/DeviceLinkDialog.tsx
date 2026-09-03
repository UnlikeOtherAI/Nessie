import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useCancelDeviceLink,
  useConfirmDeviceLink,
  usePollDeviceLink,
  useStartDeviceLink,
  type DeviceStart,
  type ModelSubscriptionProviderOption,
} from '../../../facades/subscriptions/hooks'
import { Dialog } from '../../../components/shared/Dialog'
import { renderFieldError } from '../../../components/shared/FormFieldError'

/**
 * Device-code sign-in for Codex and Grok.
 *
 * Three states, in order: the code to enter, the account that signed in, done.
 * The middle one is not a formality — it is the whole defence against the
 * device-flow confused deputy, where somebody else enters your code and their
 * account would otherwise be attached to your team silently. So the person
 * is shown WHICH account arrived and has to say it is theirs.
 */
type Phase =
  | { kind: 'starting' }
  | { kind: 'waiting'; start: DeviceStart }
  | { kind: 'confirm'; start: DeviceStart; accountId: string; accountLabel?: string }
  | { kind: 'error'; message: string }

export const DeviceLinkDialog = ({
  onClose,
  provider,
  subscriptionId,
}: {
  onClose: () => void
  provider: ModelSubscriptionProviderOption
  subscriptionId?: string
}) => {
  const startLink = useStartDeviceLink()
  const pollLink = usePollDeviceLink()
  const confirmLink = useConfirmDeviceLink()
  const cancelLink = useCancelDeviceLink()
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
  const [copied, setCopied] = useState(false)
  // Held in a ref as well as state so the unmount cleanup can abandon the flow
  // without re-running the effect every time the phase changes.
  const stateTokenRef = useRef<string | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    startLink
      .mutateAsync({
        provider: provider.key,
        ...(subscriptionId ? { subscriptionId } : {}),
      })
      .then((start) => {
        stateTokenRef.current = start.stateToken
        setPhase({ kind: 'waiting', start })
      })
      .catch((error: unknown) => {
        setPhase({
          kind: 'error',
          message: error instanceof Error ? error.message : 'The sign-in could not be started.',
        })
      })
  }, [provider.key, startLink, subscriptionId])

  const poll = useCallback(async (start: DeviceStart) => {
    const result = await pollLink.mutateAsync(start.stateToken)
    if (result.status === 'awaiting_confirmation') {
      setPhase({
        accountId: result.accountId,
        ...(result.accountLabel ? { accountLabel: result.accountLabel } : {}),
        kind: 'confirm',
        start,
      })
      return true
    }
    if (result.status === 'denied') {
      setPhase({ kind: 'error', message: result.reason })
      return true
    }
    if (result.status === 'expired') {
      setPhase({ kind: 'error', message: 'The sign-in code expired. Start again.' })
      return true
    }
    return false
  }, [pollLink])

  useEffect(() => {
    if (phase.kind !== 'waiting') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      if (cancelled) return
      try {
        const settled = await poll(phase.start)
        if (settled || cancelled) return
      } catch (error) {
        if (cancelled) return
        setPhase({
          kind: 'error',
          message: error instanceof Error ? error.message : 'The sign-in could not be checked.',
        })
        return
      }
      // The server holds the real lease and honours the provider's interval;
      // this is only how often the client asks the server.
      timer = setTimeout(() => void tick(), Math.max(phase.start.intervalMs, 2000))
    }

    timer = setTimeout(() => void tick(), Math.max(phase.start.intervalMs, 2000))
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [phase, poll])

  // Abandoning the dialog abandons the flow: the parked credential is
  // tombstoned rather than left waiting for a confirmation that never comes.
  useEffect(() => () => {
    const token = stateTokenRef.current
    if (token) void cancelLink.mutateAsync(token).catch(() => undefined)
  }, [cancelLink])

  const dismiss = () => {
    onClose()
  }

  const confirm = async () => {
    if (phase.kind !== 'confirm') return
    try {
      await confirmLink.mutateAsync(phase.start.stateToken)
      stateTokenRef.current = null
      onClose()
    } catch (error) {
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : 'The sign-in could not be completed.',
      })
    }
  }

  return (
    <Dialog onClose={dismiss} open title={`Connect ${provider.displayName}`}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[color:var(--tx2)]">{provider.termsNote}</p>

        {phase.kind === 'starting' ? (
          <p className="text-sm text-[color:var(--tx3)]">Starting sign-in…</p>
        ) : null}

        {phase.kind === 'waiting' ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[color:var(--tx1)]">
              Open the link below and enter this code. You can do it on any device.
            </p>
            <div className="flex items-center gap-3">
              <code className="rounded-[var(--radius-md)] bg-[color:var(--overlay)] px-3 py-2 text-lg font-semibold tracking-[0.2em] text-[color:var(--tx1)]">
                {phase.start.userCode}
              </code>
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                onClick={() => {
                  void navigator.clipboard?.writeText(phase.start.userCode)
                  setCopied(true)
                }}
                type="button"
              >
                {copied ? 'Copied' : 'Copy code'}
              </button>
            </div>
            <a
              className="admin-button admin-button-primary admin-button-compact self-start"
              href={phase.start.verificationUriComplete ?? phase.start.verificationUri}
              rel="noopener noreferrer"
              target="_blank"
            >
              Open sign-in page
            </a>
            <p className="text-xs text-[color:var(--tx3)]">
              Only enter a code you started here. Waiting for you to finish…
            </p>
          </div>
        ) : null}

        {phase.kind === 'confirm' ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[color:var(--tx1)]">
              Signed in as{' '}
              <strong>{phase.accountLabel ?? phase.accountId}</strong>.
            </p>
            <p className="text-xs text-[color:var(--tx3)]">
              Confirm only if this is your own account. Your agents will run on
              its plan.
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                onClick={dismiss}
                type="button"
              >
                Cancel
              </button>
              <button
                className="admin-button admin-button-primary admin-button-compact"
                disabled={confirmLink.isPending}
                onClick={() => void confirm()}
                type="button"
              >
                {confirmLink.isPending ? 'Connecting…' : 'Yes, connect it'}
              </button>
            </div>
          </div>
        ) : null}

        {phase.kind === 'error' ? (
          <>
            {renderFieldError('device-link', phase.message)}
            <div className="flex justify-end">
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                onClick={dismiss}
                type="button"
              >
                Close
              </button>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  )
}
