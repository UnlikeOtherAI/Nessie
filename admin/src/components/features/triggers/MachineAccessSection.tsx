import type { PreparedStandingPolicyResponse, PresentedAgentCardBlock } from '@nessie/schemas'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { formErrorMessage } from '../../../facades/forms/form-errors'
import { useEndStandingPolicy, useTriggerMachineAccess } from '../../../facades/standing-policies/hooks'
import type { AgentTriggerDeliveryRecord } from '../../../lib/api-client'
import { AgentCardBlocks } from '../channels/AgentCardBlocks'
import { ChatCardShell } from '../channels/ChatCardShell'
import { ExecutorAccessChangeDialog } from '../executors/ExecutorReviewDialogs'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { FormError } from '../../shared/FormActions'
import { QueryState } from '../../shared/QueryState'
import { ticketDeliveryLine } from '../ticket-work/ticket-work-presentation'
import { MachineAccessSetupDialog } from './MachineAccessSetupDialog'
import {
  MACHINE_ACCESS_STATE_LABEL,
  MACHINE_ACCESS_STATE_TONE,
  machineAccessLimitsLine,
  machineAccessStateLine,
  machineAccessTicketLine,
} from './machine-access-presentation'
import { formatTimestamp } from './trigger-presentation'

/**
 * A ticket trigger's Machine access section on its page
 * (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "Screens";
 * docs/standards/ticket-work-machine-access.md → "What the screens show").
 *
 * Its state in one sentence; for the trigger's author, "Set up machine
 * access…", which prepares the one card and shows it here to review and
 * confirm with their password; End, for the author or an administrator of one
 * of its machines; every live ticket and its place; and the last wakes, in
 * the words the deliveries say them. Anyone else reads the state and is told
 * who can set it up. A machine is named only to those who may know it.
 */

const LAST_WAKES = 5

const noop = () => {}

export const MachineAccessSection = ({
  deliveries,
  triggerId,
}: {
  deliveries: readonly AgentTriggerDeliveryRecord[]
  triggerId: string
}) => {
  const query = useTriggerMachineAccess(triggerId)
  const end = useEndStandingPolicy()
  const [setupOpen, setSetupOpen] = useState(false)
  const [prepared, setPrepared] = useState<PreparedStandingPolicyResponse | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [endError, setEndError] = useState<string | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const { hash } = useLocation()
  const loaded = Boolean(query.data)
  // The bell item that asks its author to set it up opens it here.
  useEffect(() => {
    if (hash === '#machine-access' && loaded) sectionRef.current?.scrollIntoView({ block: 'start' })
  }, [hash, loaded])
  const wakes = deliveries
    .map((delivery) => ({ at: delivery.createdAt, id: delivery.id, line: ticketDeliveryLine(delivery.payload) }))
    .filter((wake): wake is { at: string; id: string; line: string } => wake.line !== null)
    .slice(0, LAST_WAKES)

  return (
    <section data-testid="machine-access-section" id="machine-access" ref={sectionRef}>
      <SectionLabel>Machine access</SectionLabel>
      <QueryState className="mt-3" errorLabel="Machine access could not be loaded." loadingLabel="Loading…" query={query}>
        {() => {
          const view = query.data!
          const owner = view.author?.name ?? 'the person who set it up'
          const policy = view.policy
          const limits = policy ? machineAccessLimitsLine(policy.limits) : null
          const canSetUp = view.viewerIsAuthor && view.state !== 'awaiting_confirmation'
          return (
            <div className="mt-3 grid gap-3 rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Pill radius="chip" size="sm" tone={MACHINE_ACCESS_STATE_TONE[view.state]} uppercase={false}>
                  {MACHINE_ACCESS_STATE_LABEL[view.state]}
                </Pill>
                <span className="text-xs text-[color:var(--tx3)]">Set up by {owner}</span>
              </div>
              <p className="text-sm text-[color:var(--tx2)]" data-testid="machine-access-state">{machineAccessStateLine(view)}</p>
              {limits && view.state !== 'ended' ? (
                <p className="text-xs text-[color:var(--tx3)]">
                  Limits: {limits}.{policy?.allowAnyCommand ? ' The coding agent may run any command without asking.' : ''}
                </p>
              ) : null}
              {view.state === 'live' || view.state === 'suspended' ? (
                <p className="text-xs text-[color:var(--tx3)]">
                  The agent may drive Claude Code sessions on these machines; it gets no other program on them.
                </p>
              ) : null}
              {view.pendingCard ? (
                <p className="text-xs text-[color:var(--tx3)]">A newer card waits for {owner}’s confirmation.</p>
              ) : null}
              {!view.viewerIsAuthor && view.state !== 'live' ? (
                <p className="text-xs text-[color:var(--tx3)]" data-testid="machine-access-author-only">
                  Only {owner} can set this up: the work would run on their own machines, as them.
                </p>
              ) : null}

              {prepared ? (
                <ChatCardShell testId="machine-access-card">
                  <p className="text-sm font-semibold text-[color:var(--tx)]">{prepared.card.title}</p>
                  <AgentCardBlocks
                    blocks={prepared.card.blocks as PresentedAgentCardBlock[]}
                    disabled
                    onSecretChange={noop}
                    onValueChange={noop}
                    providedSecretKeys={[]}
                    secrets={{}}
                    settled={false}
                    values={{}}
                  />
                  <div className="mt-2">
                    <button className="admin-button admin-button-primary" onClick={() => setReviewOpen(true)} type="button">
                      Review and confirm
                    </button>
                  </div>
                </ChatCardShell>
              ) : null}

              {canSetUp || policy?.viewerCanEnd ? (
                <div className="flex flex-wrap gap-2">
                  {canSetUp ? (
                    <button className="admin-button admin-button-secondary" onClick={() => setSetupOpen(true)} type="button">
                      {view.state === 'live' || view.state === 'suspended' ? 'Change machine access…' : 'Set up machine access…'}
                    </button>
                  ) : null}
                  {policy?.viewerCanEnd ? (
                    <button className="admin-button admin-button-danger" onClick={() => setConfirmEnd(true)} type="button">
                      End
                    </button>
                  ) : null}
                </div>
              ) : null}
              {view.viewerIsAuthor && view.state === 'awaiting_confirmation' && !prepared ? (
                <p className="text-xs text-[color:var(--tx3)]">
                  Confirm the card in your conversation with the Agent Designer, or{' '}
                  <button className="font-semibold text-[color:var(--lnk)] hover:underline" onClick={() => setSetupOpen(true)} type="button">
                    prepare it again here
                  </button>.
                </p>
              ) : null}
              <FormError>{endError}</FormError>

              {view.tickets.length > 0 ? (
                <div className="grid gap-1" data-testid="machine-access-tickets">
                  <div className="text-xs font-medium text-[color:var(--tx2)]">Tickets</div>
                  {view.tickets.map((ticket) => (
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm" key={ticket.workId}>
                      <Link
                        className="min-w-0 truncate font-medium text-[color:var(--lnk)] hover:underline"
                        to={`/projects/${ticket.projectId}/board?task=${encodeURIComponent(ticket.taskId)}`}
                      >
                        {ticket.title}
                      </Link>
                      <span className="text-xs text-[color:var(--tx3)]">{machineAccessTicketLine(ticket)}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {wakes.length > 0 ? (
                <div className="grid gap-1" data-testid="machine-access-wakes">
                  <div className="text-xs font-medium text-[color:var(--tx2)]">Last wakes</div>
                  {wakes.map((wake) => (
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs" key={wake.id}>
                      <span className="text-[color:var(--tx2)]">{wake.line}</span>
                      <span className="tabular-nums text-[color:var(--tx3)]">{formatTimestamp(wake.at)}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <ConfirmDialog
                body={`Ending it cancels the work of every ticket this trigger has working, queued or waiting, and closes `
                  + `their coding sessions. Nothing runs on ${owner}’s machines for it again until ${owner} sets it up `
                  + 'again with a new card.'}
                confirmLabel="End machine access"
                destructive
                onCancel={() => setConfirmEnd(false)}
                onConfirm={() => {
                  if (!policy) return
                  setEndError(null)
                  end.mutate({ policyId: policy.id }, {
                    onError: (error) => setEndError(formErrorMessage(error, 'Machine access could not be ended. Try again.')),
                    onSettled: () => setConfirmEnd(false),
                  })
                }}
                open={confirmEnd}
                pending={end.isPending}
                title="End machine access?"
              />
            </div>
          )
        }}
      </QueryState>
      {setupOpen ? (
        <MachineAccessSetupDialog
          onClose={() => setSetupOpen(false)}
          onPrepared={(next) => {
            setPrepared(next)
            setSetupOpen(false)
          }}
          open
          triggerId={triggerId}
        />
      ) : null}
      {prepared ? (
        <ExecutorAccessChangeDialog
          accessChangeId={prepared.accessChangeId}
          confirmationToken={prepared.confirmationToken}
          onClose={() => setReviewOpen(false)}
          onConfirmed={() => {
            setPrepared(null)
            void query.refetch()
          }}
          open={reviewOpen}
        />
      ) : null}
    </section>
  )
}
