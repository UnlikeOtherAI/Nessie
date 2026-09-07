import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import type { AgentRecord } from '../../../lib/api-client'
import { browserCloudKeys } from '../../../facades/browser-cloud/keys'
import { useExecutors } from '../../../facades/executors/hooks'
import { useApiClient } from '../../../providers/ApiClientProvider'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError, FormSuccess } from '../../shared/FormActions'

type ImportState = 'pending' | 'importing' | 'imported' | 'failed' | 'unknown' | 'cancelled'
type ImportRecord = { errorCode: string | null; expiresAt: string; id: string; state: ImportState }
type Props = { agent: AgentRecord; onClose: () => void; open: boolean; threadId: string }

const exactHttpsOrigins = (value: string): string[] => value
  .split(/[\n,]/)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .flatMap((entry) => {
    try {
      const url = new URL(entry)
      return url.protocol === 'https:' && !url.username && !url.password
        && !url.port && url.origin === entry ? [entry] : []
    } catch {
      return []
    }
  })

/**
 * An online executor is not evidence that its signed Chrome helper is ready.
 * This shares the real import protocol. The person may create a short-lived
 * offer for their chosen executor, but the screen never treats that as proof
 * that Chrome, the helper, or Browserbase completed an import.
 */
export const ChromeCookieImportDialog = ({ agent, onClose, open, threadId }: Props) => {
  const apiClient = useApiClient()
  const executors = useExecutors()
  const [executorId, setExecutorId] = useState('')
  const [originsText, setOriginsText] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const origins = useMemo(() => exactHttpsOrigins(originsText), [originsText])
  const privateOnline = (executors.data ?? []).filter((executor) =>
    executor.scope.kind === 'private' && executor.status === 'online',
  )
  const create = useMutation({
    mutationFn: () => apiClient.post<ImportRecord>('/api/browser-cookie-imports', {
      agentId: agent.id, executorId, origins, threadId,
    }),
    onSuccess: (result) => setRequestId(result.id),
  })
  const status = useQuery<ImportRecord>({
    enabled: requestId !== null,
    queryKey: browserCloudKeys.cookieImport(requestId ?? undefined),
    queryFn: () => apiClient.get('/api/browser-cookie-imports/' + requestId),
    refetchInterval: (query) => {
      const state = query.state.data?.state
      return state === 'pending' || state === 'importing' ? 2_000 : false
    },
  })
  const cancel = useMutation({
    mutationFn: () => apiClient.delete<void>('/api/browser-cookie-imports/' + requestId),
    onSuccess: () => void status.refetch(),
  })
  const canRequest = executorId !== '' && origins.length > 0 && !create.isPending
  const active = status.data?.state === 'pending' || status.data?.state === 'importing'
  const expiresAt = status.data?.expiresAt ?? create.data?.expiresAt ?? null
  const secondsLeft = expiresAt === null ? null : Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000))
  useEffect(() => {
    if (!active) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])

  return (
    <Dialog
      description="Chrome asks for its own per-site consent. Nessie never receives your Chrome profile."
      onClose={onClose}
      open={open}
      size="lg"
      title="Import selected Chrome sign-ins"
    >
      <div className="grid gap-4 p-4">
        <div className="grid gap-1 text-sm text-[color:var(--tx2)]">
          <span>Destination: <strong className="text-[color:var(--tx)]">{agent.name}</strong> in its private home.</span>
          <span>Retention: selected cookies stay in this private browser until you reset or revoke them.</span>
          <span>Request expiry: five minutes. Only the sites below are offered to Chrome.</span>
        </div>
        <label className="grid gap-1 text-sm text-[color:var(--tx)]">
          Private executor
          <select className="admin-input" disabled={active || privateOnline.length === 0} onChange={(event) => setExecutorId(event.target.value)} value={executorId}>
            <option value="">Select your private executor</option>
            {privateOnline.map((executor) => <option key={executor.id} value={executor.id}>{executor.label}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm text-[color:var(--tx)]">
          Exact HTTPS sites
          <textarea className="admin-input min-h-24" disabled={active} onChange={(event) => setOriginsText(event.target.value)} placeholder={'https://accounts.example.com\nhttps://app.example.com'} value={originsText} />
          <span className="text-xs text-[color:var(--tx3)]">One exact origin per line, up to 20. Redirects and other sites are not selected here.</span>
        </label>
        <p className="text-sm text-[color:var(--tx2)]">
          The helper is not verified by Nessie yet. After requesting, open the installed Chrome
          extension on this private executor. If it is not installed or does not respond, cancel
          this five-minute request and sign in manually instead.
        </p>
        {active && secondsLeft !== null ? (
          <p className="text-sm text-[color:var(--tx2)]">
            Waiting for Chrome helper · expires in {Math.floor(secondsLeft / 60)}:
            {String(secondsLeft % 60).padStart(2, '0')}.
          </p>
        ) : null}
        {status.data?.state === 'imported' ? <FormSuccess>Selected Chrome cookies were imported into this private browser.</FormSuccess> : null}
        {status.data?.state === 'failed' || status.data?.state === 'unknown' ? (
          <FormError>The import did not complete{status.data.errorCode ? ' (' + status.data.errorCode + ')' : ''}. You can refresh after checking the helper.</FormError>
        ) : null}
        <FormError>{create.error instanceof Error ? create.error.message : null}</FormError>
        <FormActions>
          {active ? <button className="admin-button admin-button-danger" disabled={cancel.isPending} onClick={() => cancel.mutate()} type="button">{cancel.isPending ? 'Cancelling…' : 'Cancel import'}</button> : null}
          <button className="admin-button admin-button-secondary" onClick={onClose} type="button">Close</button>
          <button className="admin-button admin-button-primary" disabled={!canRequest} onClick={() => create.mutate()} type="button">{create.isPending ? 'Requesting…' : 'Request Chrome import'}</button>
        </FormActions>
      </div>
    </Dialog>
  )
}
