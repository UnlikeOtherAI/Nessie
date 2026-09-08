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
import {
  openExternalAuthorizationUrl,
  usesExternalUrlShell,
} from '../../../lib/open-external-url'

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

/**
 * iOS WebViews do not consistently expose `navigator.clipboard`, even for a
 * direct tap. Keep the fallback in the click gesture so the platform is still
 * allowed to put the device code on the pasteboard.
 */
const copyToClipboard = async (value: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const field = document.createElement('textarea')
  field.setAttribute('readonly', '')
  field.style.cssText = 'left:-9999px;position:fixed;top:0'
  field.value = value
  document.body.appendChild(field)
  field.select()
  const copied = document.execCommand('copy')
  field.remove()
  if (!copied) throw new Error('The browser denied clipboard access.')
}

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
  // React Query builds a fresh result object on every render, so a mutation in
  // a dependency array re-runs its effect on every render. That is what turned
  // the abandon-on-unmount cleanup below into a cancel storm — it tombstoned
  // the flow one render after starting it, and each cancel re-rendered into
  // the next, until React gave up with "maximum update depth exceeded" and the
  // whole page fell to the router's error boundary. The three effects here are
  // lifecycle events — start once, poll while waiting, abandon on unmount — so
  // they reach the mutations through this ref and depend on none of them.
  const links = useRef({ cancel: cancelLink, poll: pollLink, start: startLink })
  useEffect(() => {
    links.current = { cancel: cancelLink, poll: pollLink, start: startLink }
  })

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    links.current.start
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
  }, [provider.key, subscriptionId])

  const poll = useCallback(async (start: DeviceStart) => {
    const result = await links.current.poll.mutateAsync(start.stateToken)
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
  }, [])

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
    if (token) void links.current.cancel.mutateAsync(token).catch(() => undefined)
  }, [])

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

  const copyCode = async (userCode: string) => {
    try {
      await copyToClipboard(userCode)
      setCopied(true)
    } catch {
      // A WebView can deny the modern API even while supporting the legacy
      // user-gesture copy command. The code stays visible either way, so a
      // denied clipboard permission never changes the dialog's layout.
      setCopied(false)
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
            <div className="flex flex-wrap items-center gap-2">
              <code className="shrink-0 whitespace-nowrap rounded-[var(--radius-md)] bg-[color:var(--overlay)] px-3 py-2 text-lg font-semibold tracking-[0.2em] text-[color:var(--tx1)]">
                {phase.start.userCode}
              </code>
              <button
                className="admin-button admin-button-secondary admin-button-compact min-w-[6.5rem] shrink-0 whitespace-nowrap"
                onClick={() => void copyCode(phase.start.userCode)}
                type="button"
              >
                {copied ? 'Copied' : 'Copy code'}
              </button>
            </div>
            <a
              className="admin-button admin-button-primary admin-button-compact self-start"
              href={phase.start.verificationUriComplete ?? phase.start.verificationUri}
              onClick={(event) => {
                if (!usesExternalUrlShell()) return
                event.preventDefault()
                void openExternalAuthorizationUrl(
                  phase.start.verificationUriComplete ?? phase.start.verificationUri,
                )
              }}
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
