import { useState } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import { useEndExecutorLease, useOwnExecutorLeases } from '../../../facades/executors/leases'
import { formErrorMessage } from '../../../facades/forms/form-errors'
import { Pill } from '../../primitives/Pill'
import { FormError } from '../../shared/FormActions'
import { executorLeaseDescription, executorLeaseLabel } from './executor-lease-presentation'

type ExecutorLeaseProps = {
  agents: readonly Pick<AgentRecord, 'id' | 'name'>[]
  threadId: string
}

const END_FAILED = 'Local apps could not be ended. Try again.'

const agentNameOf = (agents: ExecutorLeaseProps['agents'], agentId: string): string | null =>
  agents.find((agent) => agent.id === agentId)?.name ?? null

/**
 * End for the leases shown here, with its failure kept beside the lease it
 * was for: an End that silently did nothing would leave the person believing
 * the machine is out of reach while it is not.
 */
const useEndLease = () => {
  const end = useEndExecutorLease()
  const [failed, setFailed] = useState<{ leaseId: string; message: string } | null>(null)
  return {
    end: (leaseId: string) => {
      setFailed(null)
      end.mutate(leaseId, {
        onError: (error) => setFailed({ leaseId, message: formErrorMessage(error, END_FAILED) }),
      })
    },
    failureFor: (leaseId: string) => (failed?.leaseId === leaseId ? failed.message : null),
    pending: end.isPending,
  }
}

/**
 * The composer's holder-only reminder that the machine is still in reach:
 * "Minis · local apps · until 21:40 · End", beside Run on executor.
 *
 * It sits in the toolbar, so the composer at rest stays one line; and it
 * renders only what `GET /api/executor-leases` returned, which for anyone but
 * the holder is nothing. Where the toolbar has no room for it (a phone), the
 * stylesheet folds it into a dot on Run on executor, and the launcher dialog
 * carries the same lease with its End.
 */
export const ExecutorLeaseIndicator = ({ agents, threadId }: ExecutorLeaseProps) => {
  const { data: leases = [] } = useOwnExecutorLeases(threadId)
  const { end, failureFor, pending } = useEndLease()
  const severalAgents = new Set(leases.map((lease) => lease.agentId)).size > 1
  return (
    <>
      {leases.map((lease) => {
        const agentName = agentNameOf(agents, lease.agentId)
        const failure = failureFor(lease.id)
        return (
          <Pill
            className="admin-compose-lease gap-1.5"
            data-testid="executor-lease-indicator"
            height="control"
            key={lease.id}
            radius="chip"
            title={failure ?? executorLeaseDescription(lease, agentName)}
            tone={failure ? 'danger' : 'accent'}
            uppercase={false}
          >
            <span className="admin-compose-lease-label" role={failure ? 'alert' : undefined}>
              {failure ?? executorLeaseLabel(lease, severalAgents ? agentName : null)}
            </span>
            <button
              aria-label={`End local apps on ${lease.executorLabel}`}
              className="admin-compose-lease-end"
              disabled={pending}
              onClick={() => end(lease.id)}
              type="button"
            >
              End
            </button>
          </Pill>
        )
      })}
    </>
  )
}

/**
 * The same leases at the top of the launcher, where a person who starts local
 * apps again is about to replace one — and the one place a phone, whose
 * toolbar has no room for the indicator, can read and end it.
 */
export const ExecutorLeaseLauncherNotice = ({ agents, threadId }: ExecutorLeaseProps) => {
  const { data: leases = [] } = useOwnExecutorLeases(threadId)
  const { end, failureFor, pending } = useEndLease()
  if (leases.length === 0) return null
  return (
    <div className="grid gap-2 border-b border-[color:var(--sep)] pb-3" data-testid="executor-lease-launcher-notice">
      {leases.map((lease) => (
        <div className="grid gap-2" key={lease.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 flex-1 text-sm text-[color:var(--tx2)]">
              {executorLeaseDescription(lease, agentNameOf(agents, lease.agentId))}
            </p>
            <button
              aria-label={`End local apps on ${lease.executorLabel}`}
              className="admin-button admin-button-secondary"
              disabled={pending}
              onClick={() => end(lease.id)}
              type="button"
            >
              End
            </button>
          </div>
          <FormError>{failureFor(lease.id)}</FormError>
        </div>
      ))}
    </div>
  )
}
