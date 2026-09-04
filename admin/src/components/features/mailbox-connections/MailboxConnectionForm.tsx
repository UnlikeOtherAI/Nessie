import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import type {
  MailboxConnectionScope,
  MailboxConnectionRecord,
  MailboxDiscoveryResult,
  MailboxTransportSecurity,
} from '../../../lib/api-client'
import { useStartCommsConnection } from '../../../facades/connections/hooks'
import {
  useConnectMailbox,
  useDiscoverMailbox,
  useReconnectMailbox,
} from '../../../facades/mailbox-connections/hooks'
import { useTeams } from '../../../facades/projects/hooks'
import { Dialog } from '../../shared/Dialog'
import {
  commsOAuthProvider,
  hasTrustedMailboxConfiguration,
  isUsableEmailAddress,
  mailboxErrorMessage,
  nextMailboxOnboardingStep,
  shouldDiscoverMailbox,
  type MailboxOnboardingStep,
} from './mailbox-onboarding'
import { MailboxAddressStart } from './MailboxAddressStart'
import { MailboxDiscoveryResolution } from './MailboxDiscoveryResolution'
import { MailboxManualSettings } from './MailboxManualSettings'

type MailboxConnectionFormProps = {
  scope: MailboxConnectionScope
  onConnected?: () => void
  /** The owning surface chooses the route; this component never navigates itself. */
  onOpenExisting?: (connectionId: string, scope: MailboxConnectionScope) => void
  /** Reuses this form to rotate a Model A credential without creating a row. */
  reconnectConnection?: MailboxConnectionRecord
}

type FormValues = {
  address: string
  imapHost: string
  imapPort: number
  imapSecurity: MailboxTransportSecurity
  label: string
  password: string
  smtpHost: string
  smtpPort: number
  smtpSecurity: MailboxTransportSecurity
  teamId: string
  username: string
}

type DiscoveryCacheEntry = {
  key: string
  result: MailboxDiscoveryResult
}

type DiscoveryInFlight = {
  key: string
  promise: Promise<MailboxDiscoveryResult | null>
}

const createFormValues = (connection?: MailboxConnectionRecord): FormValues => ({
  address: connection?.address ?? '',
  imapHost: connection?.imapHost ?? '',
  imapPort: connection?.imapPort ?? 993,
  imapSecurity: connection?.imapSecurity ?? 'tls',
  label: connection?.label ?? '',
  password: '',
  smtpHost: connection?.smtpHost ?? '',
  smtpPort: connection?.smtpPort ?? 587,
  smtpSecurity: connection?.smtpSecurity ?? 'starttls',
  teamId: connection?.teamId ?? '',
  username: connection?.username ?? '',
})

const discoveryKey = (input: {
  address: string
  scope: MailboxConnectionScope
  teamId?: string
}): string => [input.address, input.scope, input.teamId ?? ''].join('|')

/**
 * One address-first entry point, parameterised by connection scope. Discovery
 * decides where credentials may go; this component never promotes an inferred
 * host to a password form on its own.
 */
export const MailboxConnectionForm = ({
  scope,
  onConnected,
  onOpenExisting,
  reconnectConnection,
}: MailboxConnectionFormProps) => {
  const connect = useConnectMailbox()
  const reconnect = useReconnectMailbox()
  const { mutateAsync: discoverMailbox } = useDiscoverMailbox()
  const startComms = useStartCommsConnection()
  const teams = useTeams()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FormValues>(() => createFormValues(reconnectConnection))
  const [screen, setScreen] = useState<MailboxOnboardingStep>('start')
  const [discovery, setDiscovery] = useState<MailboxDiscoveryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [isSubmittingDiscovery, setIsSubmittingDiscovery] = useState(false)
  const activeDiscoveryKey = useRef('')
  const discovered = useRef<DiscoveryCacheEntry | null>(null)
  const inFlightDiscovery = useRef<DiscoveryInFlight | null>(null)
  const emailInput = useRef<HTMLInputElement>(null)
  const isReconnect = Boolean(reconnectConnection)

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]): void =>
    setForm((current) => ({ ...current, [key]: value }))

  const reset = useCallback(() => {
    activeDiscoveryKey.current = ''
    discovered.current = null
    inFlightDiscovery.current = null
    setDiscovery(null)
    setError(null)
    setForm(createFormValues(reconnectConnection))
    setHelpOpen(false)
    setIsDiscovering(false)
    setIsSubmittingDiscovery(false)
    setScreen('start')
  }, [reconnectConnection])

  const close = useCallback(() => {
    setOpen(false)
    reset()
  }, [reset])

  const discoverAddress = useCallback((address: string): Promise<MailboxDiscoveryResult | null> => {
    const teamId = scope === 'team' ? form.teamId || undefined : undefined
    const key = discoveryKey({ address, scope, teamId })
    activeDiscoveryKey.current = key

    if (discovered.current?.key === key) {
      setDiscovery(discovered.current.result)
      return Promise.resolve(discovered.current.result)
    }
    if (inFlightDiscovery.current?.key === key) return inFlightDiscovery.current.promise

    setIsDiscovering(true)
    const promise = discoverMailbox({
        email: address,
        scope,
        ...(teamId ? { teamId } : {}),
      })
      .then((result) => {
        discovered.current = { key, result }
        if (activeDiscoveryKey.current === key) setDiscovery(result)
        return result
      })
      .catch((cause: unknown) => {
        if (activeDiscoveryKey.current === key) {
          setDiscovery(null)
          setError(mailboxErrorMessage(cause, 'We could not find the settings automatically.'))
        }
        return null
      })
      .finally(() => {
        if (activeDiscoveryKey.current === key) setIsDiscovering(false)
        if (inFlightDiscovery.current?.key === key) inFlightDiscovery.current = null
      })

    inFlightDiscovery.current = { key, promise }
    return promise
  }, [discoverMailbox, form.teamId, scope])

  useEffect(() => {
    // A reconnect form starts with the saved, non-secret address. Discovery is
    // useful only after its dialog opens; otherwise each stopped-row render
    // would start a network request just by appearing on Settings.
    if (!open || !shouldDiscoverMailbox(screen)) {
      activeDiscoveryKey.current = ''
      setIsDiscovering(false)
      return undefined
    }
    const address = form.address.trim()
    const teamId = scope === 'team' ? form.teamId || undefined : undefined
    const key = discoveryKey({ address, scope, teamId })
    const addressChanged = activeDiscoveryKey.current !== key
    activeDiscoveryKey.current = key
    setIsDiscovering(inFlightDiscovery.current?.key === key)
    if (addressChanged) setError(null)
    if (!isUsableEmailAddress(address)) {
      setDiscovery(null)
      return undefined
    }
    if (discovered.current?.key === key) {
      setDiscovery(discovered.current.result)
      return undefined
    }
    setDiscovery(null)

    const timer = window.setTimeout(() => {
      void discoverAddress(address)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [discoverAddress, form.address, form.teamId, open, scope, screen])

  const beginOAuth = async (provider: 'google' | 'microsoft', loginHint?: string) => {
    setError(null)
    try {
      const result = await startComms.mutateAsync({ provider, ...(loginHint ? { loginHint } : {}) })
      window.location.assign(result.authorizeUrl)
    } catch (cause) {
      setError(mailboxErrorMessage(cause, 'Connection was not started. Please try again.'))
    }
  }

  const continueWithDiscovery = async (result: MailboxDiscoveryResult, confirmed = false) => {
    if (
      result.existingConnection
      && (!reconnectConnection || result.existingConnection.id !== reconnectConnection.id)
    ) {
      setScreen('existing')
      return
    }
    if (isReconnect) {
      setScreen(hasTrustedMailboxConfiguration(result) ? 'password' : 'manual')
      return
    }
    const oauthProvider = commsOAuthProvider(result, scope)
    if (oauthProvider && (!result.ui.requiresProviderConfirmation || confirmed)) {
      await beginOAuth(oauthProvider, form.address.trim())
      return
    }

    let next = nextMailboxOnboardingStep(result, scope)
    if (next === 'confirmation') {
      if (!confirmed) {
        setScreen('confirmation')
        return
      }
      next = scope === 'team' && result.authentication.strategy === 'oauth2'
        ? 'shared-credential'
        : result.ui.requiresAdvancedSettings
          ? 'shared-credential'
          : hasTrustedMailboxConfiguration(result)
            ? 'password'
            : result.authentication.strategy === 'oauth2'
              ? 'shared-credential'
              : 'manual'
    }
    if (next === 'existing') {
      setScreen('existing')
      return
    }
    setScreen(next)
  }

  const continueFromAddress = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const address = form.address.trim()
    if (!isUsableEmailAddress(address)) {
      setError('Enter a valid email address.')
      return
    }
    setError(null)
    setIsSubmittingDiscovery(true)
    try {
      const result = await discoverAddress(address)
      if (!result) {
        setScreen('manual')
        return
      }
      await continueWithDiscovery(result)
    } finally {
      setIsSubmittingDiscovery(false)
    }
  }

  const connectMailbox = (event: FormEvent<HTMLFormElement>, useDiscoveredSettings: boolean) => {
    event.preventDefault()
    const settings = useDiscoveredSettings ? discovery?.trustedImapSmtp : undefined
    const imap = settings?.imap ?? {
      host: form.imapHost.trim(), port: form.imapPort, security: form.imapSecurity,
    }
    const smtp = settings?.smtp ?? {
      host: form.smtpHost.trim(), port: form.smtpPort, security: form.smtpSecurity,
    }
    const address = form.address.trim()
    const username = settings
      ? settings.username === 'local_part'
        ? address.slice(0, address.indexOf('@'))
        : address
      : form.username.trim() || address

    setError(null)
    const callbacks = {
      onError: (cause: unknown) => setError(mailboxErrorMessage(
        cause,
        isReconnect ? 'Could not reconnect this mailbox.' : 'Could not connect this mailbox.',
      )),
      onSuccess: () => {
        close()
        onConnected?.()
      },
    }
    if (reconnectConnection) {
      reconnect.mutate({
        connectionId: reconnectConnection.id,
        imapHost: imap.host,
        imapPort: imap.port,
        imapSecurity: imap.security,
        password: form.password,
        smtpHost: smtp.host,
        smtpPort: smtp.port,
        smtpSecurity: smtp.security,
        username,
      }, callbacks)
      return
    }
    connect.mutate({
      address,
      imapHost: imap.host,
      imapPort: imap.port,
      imapSecurity: imap.security,
      label: form.label.trim() || form.address.trim(),
      password: form.password,
      scope,
      smtpHost: smtp.host,
      smtpPort: smtp.port,
      smtpSecurity: smtp.security,
      teamId: scope === 'team' ? form.teamId || null : null,
      username,
    }, callbacks)
  }

  const revealExisting = () => {
    const id = discovery?.existingConnection?.id
    const existingScope = discovery?.existingConnection?.scope ?? scope
    close()
    if (id) onOpenExisting?.(id, existingScope)
  }

  const showManual = () => {
    setError(null)
    setScreen('manual')
  }

  const returnToStart = () => {
    setError(null)
    setScreen('start')
  }

  if (!open) {
    return (
      <button
        className="admin-button admin-button-secondary admin-button-compact"
        onClick={() => setOpen(true)}
        type="button"
      >
        {isReconnect ? 'Reconnect' : 'Connect email'}
      </button>
    )
  }

  return (
    <Dialog
      initialFocusRef={emailInput}
      onClose={close}
      open={open}
      size="lg"
      title={isReconnect ? 'Reconnect email' : 'Connect email'}
    >
      {screen === 'start' ? (
        <MailboxAddressStart
          address={form.address}
          addressReadOnly={isReconnect}
          discovery={discovery}
          emailInput={emailInput}
          error={error}
          helpOpen={helpOpen}
          isDiscovering={isDiscovering}
          onAddressChange={(value) => set('address', value)}
          onCancel={close}
          onContinue={(event) => void continueFromAddress(event)}
          onHelp={() => setHelpOpen(true)}
          onICloud={() => {
            setError(
              'Enter your iCloud email address and continue. We will guide you to an app-specific '
              + 'password if it is needed.',
            )
            emailInput.current?.focus({ preventScroll: true })
          }}
          onOtherProvider={showManual}
          onProvider={(entry) => {
            if (isReconnect) showManual()
            else if (scope === 'user') void beginOAuth(entry, form.address.trim())
            else setError('A shared mailbox needs its secure server credential.')
          }}
          pending={isSubmittingDiscovery}
        />
      ) : null}

      {screen !== 'start' && screen !== 'manual' ? (
        <MailboxDiscoveryResolution
          address={form.address.trim()}
          error={error}
          label={form.label}
          onBack={returnToStart}
          onClose={close}
          onConfirmProvider={() => {
            if (discovery) void continueWithDiscovery(discovery, true)
          }}
          onConnect={(event) => connectMailbox(event, true)}
          onExisting={revealExisting}
          onLabelChange={(value) => set('label', value)}
          onManual={showManual}
          onPasswordChange={(value) => set('password', value)}
          onTeamChange={(value) => set('teamId', value)}
          password={form.password}
          pending={isReconnect ? reconnect.isPending : connect.isPending}
          result={discovery}
          scope={scope}
          showIdentityFields={!isReconnect}
          screen={screen}
          teamId={form.teamId}
          teams={teams.data ?? []}
        />
      ) : null}

      {screen === 'manual' ? (
        <MailboxManualSettings
          address={form.address}
          addressReadOnly={isReconnect}
          error={error}
          imapHost={form.imapHost}
          imapPort={form.imapPort}
          imapSecurity={form.imapSecurity}
          label={form.label}
          onAddressChange={(value) => set('address', value)}
          onBack={returnToStart}
          onConnect={(event) => connectMailbox(event, false)}
          onImapHostChange={(value) => set('imapHost', value)}
          onImapPortChange={(value) => set('imapPort', value)}
          onImapSecurityChange={(value) => set('imapSecurity', value)}
          onLabelChange={(value) => set('label', value)}
          onPasswordChange={(value) => set('password', value)}
          onSmtpHostChange={(value) => set('smtpHost', value)}
          onSmtpPortChange={(value) => set('smtpPort', value)}
          onSmtpSecurityChange={(value) => set('smtpSecurity', value)}
          onTeamChange={(value) => set('teamId', value)}
          onUsernameChange={(value) => set('username', value)}
          password={form.password}
          pending={isReconnect ? reconnect.isPending : connect.isPending}
          scope={scope}
          showIdentityFields={!isReconnect}
          smtpHost={form.smtpHost}
          smtpPort={form.smtpPort}
          smtpSecurity={form.smtpSecurity}
          teamId={form.teamId}
          teams={teams.data ?? []}
          username={form.username}
        />
      ) : null}
    </Dialog>
  )
}
