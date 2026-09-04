import type { FormEvent } from 'react'

import type {
  MailboxConnectionScope,
  MailboxTransportSecurity,
  TeamRecord,
} from '../../../lib/api-client'
import { FormError } from '../../shared/FormActions'
import { MailboxConnectionIdentityFields } from './MailboxConnectionIdentityFields'

type MailboxManualSettingsProps = {
  address: string
  error: string | null
  imapHost: string
  imapPort: number
  imapSecurity: MailboxTransportSecurity
  label: string
  onAddressChange: (value: string) => void
  onBack: () => void
  onConnect: (event: FormEvent<HTMLFormElement>) => void
  onImapHostChange: (value: string) => void
  onImapPortChange: (value: number) => void
  onImapSecurityChange: (value: MailboxTransportSecurity) => void
  onLabelChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onSmtpHostChange: (value: string) => void
  onSmtpPortChange: (value: number) => void
  onSmtpSecurityChange: (value: MailboxTransportSecurity) => void
  onTeamChange: (value: string) => void
  onUsernameChange: (value: string) => void
  password: string
  pending: boolean
  scope: MailboxConnectionScope
  smtpHost: string
  smtpPort: number
  smtpSecurity: MailboxTransportSecurity
  teamId: string
  teams: TeamRecord[]
  username: string
}

type ServerSettingsProps = {
  direction: 'Incoming' | 'Outgoing'
  host: string
  onHostChange: (value: string) => void
  onPortChange: (value: number) => void
  onSecurityChange: (value: MailboxTransportSecurity) => void
  port: number
  security: MailboxTransportSecurity
}

const ServerSettings = ({
  direction,
  host,
  onHostChange,
  onPortChange,
  onSecurityChange,
  port,
  security,
}: ServerSettingsProps) => (
  <div className="grid gap-3 sm:grid-cols-3">
    <label className="grid gap-1 text-sm sm:col-span-1">
      <span className="text-[color:var(--tx2)]">{direction} server</span>
      <input
        className="admin-input"
        onChange={(event) => onHostChange(event.target.value)}
        placeholder={`${direction === 'Incoming' ? 'imap' : 'smtp'}.example.com`}
        required
        value={host}
      />
    </label>
    <label className="grid gap-1 text-sm">
      <span className="text-[color:var(--tx2)]">Port</span>
      <input
        className="admin-input"
        min="1"
        onChange={(event) => onPortChange(Number(event.target.value))}
        required
        type="number"
        value={port}
      />
    </label>
    <label className="grid gap-1 text-sm">
      <span className="text-[color:var(--tx2)]">Security</span>
      <select
        className="admin-input"
        onChange={(event) => onSecurityChange(event.target.value as MailboxTransportSecurity)}
        value={security}
      >
        <option value="tls">TLS</option>
        <option value="starttls">STARTTLS</option>
      </select>
    </label>
  </div>
)

export const MailboxManualSettings = ({
  address,
  error,
  imapHost,
  imapPort,
  imapSecurity,
  label,
  onAddressChange,
  onBack,
  onConnect,
  onImapHostChange,
  onImapPortChange,
  onImapSecurityChange,
  onLabelChange,
  onPasswordChange,
  onSmtpHostChange,
  onSmtpPortChange,
  onSmtpSecurityChange,
  onTeamChange,
  onUsernameChange,
  password,
  pending,
  scope,
  smtpHost,
  smtpPort,
  smtpSecurity,
  teamId,
  teams,
  username,
}: MailboxManualSettingsProps) => (
  <form className="grid gap-4" onSubmit={onConnect}>
    <div className="grid gap-1">
      <h3 className="text-lg font-semibold text-[color:var(--tx)]">Advanced email settings</h3>
      <p className="text-sm text-[color:var(--tx2)]">
        Use secure IMAP and SMTP settings from your email provider.
      </p>
    </div>
    <label className="grid gap-1 text-sm">
      <span className="text-[color:var(--tx2)]">Email</span>
      <input
        autoCapitalize="none"
        autoComplete="email"
        className="admin-input"
        onChange={(event) => onAddressChange(event.target.value)}
        placeholder="name@company.com"
        required
        type="email"
        value={address}
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
    <ServerSettings
      direction="Incoming"
      host={imapHost}
      onHostChange={onImapHostChange}
      onPortChange={onImapPortChange}
      onSecurityChange={onImapSecurityChange}
      port={imapPort}
      security={imapSecurity}
    />
    <ServerSettings
      direction="Outgoing"
      host={smtpHost}
      onHostChange={onSmtpHostChange}
      onPortChange={onSmtpPortChange}
      onSecurityChange={onSmtpSecurityChange}
      port={smtpPort}
      security={smtpSecurity}
    />
    <label className="grid gap-1 text-sm">
      <span className="text-[color:var(--tx2)]">Username</span>
      <input
        autoComplete="username"
        className="admin-input"
        onChange={(event) => onUsernameChange(event.target.value)}
        placeholder="Usually your email address"
        value={username}
      />
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
    <label className="flex items-center gap-2 text-sm text-[color:var(--tx2)]">
      <input checked readOnly type="checkbox" />
      Use the same username and password for incoming and outgoing mail
    </label>
    <p className="text-xs text-[color:var(--tx3)]">
      Only encrypted TLS or STARTTLS connections are supported.
    </p>
    <FormError>{error}</FormError>
    <div className="flex flex-wrap gap-2">
      <button className="admin-button admin-button-primary" disabled={pending} type="submit">
        {pending ? 'Connecting…' : 'Connect'}
      </button>
      <button className="admin-button admin-button-secondary" onClick={onBack} type="button">
        Back
      </button>
    </div>
  </form>
)
