import { CommsProviderSchema } from '@nessie/schemas'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'

import { readIntentValues, useConsumedIntents } from '../../../navigation/intent'
import { PROVIDER_LABEL } from './ConnectionCard'
import { tabForProvider, type ConnectionTab } from './connection-tabs'

/**
 * A provider's sign-in comes back to Connected accounts with
 * `?connected=<provider>`, or `?error=<code>&provider=<provider>`. Those are
 * one-shot instructions — show this outcome — so they are consumed intents of
 * the Your settings row, read through the navigation intent hooks: Back and a
 * refresh land on the address, never on the notice again.
 */
const LANDING_INTENTS = ['connected', 'error', 'provider'] as const

/**
 * The notice names the service, never a capability or a protocol: this same
 * return also follows a calendar-only "Connect Calendar or Meet" doorway,
 * which grants no mail, and it carries Slack as well as Google and Microsoft,
 * so a generic "email provider" is sometimes the wrong noun and sometimes an
 * outright false claim about what was just granted.
 */
const serviceName = (value: string | null): string => {
  const provider = CommsProviderSchema.safeParse(value)
  return provider.success ? PROVIDER_LABEL[provider.data] : 'The service'
}

const callbackErrorCopy = (service: string): Record<string, string> => ({
  access_denied: 'Connection was not completed.',
  account_mismatch: 'The account you chose does not match the connection you started.',
  connect_failed: `${service} could not complete the connection. Try again.`,
  connector_unavailable: `${service} is not available in this deployment.`,
  invalid_callback: 'Connection was not completed. Try again.',
  provider_access_blocked: `Your organisation does not currently allow this app to access ${service}.`,
  reauthorization_required: `${service} needs you to sign in again.`,
  state_invalid: 'That connection link has expired. Start again to continue.',
})

export const landingMessage = (
  connected: string | null,
  error: string | null,
  provider: string | null = null,
): string | null => {
  if (connected) return `${serviceName(connected)} connected.`
  return error ? callbackErrorCopy(serviceName(provider))[error] ?? 'Connection was not completed. Try again.' : null
}

/** A line under the header, on the tab it is about; `tab: null` shows on whichever is open. */
export type ConnectionNotice = { message: string; tab: ConnectionTab | null }

/**
 * The OAuth return's notice, shown on the tab its provider belongs to.
 *
 * The provider's tab is selected once the strip has taken the instruction out
 * of the address, never in the same commit: each write starts from the search
 * string the router held when it was issued, so a tab written beside the strip
 * would put back the params the strip removed, or be removed by it.
 */
export const useConnectionLanding = (
  tab: ConnectionTab,
  selectTab: (next: ConnectionTab) => void,
): { notice: ConnectionNotice | null; showNotice: (notice: ConnectionNotice) => void } => {
  const location = useLocation()
  const landing = useConsumedIntents(LANDING_INTENTS)
  const [notice, setNotice] = useState<ConnectionNotice | null>(null)
  const [landingTab, setLandingTab] = useState<ConnectionTab | null>(null)

  useEffect(() => {
    const { connected, error, provider } = landing.values
    const message = landingMessage(connected, error, provider)
    if (!message) return
    const target = tabForProvider(connected ?? provider)
    setNotice({ message, tab: target })
    setLandingTab(target)
  }, [landing.serial, landing.values])

  const landingInAddress = Object.values(readIntentValues(location.search, LANDING_INTENTS))
    .some((value) => value !== null)

  useEffect(() => {
    if (landingTab === null || landingInAddress) return
    setLandingTab(null)
    if (landingTab !== tab) selectTab(landingTab)
  }, [landingInAddress, landingTab, selectTab, tab])

  return { notice, showNotice: setNotice }
}
