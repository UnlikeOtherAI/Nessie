import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { AgentMailboxSendPolicy } from '@nessie/schemas'

import { Notice } from '../../primitives/Notice'
import {
  useAgentEmailConfig,
  useAgentMailbox,
  useCreateMailbox,
  useDeleteMailbox,
  useUpdateMailbox,
} from '../../../facades/agent-mailbox/hooks'
import { ConfirmDialog } from '../../shared/ConfirmDialog'

/**
 * The agent's Email section: claim an address, see its state, set how much the
 * agent may send on its own, and get into the mailbox.
 *
 * This is the doorway Rule zero asks for — the mailbox has its own page, but
 * this is the screen a person is standing on when the question "can this agent
 * have an email address" arises.
 */

const POLICY_COPY: Record<AgentMailboxSendPolicy, { label: string; detail: string }> = {
  approval: {
    detail: 'Every message waits for you before it leaves. Recommended.',
    label: 'Approve every send',
  },
  auto_reply: {
    detail:
      'Replies within an existing conversation send immediately. Starting a new '
      + 'conversation still waits for you.',
    label: 'Replies send automatically',
  },
  auto: {
    detail:
      'Every message sends immediately, including messages to people who have never '
      + 'written to this address.',
    label: 'Everything sends automatically',
  },
}

export const AgentEmailSection = ({
  agentId,
  canManage,
}: {
  agentId: string
  canManage: boolean
}) => {
  const configQuery = useAgentEmailConfig()
  const mailboxQuery = useAgentMailbox(agentId)
  const createMailbox = useCreateMailbox(agentId)
  const updateMailbox = useUpdateMailbox(agentId)
  const deleteMailbox = useDeleteMailbox(agentId)

  const [localPart, setLocalPart] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])

  const config = configQuery.data
  const mailbox = mailboxQuery.data

  if (configQuery.isLoading || mailboxQuery.isLoading) {
    return <p className="text-sm text-[color:var(--tx3)]">Loading email…</p>
  }

  // Unconfigured deployment. An owner is told exactly which variables are
  // missing; a member is told only that it is unavailable.
  if (config && !config.available) {
    return (
      <Notice tone="info">
        <p>Hosted email is not available on this deployment.</p>
        {config.reason && (
          <p className="mt-1 text-xs">
            {config.reason}
            {config.missing && config.missing.length > 0 && (
              <> Missing: <code>{config.missing.join('</code>, <code>')}</code>.</>
            )}
          </p>
        )}
      </Notice>
    )
  }

  if (!mailbox) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[color:var(--tx2)]">
          Give this agent its own email address. People can then write to it directly, and
          it can reply — with your approval by default.
        </p>
        {!canManage ? (
          <Notice tone="info">
            An organisation owner can give this agent an address.
          </Notice>
        ) : (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setError(null)
              setSuggestions([])
              createMailbox.mutate(
                { localPart: localPart.trim().toLowerCase() },
                {
                  onError: (mutationError) => {
                    const details = mutationError as {
                      message?: string
                      details?: { suggestions?: string[] }
                    }
                    setError(details.message ?? 'That address could not be claimed.')
                    setSuggestions(details.details?.suggestions ?? [])
                  },
                },
              )
            }}
          >
            <label className="flex items-center gap-2 text-sm" htmlFor="mailbox-local-part">
              <input
                autoComplete="off"
                className="w-48 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm"
                id="mailbox-local-part"
                onChange={(event) => setLocalPart(event.target.value)}
                placeholder="support"
                value={localPart}
              />
              <span className="text-[color:var(--tx3)]">@{config?.domain}</span>
            </label>
            <div>
              <button
                className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-[color:var(--accent-fg)] disabled:opacity-50"
                disabled={localPart.trim().length < 3 || createMailbox.isPending}
                type="submit"
              >
                {createMailbox.isPending ? 'Claiming…' : 'Claim address'}
              </button>
            </div>
            {error && (
              <Notice tone="danger">
                <p>{error}</p>
                {suggestions.length > 0 && (
                  <p className="mt-1 text-xs">Available: {suggestions.join(', ')}</p>
                )}
              </Notice>
            )}
          </form>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium text-[color:var(--tx1)]">{mailbox.address}</p>
        {mailbox.status === 'suspended' && mailbox.statusReason && (
          <Notice tone="danger">{mailbox.statusReason}</Notice>
        )}
        <Link
          className="mt-1 inline-flex text-sm text-[color:var(--lnk)] hover:underline"
          to={`/agents/${agentId}/mailbox`}
        >
          Open mailbox
        </Link>
      </div>

      <fieldset className="flex flex-col gap-2" disabled={!canManage}>
        <legend className="text-sm font-medium text-[color:var(--tx1)]">Sending</legend>
        {(Object.keys(POLICY_COPY) as AgentMailboxSendPolicy[]).map((policy) => (
          <label className="flex items-start gap-2 text-sm" key={policy}>
            <input
              checked={mailbox.sendPolicy === policy}
              className="mt-1"
              name="send-policy"
              onChange={() => updateMailbox.mutate({ sendPolicy: policy })}
              type="radio"
              value={policy}
            />
            <span>
              <span className="text-[color:var(--tx1)]">{POLICY_COPY[policy].label}</span>
              <span className="block text-xs text-[color:var(--tx3)]">
                {POLICY_COPY[policy].detail}
              </span>
            </span>
          </label>
        ))}
        <p className="text-xs text-[color:var(--tx3)]">
          Sending also needs the <code>email_send</code> tool granted to this agent on the
          Tools page. Whatever is set here, a message built from anything this agent could
          reach but its correspondent cannot always waits for you.
        </p>
      </fieldset>

      {canManage && (
        <div>
          <button
            className="text-sm text-[color:var(--danger-text)] hover:underline"
            onClick={() => setConfirmingDelete(true)}
            type="button"
          >
            Delete mailbox
          </button>
          <ConfirmDialog
            body={
              `${mailbox.address} will stop receiving mail and the address is retired `
              + 'permanently — it can never be claimed again, so nobody inherits this '
              + 'agent’s correspondents. The conversation history is kept, read-only.'
            }
            confirmLabel="Delete mailbox"
            destructive
            onCancel={() => setConfirmingDelete(false)}
            onConfirm={() => {
              deleteMailbox.mutate(undefined, { onSuccess: () => setConfirmingDelete(false) })
            }}
            open={confirmingDelete}
            pending={deleteMailbox.isPending}
            title="Delete this mailbox?"
          />
        </div>
      )}
    </div>
  )
}
