import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ExecutorStandingPolicyRow } from '@nessie/schemas'
import { triggerUrl } from '../../../facades/alerts/trigger-url'
import { formErrorMessage } from '../../../facades/forms/form-errors'
import { useEndStandingPolicy, useExecutorStandingPolicies } from '../../../facades/standing-policies/hooks'
import { Pill } from '../../primitives/Pill'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { DataTable } from '../../shared/DataTable'
import { FormError } from '../../shared/FormActions'
import { QueryState } from '../../shared/QueryState'
import {
  STANDING_ACCESS_STATE,
  standingAccessEndCopy,
  standingAccessStateLine,
  standingAccessTicketsLine,
} from './executor-standing-access-presentation'

type Row = ExecutorStandingPolicyRow

const Trigger = ({ row }: { row: Row }) => row.trigger
  ? <Link className="underline-offset-2 hover:underline" to={triggerUrl(row.trigger.id)}>{row.trigger.name}</Link>
  : <span className="text-[color:var(--tx3)]">A deleted trigger</span>

const agentOf = (row: Row) => row.agentName ?? 'An unnamed agent'

const State = ({ row }: { row: Row }) => {
  const state = STANDING_ACCESS_STATE[row.status]
  const line = standingAccessStateLine(row)
  return (
    <div className="grid justify-items-start gap-1">
      <Pill size="sm" tone={state.tone} uppercase={false}>{state.label}</Pill>
      {line ? <span className="text-xs text-[color:var(--tx3)]">{line}</span> : null}
    </div>
  )
}

const Tickets = ({ row }: { row: Row }) => (
  <span className={row.activeTickets === 0 ? 'text-[color:var(--tx3)]' : undefined}>
    {standingAccessTicketsLine(row.activeTickets)}
  </span>
)

/**
 * The ticket triggers whose work runs on this machine as the person who set
 * them up, for the people who administer it
 * (docs/standards/ticket-work-machine-access.md → "What the screens show").
 * Each one was confirmed once, by its author, and holds until it is ended —
 * by that author, by an administrator here, or by a fence. End here is the
 * same End the trigger's own Machine access section has: it cancels the
 * trigger's live tickets and closes their coding sessions on its machines.
 *
 * Only a private machine can carry standing access, so the page mounts this
 * for private machines alone.
 */
export const ExecutorStandingAccessPanel = ({ executorId }: { executorId: string }) => {
  const query = useExecutorStandingPolicies(executorId)
  const end = useEndStandingPolicy()
  // The row stays after the dialog closes so its words do not change while it fades out.
  const [ending, setEnding] = useState<Row | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [endError, setEndError] = useState<string | null>(null)
  const policies = query.data?.policies ?? []
  const askToEnd = (row: Row) => {
    setEnding(row)
    setConfirming(true)
  }
  const confirmEnd = () => {
    if (!ending) return
    setEndError(null)
    end.mutate({ policyId: ending.id, executorId }, {
      onError: (error) => setEndError(formErrorMessage(error, 'That standing access could not be ended. Try again.')),
      onSettled: () => setConfirming(false),
    })
  }
  const copy = ending ? standingAccessEndCopy(ending) : null
  const endButton = (row: Row) => row.viewerCanEnd && row.status !== 'ended' ? (
    <button
      aria-label={`End standing access for ${row.trigger?.name ?? 'a deleted trigger'}`}
      className="admin-button admin-button-secondary"
      disabled={end.isPending}
      onClick={() => askToEnd(row)}
      type="button"
    >
      End
    </button>
  ) : null
  return (
    <section aria-labelledby="executor-standing-access-heading" className="grid gap-3">
      <div className="grid gap-1">
        <h2 className="text-sm font-semibold text-[color:var(--tx)]" id="executor-standing-access-heading">
          Standing access
        </h2>
        <p className="text-sm text-[color:var(--tx3)]">
          Ticket triggers whose work runs on this machine as its owner, confirmed once.
        </p>
      </div>
      <QueryState
        className="py-4"
        errorLabel="Standing access could not be loaded."
        loadingLabel="Loading standing access…"
        query={query}
      >
        {() => (
          <div className="grid gap-3">
            <FormError>{endError}</FormError>
            <DataTable
              columns={[
                { key: 'trigger', header: 'Trigger', render: (row) => <div className="grid gap-1">
                  <Trigger row={row} />
                  <span className="text-xs text-[color:var(--tx3)]">set up by {row.authorName}</span>
                  {/* A phone keeps every fact, and End, in this one column. */}
                  <div className="grid justify-items-start gap-1 whitespace-normal text-xs text-[color:var(--tx3)] sm:hidden">
                    <span>{agentOf(row)}</span>
                    <State row={row} />
                    <Tickets row={row} />
                    {endButton(row)}
                  </div>
                </div> },
                { key: 'agent', header: 'Agent', secondary: true, render: (row) => <span>{agentOf(row)}</span> },
                { key: 'state', header: 'State', secondary: true, render: (row) => <State row={row} /> },
                { key: 'tickets', header: 'Tickets', secondary: true, render: (row) => <Tickets row={row} /> },
                { key: 'end', header: '', secondary: true, width: '1px', render: endButton },
              ]}
              empty={
                <p className="py-6 text-center text-sm text-[color:var(--tx3)]">No trigger’s work runs on this machine.</p>
              }
              expandable={false}
              label="Standing access"
              rowKey={(row) => row.id}
              rows={policies}
            />
          </div>
        )}
      </QueryState>
      <ConfirmDialog
        body={copy?.body}
        confirmLabel={copy?.confirmLabel ?? 'End standing access'}
        destructive
        onCancel={() => setConfirming(false)}
        onConfirm={confirmEnd}
        open={confirming}
        pending={end.isPending}
        title={copy?.title ?? 'End standing access?'}
      />
    </section>
  )
}
