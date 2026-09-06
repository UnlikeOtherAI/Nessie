import type { FormEvent } from 'react'

import type {
  MailboxConnectionScope,
  MailboxDiscoveryResult,
  TeamRecord,
} from '../../../lib/api-client'
import { FormError } from '../../shared/FormActions'
import {
  commsOAuthProvider,
  connectorMethodLabel,
  appPasswordAccountName,
  appPasswordPageUrl,
  hasTrustedMailboxConfiguration,
  unavailableAuthenticationMessage,
  type MailboxOnboardingStep,
} from './mailbox-onboarding'
import { MailboxConnectionIdentityFields } from './MailboxConnectionIdentityFields'
import { MailboxTechnicalDetails } from './MailboxTechnicalDetails'

type MailboxDiscoveryResolutionProps = {
  address: string
  error: string | null
  label: string
  onBack: () => void
  onClose: () => void
  onConfirmProvider: () => void
  onConnect: (event: FormEvent<HTMLFormElement>) => void
  onExisting: () => void
  onLabelChange: (value: string) => void
  onManual: () => void
  onPasswordChange: (value: string) => void
  onTeamChange: (value: string) => void
  password: string
  pending: boolean
  result: MailboxDiscoveryResult | null
  scope: MailboxConnectionScope
  screen: MailboxOnboardingStep
  teamId: string
  teams: TeamRecord[]
  technicalDetails: string[]
}

/** One failure, one plain sentence, and the raw evidence folded away under it. */
const ResolutionError = ({
  error,
  technicalDetails,
}: {
  error: string | null
  technicalDetails: string[]
}) => {
  if (!error) return null
  return (
    <div className="grid gap-1">
      <FormError>{error}</FormError>
      <MailboxTechnicalDetails lines={technicalDetails} />
    </div>
  )
}

const AppPasswordGuidance = ({ result }: { result: MailboxDiscoveryResult }) => {
  const account = appPasswordAccountName(result)
  const url = appPasswordPageUrl(result)
  return (
    <p className="text-sm text-[color:var(--tx2)]">
      Create an app-specific password in your {account}, then paste it here.
      {url ? (
        <>
          {' '}
          <a
            className="text-[color:var(--lnk)] underline"
            href={url}
            rel="noreferrer noopener"
            target="_blank"
          >
            Open {account}
          </a>
        </>
      ) : null}
    </p>
  )
}

export const MailboxDiscoveryResolution = ({
  address,
  error,
  label,
  onBack,
  onClose,
  onConfirmProvider,
  onConnect,
  onExisting,
  onLabelChange,
  onManual,
  onPasswordChange,
  onTeamChange,
  password,
  pending,
  result,
  scope,
  screen,
  teamId,
  teams,
  technicalDetails,
}: MailboxDiscoveryResolutionProps) => {
  if (screen === 'existing') {
    return (
      <div className="grid gap-5 text-center">
        <p className="text-[color:var(--tx)]">This email account is already connected.</p>
        <div className="flex justify-center gap-2">
          <button className="admin-button admin-button-secondary" onClick={onClose} type="button">
            Close
          </button>
          <button className="admin-button admin-button-primary" onClick={onExisting} type="button">
            Open existing
          </button>
        </div>
      </div>
    )
  }
  if (!result) return null

  if (screen === 'confirmation') {
    const provider = commsOAuthProvider(result, scope)
    return (
      <div className="grid gap-5">
        <div className="grid gap-1">
          <h3 className="text-lg font-semibold text-[color:var(--tx)]">
            We found email services for {result.domain}
          </h3>
          <p className="text-sm text-[color:var(--tx2)]">Choose how you would like to connect.</p>
        </div>
        <button
          className="border-b border-[color:var(--sep)] pb-4 text-left"
          onClick={onConfirmProvider}
          type="button"
        >
          <span className="block font-medium text-[color:var(--tx)]">{result.ui.providerName}</span>
          <span className="text-sm text-[color:var(--tx2)]">
            {provider
              ? `Sign in securely with ${result.ui.providerName}`
              : connectorMethodLabel(result.preferredConnector.type)}
          </span>
        </button>
        <button className="text-left" onClick={onManual} type="button">
          <span className="block font-medium text-[color:var(--tx)]">Use different settings</span>
          <span className="text-sm text-[color:var(--tx2)]">Enter secure mail-server settings</span>
        </button>
        <ResolutionError error={error} technicalDetails={technicalDetails} />
        <button
          className="admin-button admin-button-secondary justify-self-start"
          onClick={onBack}
          type="button"
        >
          Back
        </button>
      </div>
    )
  }

  if (screen === 'shared-credential') {
    return (
      <div className="grid gap-5">
        <div className="grid gap-1">
          <h3 className="text-lg font-semibold text-[color:var(--tx)]">
            Email sign-in is unavailable
          </h3>
          <p className="text-sm text-[color:var(--tx2)]">
            {unavailableAuthenticationMessage(result)}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="admin-button admin-button-primary" onClick={onManual} type="button">
            Use advanced settings
          </button>
          <button className="admin-button admin-button-secondary" onClick={onBack} type="button">
            Back
          </button>
        </div>
      </div>
    )
  }

  if (screen !== 'password' || !hasTrustedMailboxConfiguration(result)) return null
  const appPassword = result.authentication.strategy === 'app_password'
  return (
    <form className="grid gap-5" onSubmit={onConnect}>
      <div className="grid gap-1">
        <h3 className="text-lg font-semibold text-[color:var(--tx)]">
          {appPassword ? 'Use an app-specific password' : `Sign in to ${result.ui.providerName}`}
        </h3>
        <p className="text-sm text-[color:var(--tx2)]">{address}</p>
        {appPassword ? <AppPasswordGuidance result={result} /> : null}
      </div>
      <MailboxConnectionIdentityFields
        label={label}
        onLabelChange={onLabelChange}
        onTeamChange={onTeamChange}
        scope={scope}
        teamId={teamId}
        teams={teams}
      />
      <label className="grid gap-1 text-sm">
        <span className="text-[color:var(--tx2)]">Password</span>
        <input
          autoComplete="current-password"
          className="admin-input"
          onChange={(event) => onPasswordChange(event.target.value)}
          required
          type="password"
          value={password}
        />
      </label>
      <ResolutionError error={error} technicalDetails={technicalDetails} />
      <div className="flex flex-wrap gap-2">
        <button
          className="admin-button admin-button-primary"
          disabled={pending || (scope === 'team' && !teamId)}
          type="submit"
        >
          {pending ? 'Connecting…' : 'Connect'}
        </button>
        <button className="admin-button admin-button-secondary" onClick={onManual} type="button">
          Use advanced settings
        </button>
        <button className="admin-button admin-button-secondary" onClick={onBack} type="button">
          Back
        </button>
      </div>
    </form>
  )
}
