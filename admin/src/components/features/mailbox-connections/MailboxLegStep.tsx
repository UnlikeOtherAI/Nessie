import type { FormEvent } from 'react'

import type { MailboxLegDiagnosis } from '../../../lib/api-client'
import { FormError } from '../../shared/FormActions'
import { MAILBOX_LEG_LABEL, type MailboxLeg } from './mailbox-onboarding'
import { MailboxTechnicalDetails } from './MailboxTechnicalDetails'

type MailboxLegStepProps = {
  error: string | null
  host: string
  leg: MailboxLeg
  onAdvanced: () => void
  onBack: () => void
  onConnect: (event: FormEvent<HTMLFormElement>) => void
  onHostChange: (value: string) => void
  onPortChange: (value: string) => void
  pending: boolean
  port: string
  /** The leg that resolved, so the screen can say what already works. */
  working: MailboxLegDiagnosis
  technicalDetails: string[]
}

/**
 * The third rung: the one server still missing.
 *
 * Reached only when the other leg resolved — the password is therefore known to
 * be right and the working endpoint is known, so there is exactly one thing
 * left to learn. Showing the whole advanced form here would ask somebody to
 * re-enter six settings we have already proven, and invite them to break the
 * half that works.
 *
 * The port is optional on purpose. Leaving it empty re-runs the sweep against
 * the host given here, which is usually all that was wrong; a port typed in is
 * used exactly as given. There is no security dropdown because each of these
 * ports has one secure transport, and choosing the other is never what somebody
 * meant.
 */
export const MailboxLegStep = ({
  error,
  host,
  leg,
  onAdvanced,
  onBack,
  onConnect,
  onHostChange,
  onPortChange,
  pending,
  port,
  technicalDetails,
  working,
}: MailboxLegStepProps) => {
  const { direction, does, protocol } = MAILBOX_LEG_LABEL[leg]
  const other = MAILBOX_LEG_LABEL[leg === 'imap' ? 'smtp' : 'imap']
  return (
    <form className="grid gap-5" onSubmit={onConnect}>
      <div className="grid gap-1">
        <h3 className="text-lg font-semibold text-[color:var(--tx)]">
          {direction} mail server
        </h3>
        <p className="text-sm text-[color:var(--tx2)]">
          Your password is right and {other.direction.toLowerCase()} mail is working
          {working.host ? ` on ${working.host}` : ''}. We could not find the {protocol} server
          that {does} — enter it and we will try again.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-sm sm:col-span-2">
          <span className="text-[color:var(--tx2)]">{direction} server ({protocol})</span>
          <input
            autoCapitalize="none"
            autoFocus
            className="admin-input"
            onChange={(event) => onHostChange(event.target.value)}
            placeholder={`${leg}.company.com`}
            required
            value={host}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-[color:var(--tx2)]">Port</span>
          <input
            className="admin-input"
            inputMode="numeric"
            onChange={(event) => onPortChange(event.target.value)}
            placeholder="Automatic"
            value={port}
          />
        </label>
      </div>
      <p className="text-xs text-[color:var(--tx3)]">
        Leave the port empty and we will try the standard {protocol} ports for you.
      </p>

      {error ? (
        <div className="grid gap-1">
          <FormError>{error}</FormError>
          <MailboxTechnicalDetails lines={technicalDetails} />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button className="admin-button admin-button-primary" disabled={pending} type="submit">
          {pending ? 'Connecting…' : 'Connect'}
        </button>
        <button className="admin-button admin-button-secondary" onClick={onAdvanced} type="button">
          Enter all settings
        </button>
        <button className="admin-button admin-button-secondary" onClick={onBack} type="button">
          Back
        </button>
      </div>
    </form>
  )
}
