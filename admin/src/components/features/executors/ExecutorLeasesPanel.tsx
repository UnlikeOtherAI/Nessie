import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ExecutorMachineLeaseRecord } from '@nessie/schemas'
import { useEndExecutorLease, useExecutorMachineLeases } from '../../../facades/executors/leases'
import { formErrorMessage } from '../../../facades/forms/form-errors'
import { useActorNames } from '../../shared/ActorName'
import { DataTable } from '../../shared/DataTable'
import { FormError } from '../../shared/FormActions'
import { QueryState } from '../../shared/QueryState'
import { executorLeaseUntil } from './executor-lease-presentation'

/** Mirrors the API's bound (`MACHINE_LEASE_LIMIT`), so a full list says so. */
const MACHINE_LEASE_LIMIT = 50

const Conversation = ({ lease }: { lease: ExecutorMachineLeaseRecord }) => lease.conversation.label
  ? <Link className="underline-offset-2 hover:underline" to={`/channels/${lease.conversation.channelId}`}>{lease.conversation.label}</Link>
  : <span className="text-[color:var(--tx3)]">A conversation you are not in</span>

/**
 * Who can still reach this machine through local apps, for the people who
 * manage it: a live conversation lease lets the person who started local apps
 * keep them for their own follow-ups in that conversation. End here is the
 * same End the holder has beside their composer; it stops future reach.
 *
 * The API names an agent or a conversation only when this reader could see
 * it themselves, so a missing name is a boundary, not a gap.
 */
export const ExecutorLeasesPanel = ({ executorId }: { executorId: string }) => {
  const query = useExecutorMachineLeases(executorId)
  const end = useEndExecutorLease()
  const nameOf = useActorNames()
  const [endError, setEndError] = useState<string | null>(null)
  const leases = query.data ?? []
  const endLease = (leaseId: string) => {
    setEndError(null)
    end.mutate(leaseId, {
      onError: (error) => setEndError(formErrorMessage(error, 'That lease could not be ended. Try again.')),
    })
  }
  return (
    <section aria-labelledby="executor-leases-heading" className="grid gap-3">
      <div className="grid gap-1">
        <h2 className="text-sm font-semibold text-[color:var(--tx)]" id="executor-leases-heading">Local apps in use</h2>
        <p className="text-sm text-[color:var(--tx3)]">
          A person who starts local apps in a conversation keeps them for their own messages there
          until the lease ends. End stops any further use.
        </p>
      </div>
      <QueryState className="py-4" errorLabel="Local apps in use could not be loaded." loadingLabel="Loading local apps in use…" query={query}>
        {() => (
          <div className="grid gap-3">
            <FormError>{endError}</FormError>
            {leases.length === MACHINE_LEASE_LIMIT
              ? <p className="text-sm text-[color:var(--tx3)]">Showing the {MACHINE_LEASE_LIMIT} most recently used.</p>
              : null}
            <DataTable
              columns={[
                { key: 'agent', header: 'Agent', render: (row) => <div className="grid gap-1">
                  <span>{row.agent.name ?? 'An agent you cannot see'}</span>
                  <span className="grid gap-1 text-xs text-[color:var(--tx3)] sm:hidden">
                    <span>{nameOf('user', row.holderUserId).name}</span>
                    <Conversation lease={row} />
                  </span>
                </div> },
                { key: 'conversation', header: 'Conversation', secondary: true, render: (row) => <Conversation lease={row} /> },
                { key: 'person', header: 'Person', secondary: true, render: (row) => {
                  const holder = nameOf('user', row.holderUserId)
                  return <span title={holder.id}>{holder.name}</span>
                } },
                { key: 'used', header: 'Last used', secondary: true, render: (row) => <div className="grid gap-1">
                  <time dateTime={row.lastUsedAt}>{new Date(row.lastUsedAt).toLocaleString()}</time>
                  <span className="text-xs text-[color:var(--tx3)]">until {executorLeaseUntil(row.expiresAt)}</span>
                </div> },
                { key: 'end', header: '', width: '1px', render: (row) => (
                  <button
                    aria-label={`End local apps for ${nameOf('user', row.holderUserId).name}`}
                    className="admin-button admin-button-secondary"
                    disabled={end.isPending}
                    onClick={() => endLease(row.id)}
                    type="button"
                  >
                    End
                  </button>
                ) },
              ]}
              empty={<p className="py-6 text-center text-sm text-[color:var(--tx3)]">Nobody is using local apps on this machine.</p>}
              expandable={false}
              label="Local apps in use"
              rowKey={(row) => row.id}
              rows={leases}
            />
          </div>
        )}
      </QueryState>
    </section>
  )
}
