import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import type {
  MailboxConnectionDiagnosis,
  MailboxConnectionScope,
  MailboxDiscoveryResult,
  MailboxTransportSecurity,
} from '../../../lib/api-client'
import { connectionAnchorId } from '../../../lib/connection-anchor'
import { useCommsProviders, useStartCommsConnection } from '../../../facades/connections/hooks'
import { useConnectMailbox, useDiscoverMailbox } from '../../../facades/mailbox-connections/hooks'
import { useTeams } from '../../../facades/projects/hooks'
import { Dialog } from '../../shared/Dialog'
import {
  commsOAuthProvider,
  failingLeg,
  hasTrustedMailboxConfiguration,
  isUsableEmailAddress,
  mailboxConnectionDiagnosis,
  mailboxErrorCode,
  mailboxErrorMessage,
  mailboxTechnicalDetails,
  nextMailboxOnboardingStep,
  nextStepAfterConnectFailure,
  shouldDiscoverMailbox,
  type MailboxLeg,
  type MailboxOnboardingStep,
} from './mailbox-onboarding'
import { MailboxAddressStart } from './MailboxAddressStart'
import { MailboxDiscoveryResolution } from './MailboxDiscoveryResolution'
import { MailboxLegStep } from './MailboxLegStep'
import { MailboxManualSettings } from './MailboxManualSettings'
import { MailboxServerStep } from './MailboxServerStep'

type MailboxConnectionFormProps = {
  scope: MailboxConnectionScope
  onConnected?: () => void
}

/**
 * Ports and transports are strings, and they start empty.
 *
 * Empty has to be expressible, because the route treats a present field as an
 * instruction: a port input defaulted to 993 posts 993, the server cannot tell
 * that from a chosen value, and the sweep it would otherwise have run never
 * happens. That is not hypothetical — the browser suite caught exactly this,
 * with the leg step posting a 587 nobody had typed.
 *
 * So blank means "work it out" on every screen, the advanced form included.
 * That also makes the advanced form a genuine superset rather than an
 * alternative: somebody who knows only their hostname can give just that.
 */
type FormValues = {
  address: string
  imapHost: string
  imapPort: string
  imapSecurity: MailboxTransportSecurity | ''
  label: string
  password: string
  server: string
  smtpHost: string
  smtpPort: string
  smtpSecurity: MailboxTransportSecurity | ''
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

const createFormValues = (): FormValues => ({
  address: '',
  imapHost: '',
  imapPort: '',
  imapSecurity: '',
  label: '',
  password: '',
  server: '',
  smtpHost: '',
  smtpPort: '',
  smtpSecurity: '',
  teamId: '',
  username: '',
})

/** A port the server should honour, or nothing at all — never a placeholder. */
const statedPort = (value: string): number | undefined => {
  const port = Number(value.trim())
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined
}

/** Present only when the person typed a usable port, so blank stays blank. */
const portFields = (leg: MailboxLeg, value: string) => {
  const port = statedPort(value)
  if (port === undefined) return {}
  return leg === 'imap' ? { imapPort: port } : { smtpPort: port }
}

/** Same rule for the transport: "Automatic" is the absence of an instruction. */
const securityFields = (leg: MailboxLeg, value: MailboxTransportSecurity | '') => {
  if (!value) return {}
  return leg === 'imap' ? { imapSecurity: value } : { smtpSecurity: value }
}

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
export const MailboxConnectionForm = ({ scope, onConnected }: MailboxConnectionFormProps) => {
  const connect = useConnectMailbox()
  const { mutateAsync: discoverMailbox } = useDiscoverMailbox()
  const startComms = useStartCommsConnection()
  const commsProviders = useCommsProviders()
  const teams = useTeams()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FormValues>(createFormValues)
  const [screen, setScreen] = useState<MailboxOnboardingStep>('start')
  const [discovery, setDiscovery] = useState<MailboxDiscoveryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [isSubmittingDiscovery, setIsSubmittingDiscovery] = useState(false)
  /** The server's last per-leg verdict; it decides which screen comes next. */
  const [diagnosis, setDiagnosis] = useState<MailboxConnectionDiagnosis | null>(null)
  const activeDiscoveryKey = useRef('')
  const discovered = useRef<DiscoveryCacheEntry | null>(null)
  const inFlightDiscovery = useRef<DiscoveryInFlight | null>(null)
  const emailInput = useRef<HTMLInputElement>(null)

  // Absent while the read is in flight or has failed, which leaves the rows
  // enabled: a provider is only declared unavailable on the server's word.
  const providerAvailability: Partial<Record<'google' | 'microsoft', boolean>> = {}
  for (const entry of commsProviders.data?.providers ?? []) {
    if (entry.provider === 'google' || entry.provider === 'microsoft') {
      providerAvailability[entry.provider] = entry.available
    }
  }

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]): void =>
    setForm((current) => ({ ...current, [key]: value }))

  /** A message and the code behind it are one thing: never half cleared. */
  const clearError = useCallback(() => {
    setError(null)
    setErrorCode(null)
  }, [])

  /** Guidance survives typing but not a move to another screen. */
  const clearFeedback = useCallback(() => {
    clearError()
    setNotice(null)
  }, [clearError])

  const failWith = useCallback((cause: unknown, fallback: string) => {
    setNotice(null)
    setErrorCode(mailboxErrorCode(cause))
    setError(mailboxErrorMessage(cause, fallback))
  }, [])

  const reset = useCallback(() => {
    activeDiscoveryKey.current = ''
    discovered.current = null
    inFlightDiscovery.current = null
    setDiscovery(null)
    setError(null)
    setErrorCode(null)
    setNotice(null)
    setDiagnosis(null)
    setForm(createFormValues())
    setHelpOpen(false)
    setIsDiscovering(false)
    setIsSubmittingDiscovery(false)
    setScreen('start')
  }, [])

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
          failWith(cause, 'We could not find the settings automatically.')
        }
        return null
      })
      .finally(() => {
        if (activeDiscoveryKey.current === key) setIsDiscovering(false)
        if (inFlightDiscovery.current?.key === key) inFlightDiscovery.current = null
      })

    inFlightDiscovery.current = { key, promise }
    return promise
  }, [discoverMailbox, failWith, form.teamId, scope])

  useEffect(() => {
    if (!shouldDiscoverMailbox(screen)) {
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
    if (addressChanged) clearError()
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
  }, [clearError, discoverAddress, form.address, form.teamId, scope, screen])

  /**
   * A hand-off that never left the browser must not leave the person on a
   * screen whose only action was that hand-off: the address screen is the one
   * place every route out of here is still reachable.
   */
  const beginOAuth = async (provider: 'google' | 'microsoft', loginHint?: string) => {
    clearFeedback()
    try {
      const result = await startComms.mutateAsync({ provider, ...(loginHint ? { loginHint } : {}) })
      window.location.assign(result.authorizeUrl)
    } catch (cause) {
      setScreen('start')
      failWith(cause, 'Connection wasn\'t completed. Please try again.')
      window.requestAnimationFrame(() => emailInput.current?.focus({ preventScroll: true }))
    }
  }

  const continueWithDiscovery = async (result: MailboxDiscoveryResult, confirmed = false) => {
    if (result.existingConnection) {
      setScreen('existing')
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
      setNotice(null)
      setErrorCode('INVALID_EMAIL_ADDRESS')
      setError('Enter a valid email address.')
      return
    }
    clearFeedback()
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

  /**
   * What the person has told us, and nothing more.
   *
   * Every screen posts through here, and what separates them is only which
   * fields they have filled in. An empty field is left out of the payload
   * rather than defaulted, because the route treats a present field as an
   * instruction: a placeholder posted as a value would silence the very sweep
   * the earlier screens depend on.
   */
  const connectPayload = (screen: MailboxOnboardingStep) => {
    const address = form.address.trim()
    const settings = screen === 'password' ? discovery?.trustedImapSmtp : undefined
    const base = {
      address,
      label: form.label.trim() || address,
      password: form.password,
      scope,
      teamId: scope === 'team' ? form.teamId || null : null,
    }

    // A trusted discovered configuration is a complete answer; it also decides
    // the username, which is the one thing an address cannot always give.
    if (settings) {
      return {
        ...base,
        imapHost: settings.imap.host,
        imapPort: settings.imap.port,
        imapSecurity: settings.imap.security,
        smtpHost: settings.smtp.host,
        smtpPort: settings.smtp.port,
        smtpSecurity: settings.smtp.security,
        username: settings.username === 'local_part'
          ? address.slice(0, address.indexOf('@'))
          : address,
      }
    }

    const username = form.username.trim()
    const identity = { ...base, ...(username ? { username } : {}) }

    if (screen === 'manual') {
      return {
        ...identity,
        imapHost: form.imapHost.trim(),
        smtpHost: form.smtpHost.trim(),
        ...portFields('imap', form.imapPort),
        ...portFields('smtp', form.smtpPort),
        ...securityFields('imap', form.imapSecurity),
        ...securityFields('smtp', form.smtpSecurity),
      }
    }

    if (screen === 'leg' && legToFix) {
      // The leg that already resolved is pinned so it is not swept again, and
      // cannot be re-resolved to something different while we fix the other.
      const working = legToFix === 'imap' ? diagnosis?.smtp : diagnosis?.imap
      const fixing = legToFix === 'imap'
        ? { imapHost: form.imapHost.trim(), ...portFields('imap', form.imapPort) }
        : { smtpHost: form.smtpHost.trim(), ...portFields('smtp', form.smtpPort) }
      const pinned = legToFix === 'imap'
        ? { smtpHost: working?.host, smtpPort: working?.port }
        : { imapHost: working?.host, imapPort: working?.port }
      return { ...identity, ...fixing, ...pinned }
    }

    // `password` without a discovered configuration, and `server`: the address
    // and the credential, plus one hostname when the person has given one.
    return { ...identity, ...(form.server.trim() ? { server: form.server.trim() } : {}) }
  }

  const connectMailbox = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const from = screen
    clearFeedback()
    connect.mutate(connectPayload(from), {
      onError: (cause: unknown) => {
        const detail = mailboxConnectionDiagnosis(cause)
        setDiagnosis(detail)
        // A refusal carrying a diagnosis was written about *these* endpoints and
        // says which leg failed; the code-keyed sentences are the generic
        // fallback for refusals that know less. Letting the map win here would
        // replace "we connected to your inbox but not your outgoing server"
        // with "we could not connect to the server", losing the only part
        // somebody can act on.
        if (detail && cause instanceof Error && cause.message) {
          setNotice(null)
          setErrorCode(mailboxErrorCode(cause))
          setError(cause.message)
        } else {
          failWith(cause, 'Could not connect this mailbox.')
        }
        const next = nextStepAfterConnectFailure(from, detail)
        if (next !== from) setScreen(next)
      },
      onSuccess: () => {
        close()
        onConnected?.()
      },
    })
  }

  const revealExisting = () => {
    const id = discovery?.existingConnection?.id
    close()
    if (id) {
      window.requestAnimationFrame(() => {
        document.getElementById(connectionAnchorId(id))?.scrollIntoView({ block: 'center' })
      })
    }
  }

  const showManual = () => {
    clearFeedback()
    setScreen('manual')
  }

  /**
   * Back always returns to the address, and returning discards the verdict that
   * put us past it — a stale diagnosis would otherwise route the next attempt
   * from the wrong rung of the ladder.
   */
  const returnToAddress = () => {
    setDiagnosis(null)
    returnToStart()
  }

  const returnToStart = () => {
    clearFeedback()
    setScreen('start')
  }


  const technicalDetails = mailboxTechnicalDetails({
    address: form.address.trim(),
    code: errorCode,
    result: discovery,
  })

  const legToFix: MailboxLeg | null = diagnosis ? failingLeg(diagnosis) : null

  if (!open) {
    return (
      <button
        className="admin-button admin-button-secondary admin-button-compact"
        onClick={() => setOpen(true)}
        type="button"
      >
        Connect email
      </button>
    )
  }

  return (
    <Dialog
      initialFocusRef={emailInput}
      onClose={close}
      open={open}
      size="lg"
      title="Connect email"
    >
      {screen === 'start' ? (
        <MailboxAddressStart
          address={form.address}
          discovery={discovery}
          emailInput={emailInput}
          error={error}
          helpOpen={helpOpen}
          isDiscovering={isDiscovering}
          notice={notice}
          onAddressChange={(value) => set('address', value)}
          onCancel={close}
          onContinue={(event) => void continueFromAddress(event)}
          onHelp={() => setHelpOpen(true)}
          onICloud={() => {
            clearError()
            setNotice(
              'Enter your iCloud email address and continue. We will guide you to an app-specific '
              + 'password if it is needed.',
            )
            emailInput.current?.focus({ preventScroll: true })
          }}
          onOtherProvider={() => {
            // This row used to open the advanced form. It is a statement about
            // who runs the mailbox, not a request to configure ports by hand —
            // and every other provider goes through the address too.
            clearError()
            setNotice(
              'Enter your email address and continue. We will find the settings for it.',
            )
            emailInput.current?.focus({ preventScroll: true })
          }}
          onProvider={(entry) => {
            if (scope === 'user') {
              void beginOAuth(entry, form.address.trim())
              return
            }
            clearError()
            setNotice(
              'A shared mailbox connects with its own secure server credential. Enter its address '
              + 'and continue.',
            )
            emailInput.current?.focus({ preventScroll: true })
          }}
          pending={isSubmittingDiscovery}
          providerAvailability={providerAvailability}
          technicalDetails={technicalDetails}
        />
      ) : null}

      {screen !== 'start' && screen !== 'manual' && screen !== 'server' && screen !== 'leg' ? (
        <MailboxDiscoveryResolution
          address={form.address.trim()}
          error={error}
          label={form.label}
          onBack={returnToAddress}
          onClose={close}
          onConfirmProvider={() => {
            if (discovery) void continueWithDiscovery(discovery, true)
          }}
          onConnect={connectMailbox}
          onExisting={revealExisting}
          onLabelChange={(value) => set('label', value)}
          onManual={showManual}
          onPasswordChange={(value) => set('password', value)}
          onTeamChange={(value) => set('teamId', value)}
          password={form.password}
          pending={connect.isPending}
          result={discovery}
          scope={scope}
          screen={screen}
          teamId={form.teamId}
          teams={teams.data ?? []}
          technicalDetails={technicalDetails}
        />
      ) : null}

      {screen === 'server' ? (
        <MailboxServerStep
          address={form.address.trim()}
          error={error}
          label={form.label}
          onAdvanced={showManual}
          onBack={returnToAddress}
          onConnect={connectMailbox}
          onLabelChange={(value) => set('label', value)}
          onPasswordChange={(value) => set('password', value)}
          onServerChange={(value) => set('server', value)}
          onTeamChange={(value) => set('teamId', value)}
          onUsernameChange={(value) => set('username', value)}
          password={form.password}
          pending={connect.isPending}
          scope={scope}
          server={form.server}
          teamId={form.teamId}
          teams={teams.data ?? []}
          technicalDetails={technicalDetails}
          username={form.username}
        />
      ) : null}

      {screen === 'leg' && legToFix && diagnosis ? (
        <MailboxLegStep
          error={error}
          host={legToFix === 'imap' ? form.imapHost : form.smtpHost}
          leg={legToFix}
          onAdvanced={showManual}
          onBack={returnToAddress}
          onConnect={connectMailbox}
          onHostChange={(value) => set(legToFix === 'imap' ? 'imapHost' : 'smtpHost', value)}
          onPortChange={(value) => set(legToFix === 'imap' ? 'imapPort' : 'smtpPort', value)}
          pending={connect.isPending}
          port={legToFix === 'imap' ? form.imapPort : form.smtpPort}
          technicalDetails={technicalDetails}
          working={legToFix === 'imap' ? diagnosis.smtp : diagnosis.imap}
        />
      ) : null}

      {screen === 'manual' ? (
        <MailboxManualSettings
          address={form.address}
          error={error}
          imapHost={form.imapHost}
          imapPort={form.imapPort}
          imapSecurity={form.imapSecurity}
          label={form.label}
          onAddressChange={(value) => set('address', value)}
          onBack={returnToAddress}
          onConnect={connectMailbox}
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
          pending={connect.isPending}
          scope={scope}
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
