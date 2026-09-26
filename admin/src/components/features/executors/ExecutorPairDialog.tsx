import { useEffect, useState } from 'react'
import { ApiClientError } from '@nessie/client-core'
import type { ExecutorPairingPreview, ExecutorScope } from '@nessie/schemas'
import type { ProjectRecord } from '../../../lib/api-client'
import { getBaseUrl, getExecutorApiOrigin } from '../../../lib/api-client'
import { isDesktopApp } from '../../../lib/desktop'
import {
  cancelCompanionPairing, confirmCompanionPairing, executorCompanionStatus, startCompanionPairing,
} from '../../../lib/executor-companion'
import {
  useClaimExecutorPairing,
  useExecutorPairingOptions,
  useExecutorPairingStatus,
  usePreviewExecutorPairing,
} from '../../../facades/executors/pairing'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { ExecutorPairingReview } from './ExecutorPairingReview'

type ExecutorPairDialogProps = {
  initialAudience?: 'personal' | 'team'
  fixedProjectId?: string
  onClose: () => void
  onFinished: (executorId: string) => void
  open: boolean
  projects: ProjectRecord[]
}

// Mount each opening afresh: a dismissed code must never reappear on reopening.
export const ExecutorPairDialog = (props: ExecutorPairDialogProps) =>
  props.open ? <PairingSession {...props} /> : null

const PairingSession = ({
  fixedProjectId, initialAudience, onClose, onFinished, projects,
}: ExecutorPairDialogProps) => {
  const options = useExecutorPairingOptions(true)
  const previewMutation = usePreviewExecutorPairing()
  const claimMutation = useClaimExecutorPairing()
  const [code, setCode] = useState('')
  const [preview, setPreview] = useState<ExecutorPairingPreview | null>(null)
  const [executorId, setExecutorId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const [canPairHere, setCanPairHere] = useState(false)
  const [localPairing, setLocalPairing] = useState(false)
  const [localBusy, setLocalBusy] = useState(false)
  const status = useExecutorPairingStatus(executorId)
  const remaining = preview ? Math.max(0, Math.ceil((Date.parse(preview.expiresAt) - now) / 1_000)) : 0
  const paired = status.data !== undefined && !['pending_pairing', 'revoked'].includes(status.data.status)
  const rejected = status.data?.status === 'revoked'
  const busy = localBusy || previewMutation.isPending || claimMutation.isPending

  useEffect(() => {
    if (!isDesktopApp()) return
    let active = true
    void executorCompanionStatus().then((companion) => {
      if (active) setCanPairHere(companion.platform !== 'macos'
        && ['available', 'workspace_only'].includes(companion.availability))
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  const pairHere = async () => {
    setLocalBusy(true)
    setError(null)
    try {
      const localCode = await startCompanionPairing(getExecutorApiOrigin(getBaseUrl()))
      setLocalPairing(true)
      setCode(localCode)
      setPreview(await previewMutation.mutateAsync(localCode))
      setNow(Date.now())
    } catch {
      setError('Pairing could not start. Update Nessie Desktop, then choose a workspace folder and try again.')
    } finally { setLocalBusy(false) }
  }

  const confirmHere = async () => {
    setLocalBusy(true)
    setError(null)
    try { await confirmCompanionPairing() } catch {
      setError('The connection is not confirmed. Review it in the computer confirmation dialog and try again.')
    } finally { setLocalBusy(false) }
  }

  const close = async () => {
    if (localPairing && !paired) await cancelCompanionPairing().catch(() => undefined)
    onClose()
  }

  useEffect(() => {
    if (!preview || paired) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [paired, preview])

  const lookup = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      setPreview(await previewMutation.mutateAsync(code))
      setNow(Date.now())
    } catch (cause) {
      setError(cause instanceof ApiClientError && cause.status === 429
        ? 'Too many attempts. Wait a few minutes, then try again.'
        : 'That code could not be checked. Check the eight digits on your computer and try again.')
    }
  }

  const claim = async (input: { label: string; scope: ExecutorScope; teamId: string | null }) => {
    if (!preview) return
    setError(null)
    try {
      const result = await claimMutation.mutateAsync({ code, fingerprint: preview.fingerprint, ...input })
      setExecutorId(result.executorId)
      setCode('')
      previewMutation.reset()
      claimMutation.reset()
      if (localPairing) await confirmHere()
    } catch (cause) {
      setError(cause instanceof ApiClientError && cause.status === 429
        ? 'Too many attempts. Wait a few minutes, then try again.'
        : 'Pairing could not be completed. Try again. If the code has expired, get a new one from your computer.')
    }
  }

  const restart = () => {
    setPreview(null)
    setExecutorId(null)
    setCode('')
    setError(null)
    previewMutation.reset()
    claimMutation.reset()
  }

  return (
    <Dialog
      description={!preview ? 'Paste the pairing code from the computer you want to connect.' : undefined}
      dismissDisabled={busy}
      onClose={() => void close()}
      open
      title={paired ? 'Computer paired' : executorId ? 'Confirm on your computer' : 'Pair a computer'}
    >
      <div className="grid gap-4">
        {!preview ? (
          <form className="grid gap-4" onSubmit={(event) => void lookup(event)}>
            <div className="grid gap-2 text-sm text-[color:var(--tx2)]">
              <p>Open Nessie Executor on Windows or Mac, choose <strong>Add team</strong>, select a folder, then
                choose <strong>Get pairing code</strong>.</p>
              <p>For the CLI, run this on the computer you want to connect:</p>
              <code className="break-all rounded bg-[var(--overlay-weak)] p-3 text-xs">
                nessie-executor login --api {getExecutorApiOrigin(getBaseUrl())} --workspace &quot;/path/to/folder&quot;
              </code>
              <p>Paste the eight-digit code below, then confirm this team on the computer. Folder and command
                permissions stay on that computer; you manage team access in Nessie.</p>
            </div>
            {canPairHere ? (
              <button className="admin-button admin-button-secondary" disabled={busy} onClick={() => void pairHere()} type="button">
                {localBusy ? 'Connecting…' : 'Connect this computer'}
              </button>
            ) : null}
            <label className="grid gap-2 text-sm font-medium text-[color:var(--tx2)]">
              Eight-digit code
              <input
                autoComplete="one-time-code"
                className="admin-input text-center font-mono text-2xl tracking-[0.3em]"
                inputMode="numeric"
                maxLength={8}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, '').slice(0, 8))
                  setError(null)
                }}
                pattern="[0-9]{8}"
                required
                value={code}
              />
            </label>
            <FormError>{error}</FormError>
            <FormActions>
              <button className="admin-button admin-button-secondary" onClick={() => void close()} type="button">Cancel</button>
              <button className="admin-button admin-button-primary" disabled={busy || code.length !== 8} type="submit">
                {busy ? 'Checking…' : 'Continue'}
              </button>
            </FormActions>
          </form>
        ) : executorId ? (
          <>
            <p className="text-sm text-[color:var(--tx2)]" role="status">
              {paired
                ? `${preview.machineName} is paired. You can now manage its access and allowed work.`
                : rejected
                  ? 'Pairing was declined on the computer. Start again when you are ready.'
                  : remaining === 0
                    ? 'The code has expired. Start pairing again on your computer to get a new one.'
                    : `Confirm the organisation and team in Nessie Executor on ${preview.machineName}.`}
            </p>
            <FormError>{status.isError ? 'Unable to check pairing. Check your connection, then try again.' : null}</FormError>
            <FormError>{error}</FormError>
            <FormActions>
              <button className="admin-button admin-button-secondary" onClick={() => void close()} type="button">Close</button>
              {localPairing && !paired && !rejected && remaining > 0 ? (
                <button className="admin-button admin-button-primary" disabled={busy} onClick={() => void confirmHere()} type="button">
                  Confirm connection
                </button>
              ) : null}
              {paired ? (
                <button className="admin-button admin-button-primary" onClick={() => onFinished(executorId)} type="button">
                  Open computer
                </button>
              ) : rejected || remaining === 0 ? (
                <button className="admin-button admin-button-primary" onClick={restart} type="button">Enter a new code</button>
              ) : status.isError ? (
                <button className="admin-button admin-button-primary" onClick={() => void status.refetch()} type="button">Try again</button>
              ) : null}
            </FormActions>
          </>
        ) : remaining === 0 ? (
          <>
            <p className="text-sm text-[color:var(--tx2)]">The code has expired. Get a new code from Nessie Executor.</p>
            <button className="admin-button admin-button-primary" onClick={restart} type="button">Enter a new code</button>
          </>
        ) : options.data ? (
          <ExecutorPairingReview
            busy={busy}
            error={error}
            fixedProjectId={fixedProjectId}
            initialAudience={initialAudience}
            onBack={restart}
            onClaim={(input) => void claim(input)}
            options={options.data}
            preview={preview}
            projects={projects}
            remaining={remaining}
          />
        ) : (
          <>
            <p className="text-sm text-[color:var(--tx2)]">{options.isError ? 'Your teams could not be loaded.' : 'Loading your teams…'}</p>
            {options.isError ? (
              <button className="admin-button admin-button-secondary" onClick={() => void options.refetch()} type="button">Try again</button>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  )
}
