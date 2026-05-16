import type { McpCatalogAuthMethod, McpCatalogProtocol } from '@nessie/schemas'

/**
 * Pure validation module for {@link ./AddServerWizard.tsx}. Owns the per-step
 * error shape, the URL-parsing helper, and the three step validators. No React
 * or DOM dependencies — keep it that way so the wizard component can stay under
 * the 500-line architectural cap.
 */

export type StepErrors = {
  url?: string
  command?: string
  name?: string
  label?: string
  headerName?: string
  authorizationUrl?: string
  tokenUrl?: string
}

export const parseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw.trim())
  } catch {
    return null
  }
}

export const validateTransportStep = (
  protocol: McpCatalogProtocol,
  raw: { url: string; command: string },
): StepErrors => {
  const errors: StepErrors = {}
  if (protocol === 'stdio') {
    if (!raw.command.trim()) {
      errors.command = 'Command is required'
    }
    return errors
  }
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
  if (protocol === 'ws' && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    errors.url = 'URL must use ws:// or wss:// scheme'
    return errors
  }
  if (
    (protocol === 'http' || protocol === 'sse')
    && parsed.protocol !== 'http:'
    && parsed.protocol !== 'https:'
  ) {
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
  raw: { headerName: string; authorizationUrl: string; tokenUrl: string },
): StepErrors => {
  const errors: StepErrors = {}
  if (method === 'api_key') {
    if (!raw.headerName.trim()) errors.headerName = 'Header name is required'
  }
  if (method === 'oauth2') {
    if (!parseUrl(raw.authorizationUrl)) {
      errors.authorizationUrl = 'Authorization URL must be a valid URL'
    }
    if (!parseUrl(raw.tokenUrl)) {
      errors.tokenUrl = 'Token URL must be a valid URL'
    }
  }
  return errors
}
