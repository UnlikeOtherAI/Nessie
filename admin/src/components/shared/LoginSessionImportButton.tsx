import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getBaseUrl } from '../../lib/api-client'
import { parseSessionDebugImport } from '../../lib/session-debug-import'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { SessionDebugDialog, SessionDebugIcon } from './SessionDebugDialog'

type LoginSessionImportButtonProps = {
  label?: string
  onOpenChange?: (open: boolean) => void
  variant?: 'floating' | 'inline'
}

export const LoginSessionImportButton = ({
  label = 'Use session from another device',
  onOpenChange,
  variant = 'floating',
}: LoginSessionImportButtonProps) => {
  const navigate = useNavigate()
  const { importAccessToken } = useAuthSession()
  const [open, setOpen] = useState(false)
  const [rawDump, setRawDump] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const submittingRef = useRef(false)

  const handleOpen = (): void => {
    setRawDump('')
    setError(null)
    setOpen(true)
    onOpenChange?.(true)
  }

  const handleClose = useCallback((): void => {
    if (pending) return
    setOpen(false)
    setRawDump('')
    setError(null)
    onOpenChange?.(false)
  }, [onOpenChange, pending])

  const handleImport = (): void => {
    if (submittingRef.current) return
    submittingRef.current = true
    setError(null)
    setPending(true)

    void (async () => {
      try {
        const { accessToken } = parseSessionDebugImport(
          rawDump,
          getBaseUrl() || window.location.origin,
        )
        await importAccessToken(accessToken)
        setRawDump('')
        setOpen(false)
        onOpenChange?.(false)
        void navigate('/channels', { replace: true })
      } catch (submitError) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : 'This session could not be imported.',
        )
      } finally {
        submittingRef.current = false
        setPending(false)
      }
    })()
  }

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={variant === 'floating' ? 'Import session JSON' : undefined}
        className={variant === 'floating'
          ? [
              'fixed z-40 flex h-11 w-11 items-center justify-center rounded-xl',
              'border border-[color:var(--line)] bg-[color:var(--panel)]',
              'text-[color:var(--muted)] shadow-lg transition',
              'hover:bg-[color:var(--overlay-strong)] hover:text-[color:var(--tx)]',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]',
            ].join(' ')
          : [
              'flex w-full items-center justify-center gap-2 rounded-2xl',
              'border border-[var(--line)] bg-[color:var(--overlay)] px-5 py-3',
              'text-sm font-medium text-[var(--muted)] transition',
              'hover:bg-[color:var(--overlay-strong)] hover:text-[color:var(--tx)]',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]',
            ].join(' ')}
        onClick={handleOpen}
        style={variant === 'floating' ? {
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)',
          right: 'calc(env(safe-area-inset-right, 0px) + 1rem)',
        } : undefined}
        title={variant === 'floating' ? 'Import session JSON' : undefined}
        type="button"
      >
        <SessionDebugIcon />
        {variant === 'inline' ? <span>{label}</span> : null}
      </button>

      <SessionDebugDialog
        actionDisabled={!rawDump.trim()}
        actionLabel="Sign in with session"
        description="Paste JSON copied from Session debug on another signed-in device. This is a bearer credential; only its access token is used, and it stops when that token expires."
        error={error}
        onAction={handleImport}
        onChange={(value) => {
          setRawDump(value)
          if (error) setError(null)
        }}
        onClose={handleClose}
        open={open}
        pending={pending}
        pendingLabel="Checking session..."
        textareaLabel="Session debug JSON to import"
        title="Import session"
        value={rawDump}
      />
    </>
  )
}
