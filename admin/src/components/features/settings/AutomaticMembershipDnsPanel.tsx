/**
 * The DNS record an administrator publishes to prove they control a domain.
 *
 * Rendered as a `<dl>` because it is a set of name/value pairs, which is what a
 * screen reader should hear, and the copy button announces through
 * `role="status"` so a keyboard user knows the copy happened.
 */

import { useEffect, useRef, useState } from 'react'
import type { AutomaticMembershipDomainRecord } from '@nessie/schemas'

import { Notice } from '../../primitives/Notice'

type Props = {
  domain: AutomaticMembershipDomainRecord
  onVerify: () => void
  onRotate: () => void
  pending: boolean
  canManage: boolean
}

const Row = ({ label, value }: { label: string; value: string }) => {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    }
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused; the value is on screen and selectable,
      // so there is nothing to recover from and nothing worth alarming about.
    }
  }

  return (
    <div className="grid gap-1 sm:grid-cols-[8rem_1fr_auto] sm:items-center sm:gap-3">
      <dt className="text-xs uppercase tracking-wide text-[color:var(--tx3)]">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-xs text-[color:var(--tx)]">{value}</dd>
      <dd className="justify-self-start sm:justify-self-end">
        <button
          className="admin-button admin-button-secondary admin-button-sm"
          onClick={() => void copy()}
          type="button"
        >
          {copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
        </button>
      </dd>
    </div>
  )
}

export const AutomaticMembershipDnsPanel = ({
  canManage,
  domain,
  onRotate,
  onVerify,
  pending,
}: Props) => {
  const waitingForSecond = domain.status === 'pending' && Boolean(domain.firstSeenAt)

  return (
    <div className="grid gap-3 border-t border-[color:var(--border)] pt-3">
      <p className="text-sm text-[color:var(--tx2)]">
        Add this TXT record to your DNS, then check it. We need to see it twice, at least ten
        minutes apart, before switching anything on — one lookup is not proof. Check again
        yourself after the wait; nothing re-checks an unproven domain on its own.
      </p>
      <dl className="grid gap-2">
        <Row label="Name" value={domain.recordName} />
        {domain.recordValue ? <Row label="Value" value={domain.recordValue} /> : null}
      </dl>
      {waitingForSecond ? (
        <Notice role="status" size="sm" tone="info">
          Found once. Check again in about ten minutes to confirm it.
        </Notice>
      ) : null}
      {domain.lastCheckOutcome && domain.lastCheckOutcome !== 'match' && domain.lastCheckDetail ? (
        <Notice role="status" size="sm" tone="warning">
          {domain.lastCheckDetail}
        </Notice>
      ) : null}
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <button
            className="admin-button admin-button-primary admin-button-sm"
            disabled={pending}
            onClick={onVerify}
            type="button"
          >
            {pending ? 'Checking…' : 'Check DNS now'}
          </button>
          <button
            className="admin-button admin-button-secondary admin-button-sm"
            disabled={pending}
            onClick={onRotate}
            type="button"
          >
            Issue a new record
          </button>
        </div>
      ) : null}
    </div>
  )
}
