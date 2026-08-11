import type { PrismaClient } from '@prisma/client'

import type { LedgerAttribution } from './ledger.js'
import {
  createUoaDelegatedIdentityService,
  loadUoaDelegatedIdentitySettings,
  loadUoaProductIdentity,
  UoaDelegatedIdentityError,
  type UoaDelegatedIdentitySettings,
  type UoaProductIdentity,
} from './uoa-delegated-identity.js'

const DEEP_WATER_PRODUCT_SLUG = 'deep-water'
const DEFAULT_LEDGER_AUDIENCE = 'https://ledger.unlikeotherai.com'

type LedgerIdentityPrisma = Pick<PrismaClient, 'productAccountLink' | 'team'>

export type LedgerIdentitySettings = UoaDelegatedIdentitySettings & {
  ledgerAudience: string
}

export type LedgerIdentityHeadersOptions = {
  delegationScope?: 'ai.invoke' | 'billing.read'
  requireUoaIdentity?: boolean
  toolCallId?: string | null
}

export type LedgerUoaIdentity = UoaProductIdentity

export type LedgerIdentityService = {
  requestHeaders: (
    attribution: LedgerAttribution,
    options?: LedgerIdentityHeadersOptions,
  ) => Promise<Record<string, string>>
}

export class LedgerIdentityError extends Error {
  constructor(
    public readonly code:
      | 'LEDGER_IDENTITY_UNCONFIGURED'
      | 'LEDGER_UOA_IDENTITY_REQUIRED'
      | 'LEDGER_UOA_TOKEN_EXCHANGE_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'LedgerIdentityError'
  }
}

const envValue = (env: NodeJS.ProcessEnv, name: string): string | null => {
  const value = env[name]?.trim()
  return value ? value : null
}

/**
 * Load the shared UOA signer plus Ledger's audience.
 *
 * Null means this deployment configured no signer at all, and it is the ONLY
 * condition under which a Ledger call may go out unsigned. Ledger authenticates
 * the caller by its own bearer token and decides per token whether signed
 * provenance is additionally required, so a deployment holding nothing but a
 * Ledger API key dispatches bearer-only and lets Ledger answer 401 if that token
 * demands more. Nessie must not guess that answer on Ledger's behalf.
 *
 * A configured signer is the opposite: every Ledger call signs, and a request
 * whose originating user has no linked UOA identity still fails closed. The
 * choice is made once from process env at startup — never per request, per
 * organization, or per user — so no caller can downgrade a signing deployment.
 */
export const loadLedgerIdentitySettings = (
  env: NodeJS.ProcessEnv = process.env,
): LedgerIdentitySettings | null => {
  const delegated = loadUoaDelegatedIdentitySettings(env)
  if (!delegated) return null
  return {
    ...delegated,
    ledgerAudience:
      envValue(env, 'LEDGER_PUBLIC_URL')?.replace(/\/$/, '')
      ?? DEFAULT_LEDGER_AUDIENCE,
  }
}

export const loadLedgerUoaIdentity = async (
  prisma: LedgerIdentityPrisma,
  attribution: LedgerAttribution,
): Promise<LedgerUoaIdentity | null> =>
  loadUoaProductIdentity(prisma, attribution, DEEP_WATER_PRODUCT_SLUG)

const mapIdentityError = (error: unknown): never => {
  if (!(error instanceof UoaDelegatedIdentityError)) {
    throw error
  }
  if (
    error.code === 'UOA_IDENTITY_REQUIRED'
    || error.code === 'UOA_ACTIVE_WORKSPACE_REQUIRED'
  ) {
    throw new LedgerIdentityError(
      'LEDGER_UOA_IDENTITY_REQUIRED',
      'Ledger requires a linked UnlikeOtherAI SSO identity for the originating user.',
    )
  }
  throw new LedgerIdentityError(
    'LEDGER_UOA_TOKEN_EXCHANGE_FAILED',
    error.message,
  )
}

export const createLedgerIdentityService = (input: {
  prisma: LedgerIdentityPrisma
  settings: LedgerIdentitySettings
  fetchImpl?: typeof fetch
  now?: () => number
}): LedgerIdentityService => {
  const delegated = createUoaDelegatedIdentityService(input)
  return {
    async requestHeaders(attribution, options = {}) {
      try {
        return await delegated.requestHeaders(attribution, {
          accountLinkProductSlug: DEEP_WATER_PRODUCT_SLUG,
          audience: input.settings.ledgerAudience,
          delegationScope: options.delegationScope ?? 'ai.invoke',
          requireUoaIdentity: options.requireUoaIdentity,
          toolCallId: options.toolCallId,
        })
      } catch (error) {
        return mapIdentityError(error)
      }
    },
  }
}

export const createLedgerIdentityServiceFromEnv = (
  prisma: LedgerIdentityPrisma,
  env: NodeJS.ProcessEnv = process.env,
): LedgerIdentityService | null => {
  const settings = loadLedgerIdentitySettings(env)
  return settings ? createLedgerIdentityService({ prisma, settings }) : null
}

export const isLedgerEndpoint = (
  url: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  if (!url) return false
  const audience =
    envValue(env, 'LEDGER_PUBLIC_URL')?.replace(/\/$/, '')
    ?? DEFAULT_LEDGER_AUDIENCE
  try {
    return new URL(url).origin === new URL(audience).origin
  } catch {
    return false
  }
}

/**
 * Ledger's generic provider proxy is `/v1/:serviceId/*`. The deployment may
 * configure the canonical OpenAI route as its base URL; every inference
 * service rewrites that final service segment to the provider selected for the
 * actual stage so Kimi, MiniMax, and custom adapters cannot fall through the
 * OpenAI route.
 */
export const resolveLedgerServiceBaseUrl = (
  baseUrl: string | null | undefined,
  serviceId: string,
): string | undefined => {
  if (!baseUrl || !isLedgerEndpoint(baseUrl)) {
    return baseUrl ?? undefined
  }
  const normalizedServiceId = serviceId.trim()
  if (!normalizedServiceId || normalizedServiceId.includes('/')) {
    throw new Error('Ledger inference serviceId must be a non-empty URL segment.')
  }
  const url = new URL(baseUrl)
  url.pathname = `/v1/${encodeURIComponent(normalizedServiceId)}`
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}
