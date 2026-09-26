import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { PreparedExecutorAccessChangeResponse } from '@nessie/schemas'
import { ExecutorDesktopCompanionPanel } from '../components/features/executors/ExecutorDesktopCompanionPanel'
import { ExecutorDetailPanels } from '../components/features/executors/ExecutorDetailPanels'
import { ExecutorPairingPendingNotice } from '../components/features/executors/ExecutorPairingPendingNotice'
import { ExecutorAccessChangeDialog } from '../components/features/executors/ExecutorReviewDialogs'
import { LocalInferenceHostStatus } from '../components/features/local-inference/LocalInferenceHostStatus'
import { EXECUTOR_STATUS_LABELS, executorScopeSummary, executorStatusTone } from '../components/features/executors/executor-presentation'
import { Pill } from '../components/primitives/Pill'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import type { PageHeaderMenuItem } from '../components/shared/ResponsivePageHeader'
import { Dialog } from '../components/shared/Dialog'
import { FormError } from '../components/shared/FormActions'
import { useExecutorAccess, useExecutors, usePrepareExecutorAccessChange } from '../facades/executors/hooks'
import { useLocalInferenceHosts } from '../facades/local-inference/hooks'
import { COMPUTERS_PATH } from '../navigation/computers'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { useShellEnvironment } from '../providers/ShellEnvironmentProvider'

/** One machine, its agent roster, current permissions and recent work. */
export const ExecutorDetailPage = () => {
  const { token, me } = useAuthSession()
  return <ExecutorDetailContent token={token} teamId={me?.context.teamId} />
}

export const ExecutorDetailContent = ({ token, teamId }: { token: string | null; teamId?: string }) => {
  const navigate = useNavigate()
  const { executorId } = useParams<{ executorId?: string }>()
  const shell = useShellEnvironment()
  const executorsQuery = useExecutors()
  const executor = (executorsQuery.data ?? []).find((candidate) => candidate.id === executorId)
  const accessQuery = useExecutorAccess(executorId)
  const access = accessQuery.data?.executorId === executorId ? accessQuery.data : undefined
  const localModels = useLocalInferenceHosts()
  const prepare = usePrepareExecutorAccessChange()
  const [prepared, setPrepared] = useState<PreparedExecutorAccessChangeResponse | null>(null)
  const [panel, setPanel] = useState<'models' | 'device' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const backToList = () => void navigate(COMPUTERS_PATH)
  const lifecycle = async (action: 'pause' | 'resume' | 'revoke' | 'remove') => {
    if (!executorId) return
    setError(null)
    try { setPrepared(await prepare.mutateAsync({ executorId, change: { kind: 'lifecycle', action } })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The change could not be opened.') }
  }
  if (!executor) return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader backLabel="Back to Computers" onBack={backToList} title="Computer" />
      <QueryState className="flex flex-1 items-center justify-center" emptyLabel="This executor could not be found, or it is no longer visible to you."
        errorLabel="Executors could not be loaded." isEmpty loadingLabel="Loading executor…" query={executorsQuery}>{() => null}</QueryState>
    </div>
  )
  const menu: PageHeaderMenuItem[] = []
  if (shell.runtime === 'tauri') menu.push({ id: 'device', label: 'On this computer', onSelect: () => setPanel('device') })
  if (localModels.data?.hosts.some((host) => host.executorId === executor.id)) {
    menu.push({ id: 'models', label: 'Local models', onSelect: () => setPanel('models') })
  }
  if (access?.canManage) {
    if (executor.status === 'paused') {
      menu.push({ id: 'resume', label: 'Resume executor', disabled: prepare.isPending, onSelect: () => void lifecycle('resume') })
    } else if (['online', 'offline', 'error'].includes(executor.status)) {
      menu.push({ id: 'pause', label: 'Pause executor', disabled: prepare.isPending, onSelect: () => void lifecycle('pause') })
    }
    if (!['revoked', 'pending_pairing'].includes(executor.status)) {
      menu.push({ id: 'disconnect', label: 'Disconnect executor', disabled: prepare.isPending, onSelect: () => void lifecycle('revoke') })
    }
    // Any state, pending pairing and already disconnected included: it is the
    // only way a machine leaves this list.
    menu.push({ id: 'delete', label: 'Delete executor', disabled: prepare.isPending, onSelect: () => void lifecycle('remove') })
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader backLabel="Back to Computers" eyebrow="Computers" onBack={backToList} title={executor.label}
        actions={menu.length ? [{ id: 'machine', kind: 'menu', label: 'Machine', priority: 20, items: menu }] : []}
        subtitle={<div className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--tx3)]">
          <Pill height="control" tone={executorStatusTone(executor.status)} uppercase={false}>{EXECUTOR_STATUS_LABELS[executor.status]}</Pill>
          <span>{executorScopeSummary(executor)}</span>
          {executor.status === 'offline' && executor.lastSeenAt ? <time dateTime={executor.lastSeenAt}>Last connected {new Date(executor.lastSeenAt).toLocaleString()}</time> : null}
        </div>}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-4">
        <div className="grid gap-4">
          <FormError>{error}</FormError>
          {executor.status === 'error' && executor.statusDetail ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{executor.statusDetail}</p> : null}
          {executor.status === 'pending_pairing' ? <ExecutorPairingPendingNotice /> : null}
          <ExecutorDetailPanels teamId={teamId} accessQuery={accessQuery} executor={executor}
            onPrepared={setPrepared} token={token} />
        </div>
      </div>
      {panel === 'models' ? <Dialog onClose={() => setPanel(null)} open title="Local models">
        <LocalInferenceHostStatus confirmInDialog
          empty={<p>No local model connection on this machine.</p>} executorId={executor.id} />
      </Dialog> : null}
      {panel === 'device' ? <Dialog onClose={() => setPanel(null)} open size="lg" title="On this computer">
        <ExecutorDesktopCompanionPanel executorId={executor.id} />
      </Dialog> : null}
      {prepared ? <ExecutorAccessChangeDialog
        accessChangeId={prepared.accessChangeId} confirmationToken={prepared.confirmationToken}
        {...(prepared.executorId === access?.executorId && access.descriptorRevisions
          ? { descriptorRevisions: access.descriptorRevisions } : {})}
        onClose={() => setPrepared(null)}
        onConfirmed={(change) => { if (change.kind === 'lifecycle' && change.action === 'remove') backToList() }}
        open /> : null}
    </div>
  )
}
