import type { PreparedExecutorAccessChangeResponse } from '@nessie/schemas'
import { useState } from 'react'
import type { ExecutorAccessViewWithLocalMcp } from '../../../facades/executors/local-mcp'
import { usePrepareExecutorAccessChange } from '../../../facades/executors/hooks'
import { FormError } from '../../shared/FormActions'
import { ExecutorPermissionDetails } from './ExecutorReviewedPolicy'
import { ExecutorLocalMcpPanel } from './ExecutorLocalMcpPanel'

export const ExecutorPermissionsPanel = ({ access, onPrepared }: {
  access: ExecutorAccessViewWithLocalMcp
  onPrepared: (prepared: PreparedExecutorAccessChangeResponse) => void
}) => {
  const prepare = usePrepareExecutorAccessChange()
  const [error, setError] = useState<string | null>(null)
  // A newer proposal supersedes every older version, including rows still
  // labelled active or pending in history. Only this version is actionable.
  const latest = [...(access.descriptorRevisions ?? [])].sort((a, b) => b.revision - a.revision)[0]
  const review = async (status: 'active' | 'disabled') => {
    if (!latest) return
    setError(null)
    try {
      onPrepared(await prepare.mutateAsync({
        executorId: access.executorId,
        change: { kind: 'descriptor_review', revision: latest.revision, status },
      }))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The change could not be opened.') }
  }
  if (!latest) return <p className="text-sm text-[color:var(--tx2)]">The machine has not sent its permissions yet.</p>
  const pending = latest.reviewStatus === 'pending_review'
  const active = latest.reviewStatus === 'active'
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[color:var(--tx2)]">
          {pending ? 'The machine is waiting for you to approve these changes.'
            : active ? 'Agents you add can use these permissions.' : 'These permissions are disabled.'}
        </p>
        {access.canManage && (pending || active) ? (
          <button className={`admin-button ${pending ? 'admin-button-primary' : 'admin-button-secondary'}`}
            disabled={prepare.isPending} onClick={() => void review(pending ? 'active' : 'disabled')} type="button">
            {pending ? 'Review changes' : 'Disable permissions'}
          </button>
        ) : null}
      </div>
      <FormError>{error}</FormError>
      <ExecutorPermissionDetails revision={latest} />
      <ExecutorLocalMcpPanel descriptorRevisions={[latest]} localMcp={access.localMcp} />
    </div>
  )
}
