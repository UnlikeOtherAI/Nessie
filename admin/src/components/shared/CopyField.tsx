import { useCallback, useEffect, useState } from 'react'
import { SectionLabel } from '../primitives/SectionLabel'

/**
 * A value a person is meant to copy rather than read — a webhook endpoint, an
 * API key, a session id.
 *
 * Promoted out of `TriggerDetail`, which was the only surface that had built
 * one. Everywhere else the same values sit in a disabled `.admin-input`, which
 * looks like a field somebody forgot to enable and offers no way to take the
 * value except selecting it by hand.
 *
 * Copying is reported in place and reverts after two seconds: a person needs
 * to know the click did something, and a permanent "Copied" would go stale the
 * moment they copy anything else.
 */

type CopyFieldProps = {
  className?: string
  label: string
  /** Shown instead of the value — for a secret that must stay masked. */
  masked?: boolean
  value: string
}

export const CopyField = ({ className, label, masked = false, value }: CopyFieldProps) => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 2_000)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = useCallback(() => {
    // `navigator.clipboard` is absent over plain HTTP and in some shells; a
    // failed copy must leave the value on screen rather than claim success.
    void navigator.clipboard?.writeText(value).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }, [value])

  return (
    <div className={['grid gap-1.5', className ?? ''].filter(Boolean).join(' ')}>
      <SectionLabel size="sm">{label}</SectionLabel>
      <div className="flex items-center gap-2">
        <code
          className={[
            'min-w-0 flex-1 truncate rounded-md border border-[color:var(--sep)]',
            'bg-[color:var(--overlay-weak)] px-2 py-1.5 font-mono text-xs text-[color:var(--tx)]',
          ].join(' ')}
        >
          {masked ? '•'.repeat(Math.min(value.length, 32)) : value}
        </code>
        <button
          className="admin-button admin-button-secondary admin-button-compact"
          onClick={copy}
          type="button"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
