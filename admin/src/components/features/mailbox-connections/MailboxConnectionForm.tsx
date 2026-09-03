import { useState } from 'react'

import type { MailboxConnectionScope, MailboxTransportSecurity } from '../../../lib/api-client'
import { useConnectMailbox } from '../../../facades/mailbox-connections/hooks'
import { useTeams } from '../../../facades/projects/hooks'
import { FormError } from '../../shared/FormActions'

/**
 * Connect a mailbox by password.
 *
 * The form does not "save then verify": submitting runs a real IMAP login and a
 * real SMTP session first, and nothing is stored unless both work. That is why
 * there is no separate Test button here — the failure arrives on this form,
 * where the field that is wrong still is.
 */

type MailboxConnectionFormProps = {
  scope: MailboxConnectionScope
  onConnected?: () => void
}

const DEFAULTS = {
  imapPort: 993,
  imapSecurity: 'tls' as MailboxTransportSecurity,
  smtpPort: 587,
  smtpSecurity: 'starttls' as MailboxTransportSecurity,
}

export const MailboxConnectionForm = ({ scope, onConnected }: MailboxConnectionFormProps) => {
  const connect = useConnectMailbox()
  const teams = useTeams()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    address: '',
    imapHost: '',
    imapPort: DEFAULTS.imapPort,
    imapSecurity: DEFAULTS.imapSecurity,
    label: '',
    password: '',
    smtpHost: '',
    smtpPort: DEFAULTS.smtpPort,
    smtpSecurity: DEFAULTS.smtpSecurity,
    teamId: '',
    username: '',
  })

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]): void =>
    setForm((current) => ({ ...current, [key]: value }))

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    setError(null)
    connect.mutate(
      {
        address: form.address.trim(),
        imapHost: form.imapHost.trim(),
        imapPort: form.imapPort,
        imapSecurity: form.imapSecurity,
        label: form.label.trim() || form.address.trim(),
        password: form.password,
        scope,
        smtpHost: form.smtpHost.trim(),
        smtpPort: form.smtpPort,
        smtpSecurity: form.smtpSecurity,
        teamId: scope === 'team' ? form.teamId || null : null,
        username: form.username.trim() || form.address.trim(),
      },
      {
        onError: (cause: unknown) =>
          setError(cause instanceof Error ? cause.message : 'Could not connect that mailbox.'),
        onSuccess: () => {
          setOpen(false)
          setForm((current) => ({ ...current, address: '', label: '', password: '', username: '' }))
          onConnected?.()
        },
      },
    )
  }

  if (!open) {
    return (
      <button
        className="admin-button admin-button-secondary admin-button-compact mt-3"
        onClick={() => setOpen(true)}
        type="button"
      >
        {scope === 'team' ? 'Connect a shared mailbox' : 'Connect a mailbox'}
      </button>
    )
  }

  return (
    <form className="mt-3 grid gap-3" onSubmit={submit}>
      {scope === 'team' ? (
        <label className="grid gap-1 text-sm">
          <span className="text-[color:var(--tx2)]">Team</span>
          <select
            className="admin-input"
            onChange={(event) => set('teamId', event.target.value)}
            required
            value={form.teamId}
          >
            <option value="">Choose a team…</option>
            {(teams.data ?? []).map((team) => (
              <option key={team.id} value={team.id}>{team.name}</option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span className="text-[color:var(--tx2)]">Email address</span>
          <input
            autoComplete="off"
            className="admin-input"
            onChange={(event) => set('address', event.target.value)}
            placeholder="support@acme.com"
            required
            type="email"
            value={form.address}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-[color:var(--tx2)]">Name for this mailbox</span>
          <input
            className="admin-input"
            onChange={(event) => set('label', event.target.value)}
            placeholder="Support inbox"
            value={form.label}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-[color:var(--tx2)]">Username</span>
          <input
            autoComplete="off"
            className="admin-input"
            onChange={(event) => set('username', event.target.value)}
            placeholder="Same as the address, usually"
            value={form.username}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-[color:var(--tx2)]">Password</span>
          <input
            autoComplete="new-password"
            className="admin-input"
            onChange={(event) => set('password', event.target.value)}
            required
            type="password"
            value={form.password}
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-sm sm:col-span-1">
          <span className="text-[color:var(--tx2)]">IMAP server</span>
          <input
            className="admin-input"
            onChange={(event) => set('imapHost', event.target.value)}
            placeholder="imap.acme.com"
            required
            value={form.imapHost}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-[color:var(--tx2)]">IMAP port</span>
          <input
            className="admin-input"
            onChange={(event) => set('imapPort', Number(event.target.value))}
            required
            type="number"
            value={form.imapPort}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-[color:var(--tx2)]">IMAP security</span>
          <select
            className="admin-input"
            onChange={(event) => set('imapSecurity', event.target.value as MailboxTransportSecurity)}
            value={form.imapSecurity}
          >
            <option value="tls">TLS</option>
            <option value="starttls">STARTTLS</option>
          </select>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-sm">
          <span className="text-[color:var(--tx2)]">SMTP server</span>
          <input
            className="admin-input"
            onChange={(event) => set('smtpHost', event.target.value)}
            placeholder="smtp.acme.com"
            required
            value={form.smtpHost}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-[color:var(--tx2)]">SMTP port</span>
          <input
            className="admin-input"
            onChange={(event) => set('smtpPort', Number(event.target.value))}
            required
            type="number"
            value={form.smtpPort}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-[color:var(--tx2)]">SMTP security</span>
          <select
            className="admin-input"
            onChange={(event) => set('smtpSecurity', event.target.value as MailboxTransportSecurity)}
            value={form.smtpSecurity}
          >
            <option value="starttls">STARTTLS</option>
            <option value="tls">TLS</option>
          </select>
        </label>
      </div>

      <p className="text-xs text-[color:var(--tx3)]">
        The connection is encrypted either way and the password is never sent before
        that is established. Whoever holds this password can read everything in the
        mailbox and send as it, so an app password is safer than your account one
        where the provider offers it.
      </p>

      <FormError>{error}</FormError>

      <div className="flex gap-2">
        <button
          className="admin-button admin-button-primary admin-button-compact"
          disabled={connect.isPending}
          type="submit"
        >
          {connect.isPending ? 'Checking the mailbox…' : 'Connect'}
        </button>
        <button
          className="admin-button admin-button-secondary admin-button-compact"
          onClick={() => setOpen(false)}
          type="button"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
