import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { FormEvent, RefObject } from 'react'

import type { MailboxDiscoveryResult } from '../../../lib/api-client'
import {
  isHighConfidenceDiscovery,
  isUsableEmailAddress,
  providerIcon,
} from './mailbox-onboarding'

type MailboxAddressStartProps = {
  address: string
  discovery: MailboxDiscoveryResult | null
  emailInput: RefObject<HTMLInputElement | null>
  error: string | null
  helpOpen: boolean
  isDiscovering: boolean
  onAddressChange: (value: string) => void
  onCancel: () => void
  onContinue: (event: FormEvent<HTMLFormElement>) => void
  onHelp: () => void
  onICloud: () => void
  onOtherProvider: () => void
  onProvider: (provider: 'google' | 'microsoft') => void
  pending: boolean
  /**
   * Providers this deployment can actually finish a connect for. `undefined`
   * while the answer is still loading: the rows stay enabled rather than
   * flickering to unavailable and back.
   */
  providerAvailability: Partial<Record<'google' | 'microsoft', boolean>>
}

/**
 * `unavailable` is a deployment fact, not a transient state, so the row says
 * so in place instead of disappearing: a person who expected Google here needs
 * to learn that this server has not been given the credentials for it.
 */
const ProviderRow = ({
  icon,
  label,
  onClick,
  unavailable = false,
}: {
  icon: string
  label: string
  onClick: () => void
  unavailable?: boolean
}) => (
  <button
    className={[
      'flex w-full items-center gap-3 border-b border-[color:var(--sep)] px-1 py-3 text-left',
      'last:border-b-0',
      unavailable ? 'cursor-not-allowed opacity-60' : '',
    ].join(' ')}
    disabled={unavailable}
    onClick={onClick}
    type="button"
  >
    <span
      aria-hidden="true"
      className={[
        'flex h-7 w-7 shrink-0 items-center justify-center rounded border',
        'border-[color:var(--sep)] text-base text-[color:var(--tx2)]',
      ].join(' ')}
    >
      <FontAwesomeIcon icon={providerIcon(icon)} />
    </span>
    <span className="font-medium text-[color:var(--tx)]">{label}</span>
    {unavailable ? (
      <span className="ml-auto text-xs text-[color:var(--tx3)]">Not set up on this server</span>
    ) : null}
  </button>
)

export const MailboxAddressStart = ({
  address,
  discovery,
  emailInput,
  error,
  helpOpen,
  isDiscovering,
  onAddressChange,
  onCancel,
  onContinue,
  onHelp,
  onICloud,
  onOtherProvider,
  onProvider,
  pending,
  providerAvailability,
}: MailboxAddressStartProps) => (
  <form className="grid gap-5" onSubmit={onContinue}>
    <p className="text-center text-sm text-[color:var(--tx2)]">Enter your email address</p>

    <div className="grid gap-2">
      <input
        autoCapitalize="none"
        autoComplete="email"
        className="admin-input text-base"
        inputMode="email"
        onChange={(event) => onAddressChange(event.target.value)}
        placeholder="name@company.com"
        ref={emailInput}
        type="email"
        value={address}
      />
      {discovery && isHighConfidenceDiscovery(discovery) ? (
        <p className="text-sm text-[color:var(--tx2)]">{discovery.ui.providerName} detected</p>
      ) : isDiscovering ? (
        <p className="text-sm text-[color:var(--tx3)]">Looking up secure settings…</p>
      ) : null}
    </div>

    <div className="flex justify-end">
      <button
        className="admin-button admin-button-primary"
        disabled={!isUsableEmailAddress(address) || pending}
        type="submit"
      >
        {pending ? 'Finding secure settings…' : 'Continue'}
      </button>
    </div>

    <div aria-hidden="true" className="flex items-center gap-3 text-xs text-[color:var(--tx3)]">
      <span className="h-px flex-1 bg-[color:var(--sep)]" />
      <span>or</span>
      <span className="h-px flex-1 bg-[color:var(--sep)]" />
    </div>

    <div>
      <p className="mb-1 text-sm text-[color:var(--tx2)]">Choose your provider</p>
      <ProviderRow
        icon="google"
        label="Google"
        onClick={() => onProvider('google')}
        unavailable={providerAvailability.google === false}
      />
      <ProviderRow
        icon="microsoft"
        label="Microsoft"
        onClick={() => onProvider('microsoft')}
        unavailable={providerAvailability.microsoft === false}
      />
      <ProviderRow icon="icloud" label="iCloud" onClick={onICloud} />
      <ProviderRow icon="generic" label="Other provider" onClick={onOtherProvider} />
    </div>

    {helpOpen ? (
      <p className="text-sm text-[color:var(--tx2)]">
        We look up secure settings first. If we cannot confirm them, you can enter your
        mail server settings yourself.
      </p>
    ) : null}
    {error ? <p className="text-sm text-[color:var(--danger-text)]">{error}</p> : null}
    <div className="flex items-center justify-between gap-3">
      <button className="text-sm text-[color:var(--tx2)] underline" onClick={onHelp} type="button">
        Help
      </button>
      <button className="admin-button admin-button-secondary" onClick={onCancel} type="button">
        Cancel
      </button>
    </div>
  </form>
)
