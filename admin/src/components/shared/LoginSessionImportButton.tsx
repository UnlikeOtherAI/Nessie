import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getBaseUrl } from '../../lib/api-client'
import { parseSessionDebugImport, SessionDebugImportError } from '../../lib/session-debug-import'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { SessionDebugDialog, SessionDebugIcon } from './SessionDebugDialog'

type LoginSessionImportButtonProps = {
  label?: string
  onOpenChange?: (open: boolean) => void
  variant?: 'floating' | 'inline'
}

export const LoginSessionImportButton = ({
  label,
  onOpenChange,
  variant = 'floating',
}: LoginSessionImportButtonProps) => {
  const { t } = useTranslation('common')
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
        if (submitError instanceof SessionDebugImportError) {
          const errorCopy = {
            missingDump: t('sessionDebug.errors.missingDump'),
            oversizedDump: t('sessionDebug.errors.oversizedDump'),
            invalidJson: t('sessionDebug.errors.invalidJson'),
            missingToken: t('sessionDebug.errors.missingToken'),
            wrongServer: t('sessionDebug.errors.wrongServer'),
            unusableToken: t('sessionDebug.errors.unusableToken'),
            conflictingTokens: t('sessionDebug.errors.conflictingTokens'),
          }
          setError(errorCopy[submitError.code])
        } else {
          setError(t('sessionDebug.importFailed'))
        }
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
        aria-label={variant === 'floating' ? t('sessionDebug.importJson') : undefined}
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
        title={variant === 'floating' ? t('sessionDebug.importJson') : undefined}
        type="button"
      >
        <SessionDebugIcon />
        {variant === 'inline' ? <span>{label ?? t('sessionDebug.useOtherDevice')}</span> : null}
      </button>

      <SessionDebugDialog
        actionDisabled={!rawDump.trim()}
        actionLabel={t('sessionDebug.signInWithSession')}
        description={t('sessionDebug.importDescription')}
        error={error}
        onAction={handleImport}
        onChange={(value) => {
          setRawDump(value)
          if (error) setError(null)
        }}
        onClose={handleClose}
        open={open}
        pending={pending}
        pendingLabel={t('sessionDebug.checking')}
        textareaLabel={t('sessionDebug.importJsonLabel')}
        title={t('sessionDebug.importTitle')}
        value={rawDump}
      />
    </>
  )
}
