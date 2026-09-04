import { useState } from 'react'

import type { MailboxConnectionRecord, MailboxConnectionScope } from '../../../lib/api-client'
import { connectionAnchorId } from '../../../lib/connection-anchor'
import {
  useDisconnectMailbox,
  useMailboxConnections,
  useTestMailboxConnection,
} from '../../../facades/mailbox-connections/hooks'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { EmptyState } from '../../shared/EmptyState'
import { FormError } from '../../shared/FormActions'
import { QueryState } from '../../shared/QueryState'
import { MailboxAgentAccess } from './MailboxAgentAccess'
import { MailboxConnectionForm } from './MailboxConnectionForm'

/**
 * One panel, both homes: a person's own mailboxes on their connections page and
 * a team's shared mailboxes on Integrations. The scope is a parameter, not a
 * second component — the two would otherwise drift on status copy, on what a
 * disconnect warns about, and on who may see the agent-access rows.
 */

type MailboxConnectionsPanelProps = {
  embedded?: boolean
  scope: MailboxConnectionScope
  showConnectAction?: boolean
}

const SCOPE_COPY: Record<
  MailboxConnectionScope,
  { title: string; blurb: string; empty: string; disconnectBody: string }
> = {
  team: {
    blurb:
      'Connect a shared mailbox — support@, hello@, an alias a team already uses — and '
      + 'choose which agents may work in it. They read and reply live; nothing is copied '
      + 'into Nessie.',
    disconnectBody:
      'Agents will lose access to this mailbox immediately. Nothing in the mailbox itself '
      + 'is touched.',
    empty: 'No shared mailboxes are connected for any team yet.',
    title: 'Shared mailboxes',
  },
  user: {
    blurb:
      'These generic mailboxes are accessed live over IMAP and SMTP. Nothing is copied '
      + 'into Nessie, and only runs acting as you can reach a personal mailbox.',
    disconnectBody:
      'Your agents will lose access to this mailbox immediately. Nothing in the mailbox '
      + 'itself is touched.',
    empty: 'No live IMAP mailboxes are connected yet.',
    title: 'Live IMAP mailboxes',
  },
}

const STATUS_TONE = {
  active: 'success',
  disabled: 'muted',
  needs_reauthorization: 'warning',
} as const

const STATUS_LABEL = {
  active: 'Connected',
  disabled: 'Switched off',
  needs_reauthorization: 'Needs reconnecting',
} as const

const ConnectionRow = ({ connection }: { connection: MailboxConnectionRecord }) => {
  const test = useTestMailboxConnection()
  const disconnect = useDisconnectMailbox()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  return (
    <div
      className="border-t border-[color:var(--sep)] pt-3 first:border-t-0 first:pt-0"
      id={connectionAnchorId(connection.id)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-[color:var(--tx)]">{connection.label}</p>
          <p className="text-sm text-[color:var(--tx2)]">
            {connection.address} · Secure IMAP and SMTP
          </p>
          {connection.statusReason ? (
            <p className="mt-1 text-sm text-[color:var(--danger)]">{connection.statusReason}</p>
          ) : null}
          {result ? <p className="mt-1 text-sm text-[color:var(--tx2)]">{result}</p> : null}
        </div>
        <Pill tone={STATUS_TONE[connection.status]}>{STATUS_LABEL[connection.status]}</Pill>
      </div>

      <div className="mt-2 flex gap-2">
        <button
          className="admin-button admin-button-secondary admin-button-compact"
          disabled={test.isPending}
          onClick={() => {
            setError(null)
            setResult(null)
            test.mutate(connection.id, {
              onError: (cause: unknown) =>
                setError(cause instanceof Error ? cause.message : 'Could not test the mailbox.'),
              onSuccess: (outcome) => setResult(outcome.detail),
            })
          }}
          type="button"
        >
          {test.isPending ? 'Testing…' : 'Test'}
        </button>
        <button
          className="admin-button admin-button-danger admin-button-compact"
          onClick={() => setConfirming(true)}
          type="button"
        >
          Disconnect
        </button>
      </div>

      {/* Shown for a personal mailbox too: a connection nobody's agent may use
          does nothing, and the person who connected it is the one who decides. */}
      <div className="mt-3">
        <SectionLabel>Agents with access</SectionLabel>
        <div className="mt-2">
          <MailboxAgentAccess connection={connection} />
        </div>
      </div>

      <FormError className="mt-2">{error}</FormError>

      <ConfirmDialog
        body={SCOPE_COPY[connection.scope].disconnectBody}
        confirmLabel="Disconnect"
        destructive
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          disconnect.mutate(connection.id, {
            onError: (cause: unknown) => {
              setError(cause instanceof Error ? cause.message : 'Could not disconnect.')
              setConfirming(false)
            },
            onSuccess: () => setConfirming(false),
          })}
        open={confirming}
        pending={disconnect.isPending}
        title={`Disconnect ${connection.label}?`}
      />
    </div>
  )
}

export const MailboxConnectionsPanel = ({
  embedded = false,
  scope,
  showConnectAction = true,
}: MailboxConnectionsPanelProps) => {
  const connections = useMailboxConnections()
  const copy = SCOPE_COPY[scope]
  const rows = (connections.data?.connections ?? []).filter((row) => row.scope === scope)

  return (
    <section
      aria-label={copy.title}
      className={embedded ? 'grid gap-4' : 'admin-card p-4'}
      id={`mailbox-connections-${scope}`}
    >
      {!embedded ? (
        <>
          <SectionLabel>Connected mailboxes</SectionLabel>
          <h2 className="mt-3 font-semibold text-[color:var(--tx)]">{copy.title}</h2>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--tx2)]">{copy.blurb}</p>
        </>
      ) : null}

      <div className={embedded ? '' : 'mt-4'}>
        <QueryState
          errorLabel="Could not load connected mailboxes."
          loadingLabel="Loading mailboxes…"
          query={connections}
        >
          {() =>
            rows.length === 0 ? (
              <EmptyState title="No mailbox connected">{copy.empty}</EmptyState>
            ) : (
              <div className="grid gap-4">
                {rows.map((connection) => (
                  <ConnectionRow connection={connection} key={connection.id} />
                ))}
              </div>
            )}
        </QueryState>
      </div>

      {showConnectAction ? <MailboxConnectionForm scope={scope} /> : null}
    </section>
  )
}
