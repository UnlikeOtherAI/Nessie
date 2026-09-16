import type { FormEvent } from 'react'

import type { MailboxConnectionScope, TeamRecord } from '../../../lib/api-client'
import { FormError } from '../../shared/FormActions'
import { MailboxConnectionIdentityFields } from './MailboxConnectionIdentityFields'
import { MailboxTechnicalDetails } from './MailboxTechnicalDetails'

type MailboxServerStepProps = {
  address: string
  error: string | null
  label: string
  onAdvanced: () => void
  onBack: () => void
  onConnect: (event: FormEvent<HTMLFormElement>) => void
  onLabelChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onServerChange: (value: string) => void
  onTeamChange: (value: string) => void
  onUsernameChange: (value: string) => void
  password: string
  pending: boolean
  scope: MailboxConnectionScope
  server: string
  teamId: string
  teams: TeamRecord[]
  technicalDetails: string[]
  username: string
}

/**
 * The second rung: one mail server, and nothing else.
 *
 * This is the screen that used to be the ten-field advanced form. Somebody who
 * knows where their mail lives knows a hostname — `mail.company.com` — and
 * essentially never knows which of IMAP's two ports and SMTP's three their
 * provider chose, or whether each wants TLS or STARTTLS. Asking for six values
 * to obtain one fact produced forms filled in by guesswork, so the server
 * resolves the rest by trying the standard endpoints on the host named here.
 *
 * Username is offered because it is the one thing that genuinely varies and
 * cannot be derived — plenty of servers want `person` rather than
 * `person@company.com` — but it stays optional and defaults to the address.
 */
export const MailboxServerStep = ({
  address,
  error,
  label,
  onAdvanced,
  onBack,
  onConnect,
  onLabelChange,
  onPasswordChange,
  onServerChange,
  onTeamChange,
  onUsernameChange,
  password,
  pending,
  scope,
  server,
  teamId,
  teams,
  technicalDetails,
  username,
}: MailboxServerStepProps) => (
  <form className="grid gap-5" onSubmit={onConnect}>
    <div className="grid gap-1">
      <h3 className="text-lg font-semibold text-[color:var(--tx)]">Where does this mail live?</h3>
      <p className="text-sm text-[color:var(--tx2)]">
        Enter the mail server for {address}. We will work out the ports and security settings.
      </p>
    </div>

    <label className="grid gap-1 text-sm">
      <span className="text-[color:var(--tx2)]">Mail server</span>
      <input
        autoCapitalize="none"
        autoFocus
        className="admin-input"
        onChange={(event) => onServerChange(event.target.value)}
        placeholder="mail.company.com"
        required
        value={server}
      />
      <span className="text-xs text-[color:var(--tx3)]">
        Your provider may call this the host name, incoming server, or IMAP server.
      </span>
    </label>

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

    <label className="grid gap-1 text-sm">
      <span className="text-[color:var(--tx2)]">Username</span>
      <input
        autoComplete="username"
        className="admin-input"
        onChange={(event) => onUsernameChange(event.target.value)}
        placeholder={address || 'Usually your email address'}
        value={username}
      />
    </label>

    <MailboxConnectionIdentityFields
      label={label}
      onLabelChange={onLabelChange}
      onTeamChange={onTeamChange}
      scope={scope}
      teamId={teamId}
      teams={teams}
    />

    {error ? (
      <div className="grid gap-1">
        <FormError>{error}</FormError>
        <MailboxTechnicalDetails lines={technicalDetails} />
      </div>
    ) : null}

    <div className="flex flex-wrap gap-2">
      <button
        className="admin-button admin-button-primary"
        disabled={pending || (scope === 'team' && !teamId)}
        type="submit"
      >
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
