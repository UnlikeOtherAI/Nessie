import type { McpCatalogAuthMethod } from '@nessie/schemas'

/**
 * Pure validation module for {@link ./AddServerWizard.tsx}. Owns the per-step
 * error shape, the URL-parsing helper, and the three step validators. No React
 * or DOM dependencies — keep it that way so the wizard component can stay under
 * the 500-line architectural cap.
 */

export type StepErrors = {
  url?: string
  name?: string
  label?: string
  headerName?: string
  authorizationUrl?: string
  tokenUrl?: string
  clientId?: string
  clientSecret?: string
}

export const parseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw.trim())
  } catch {
    return null
  }
}

const isHttpScheme = (parsed: URL): boolean =>
  parsed.protocol === 'http:' || parsed.protocol === 'https:'

/**
 * Both offerable transports (`http`, `sse`) are HTTP endpoints, so the step no
 * longer branches on the protocol — the ws scheme branch left with the ws
 * option, and stdio's command field with stdio (see ./connector-transports).
 */
export const validateTransportStep = (raw: { url: string }): StepErrors => {
  const errors: StepErrors = {}
  const trimmed = raw.url.trim()
  if (!trimmed) {
    errors.url = 'URL is required'
    return errors
  }
  const parsed = parseUrl(trimmed)
  if (!parsed) {
    errors.url = 'Invalid URL'
    return errors
  }
  if (!isHttpScheme(parsed)) {
    errors.url = 'URL must use http:// or https:// scheme'
  }
  return errors
}

export const validateIdentityStep = (raw: {
  name: string
  label: string
}): StepErrors => {
  const errors: StepErrors = {}
  if (!raw.name.trim()) errors.name = 'Name is required'
  if (!raw.label.trim()) errors.label = 'Label is required'
  return errors
}

export const validateAuthStep = (
  method: McpCatalogAuthMethod,
  raw: {
    headerName: string
    authorizationUrl: string
    tokenUrl: string
    clientId: string
    clientSecret: string
  },
): StepErrors => {
  const errors: StepErrors = {}
  if (method === 'api_key') {
    if (!raw.headerName.trim()) errors.headerName = 'Header name is required'
  }
  if (method === 'oauth2') {
    const authParsed = parseUrl(raw.authorizationUrl)
    if (!authParsed) {
      errors.authorizationUrl = 'Authorization URL must be a valid URL'
    } else if (!isHttpScheme(authParsed)) {
      errors.authorizationUrl = 'Authorization URL must use http:// or https://'
    }
    const tokenParsed = parseUrl(raw.tokenUrl)
    if (!tokenParsed) {
      errors.tokenUrl = 'Token URL must be a valid URL'
    } else if (!isHttpScheme(tokenParsed)) {
      errors.tokenUrl = 'Token URL must use http:// or https://'
    }
    if (!raw.clientId.trim()) errors.clientId = 'Client ID is required'
    if (!raw.clientSecret.trim()) errors.clientSecret = 'Client Secret is required'
  }
  return errors
}

export const clearStepError = <K extends keyof StepErrors>(
  prev: StepErrors,
  key: K,
): StepErrors => {
  if (!(key in prev)) return prev
  const next = { ...prev }
  delete next[key]
  return next
}

export type WizardStep = 'transport' | 'identity' | 'auth'

export type WizardInputs = {
  authMethod: McpCatalogAuthMethod
  url: string
  name: string
  label: string
  headerName: string
  authorizationUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
}

/**
 * Run all three step validators in step order. Returns the first failing
 * step (so the wizard can re-route the user) along with its errors, or null
 * if every step passes.
 */
export const firstWizardStepError = (
  raw: WizardInputs,
): { step: WizardStep; errors: StepErrors } | null => {
  const transport = validateTransportStep(raw)
  if (Object.keys(transport).length > 0) return { step: 'transport', errors: transport }
  const identity = validateIdentityStep(raw)
  if (Object.keys(identity).length > 0) return { step: 'identity', errors: identity }
  const auth = validateAuthStep(raw.authMethod, raw)
  if (Object.keys(auth).length > 0) return { step: 'auth', errors: auth }
  return null
}
