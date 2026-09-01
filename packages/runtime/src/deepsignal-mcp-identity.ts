import crypto from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import type { LedgerAttribution } from './ledger.js'
import { decryptWithKey, deriveSecretKey } from './secret-crypto.js'
import {
  createUoaDelegatedIdentityService,
  loadUoaDelegatedIdentitySettings,
  UoaDelegatedIdentityError,
} from './uoa-delegated-identity.js'

const DEEPSIGNAL_PRODUCT_SLUG = 'deepsignal'

/** The env-backed reference stored on every integration-managed instance. */
export const DEEPSIGNAL_MCP_CREDENTIAL_REF = 'DEEPSIGNAL_MCP_APP_KEY'
/** DeepSignal-issued app credentials are valid only at this product origin. */
export const DEEPSIGNAL_MCP_ORIGIN = 'https://api.deepsignal.live'

type DeepSignalIdentityPrisma = Pick<
  PrismaClient,
  | 'channel'
  | 'productAccountLink'
  | 'productTeamEnablement'
  | 'productWebhookSecret'
  | 'team'
>

export type DeepSignalMcpIdentityService = {
  credentialRef: typeof DEEPSIGNAL_MCP_CREDENTIAL_REF
  requestHeaders: (
    attribution: LedgerAttribution,
    options: { audience: string; toolCallId: string },
  ) => Promise<Record<string, string>>
  validateStoredCredentialSeparation: () => Promise<void>
}

export class DeepSignalMcpIdentityError extends Error {
  constructor(
    public readonly code:
      | 'DEEPSIGNAL_MCP_APP_KEY_REQUIRED'
      | 'DEEPSIGNAL_MCP_APP_KEY_INVALID'
      | 'DEEPSIGNAL_MCP_APP_KEY_REUSED'
      | 'DEEPSIGNAL_MCP_IDENTITY_UNCONFIGURED'
      | 'DEEPSIGNAL_MCP_ORIGIN_INVALID'
      | 'DEEPSIGNAL_MCP_PROVENANCE_REQUIRED'
      | 'DEEPSIGNAL_MCP_CHANNEL_WORKSPACE_MISMATCH'
      | 'DEEPSIGNAL_MCP_TEAM_NOT_ENABLED'
      | 'DEEPSIGNAL_MCP_UOA_IDENTITY_REQUIRED'
      | 'DEEPSIGNAL_MCP_UOA_EXCHANGE_FAILED'
      | 'DEEPSIGNAL_MCP_WEBHOOK_SECRET_CHECK_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'DeepSignalMcpIdentityError'
  }
}

const envValue = (env: NodeJS.ProcessEnv, name: string): string | null => {
  const value = env[name]?.trim()
  return value ? value : null
}

const requiresHostedAuth = (env: NodeJS.ProcessEnv): boolean =>
  (envValue(env, 'NESSIE_MODE') ?? 'local') !== 'local'

const SECRET_KEY_ENV_NAME =
  /(?:^|_)(?:API_KEYS?|APP_KEYS?|ACCESS_KEYS?(?:_ID)?|SECRETS?(?:_ACCESS_KEY)?)(?:$|_)/u
const SECRET_AUTH_ENV_NAME =
  /(?:^|_)(?:TOKENS?|PASSWORDS?|PRIVATE_KEYS?|P8)(?:$|_)/u
const SECRET_CONFIGURATION_ENV_NAME =
  /(?:^|_)(?:CREDENTIALS?|SERVICE_ACCOUNT|DATABASE_URL|DB_URL|REDIS_URL|DSN)(?:$|_)/u
const CREDENTIAL_LIST_ENV_NAME =
  /(?:^|_)(?:API_KEYS|APP_KEYS|ACCESS_KEYS|SECRETS|TOKENS|PASSWORDS|PRIVATE_KEYS|CREDENTIALS)(?:$|_)/u
const CREDENTIAL_URL_ENV_NAME =
  /(?:^|_)(?:DATABASE_URL|DB_URL|REDIS_URL|DSN)(?:$|_)/u

const isSecretEnvName = (name: string): boolean =>
  SECRET_KEY_ENV_NAME.test(name) ||
  SECRET_AUTH_ENV_NAME.test(name) ||
  SECRET_CONFIGURATION_ENV_NAME.test(name)

const decodeUrlCredential = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const credentialValues = (name: string, rawValue: string): string[] => {
  const values = new Set([rawValue.trim()])
  if (CREDENTIAL_LIST_ENV_NAME.test(name)) {
    let parsedList: unknown = null
    try {
      parsedList = JSON.parse(rawValue)
    } catch {
      // Comma/newline/semicolon lists are the common environment shape.
    }
    if (Array.isArray(parsedList)) {
      for (const value of parsedList) {
        if (typeof value === 'string') values.add(value.trim())
      }
    }
    for (const value of rawValue.split(/[,\n;]/u)) values.add(value.trim())
  }
  if (CREDENTIAL_URL_ENV_NAME.test(name)) {
    try {
      const url = new URL(rawValue)
      if (url.username) values.add(decodeUrlCredential(url.username))
      if (url.password) values.add(decodeUrlCredential(url.password))
    } catch {
      // The whole value is still compared when a connection string is not URL-shaped.
    }
  }
  return [...values].filter(Boolean)
}

/**
 * App keys are security principals, not a convenient shared secret. Scan every
 * configured secret-bearing environment variable so newly added DB, email,
 * admin, provider, push, storage, webhook, or signing credentials are covered
 * without relying on a hand-maintained allowlist.
 */
const reusedEnvCredential = (
  env: NodeJS.ProcessEnv,
  appKey: string,
): string | null => {
  for (const [name, rawValue] of Object.entries(env)) {
    if (name === DEEPSIGNAL_MCP_CREDENTIAL_REF || !isSecretEnvName(name)) {
      continue
    }
    if (
      rawValue
      && credentialValues(name, rawValue).some((value) => value === appKey)
    ) {
      return name
    }
  }
  return null
}

const assertAppKey = (env: NodeJS.ProcessEnv): boolean => {
  const appKey = envValue(env, DEEPSIGNAL_MCP_CREDENTIAL_REF)
  if (!appKey) {
    if (requiresHostedAuth(env)) {
      throw new DeepSignalMcpIdentityError(
        'DEEPSIGNAL_MCP_APP_KEY_REQUIRED',
        'Hosted Nessie requires its dedicated DeepSignal MCP application key.',
      )
    }
    return false
  }
  if (!/^dsk_[A-Za-z0-9_-]{24,}$/u.test(appKey)) {
    throw new DeepSignalMcpIdentityError(
      'DEEPSIGNAL_MCP_APP_KEY_INVALID',
      'The DeepSignal MCP application key has an invalid format.',
    )
  }
  const reused = reusedEnvCredential(env, appKey)
  if (reused) {
    throw new DeepSignalMcpIdentityError(
      'DEEPSIGNAL_MCP_APP_KEY_REUSED',
      `The DeepSignal MCP application key must be distinct from ${reused}.`,
    )
  }
  return true
}

const sameSecret = (left: string, right: string): boolean => {
  const leftDigest = crypto.createHash('sha256').update(left).digest()
  const rightDigest = crypto.createHash('sha256').update(right).digest()
  return crypto.timingSafeEqual(leftDigest, rightDigest)
}

/**
 * Build the strict DeepSignal caller identity once per process.
 *
 * Local development may omit the boundary entirely. Hosted/self-hosted modes
 * fail at startup when either the DeepSignal-issued Nessie app key or Nessie's
 * existing UOA signing/exchange configuration is absent.
 */
export const createDeepSignalMcpIdentityServiceFromEnv = (
  prisma: DeepSignalIdentityPrisma,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    fetchImpl?: typeof fetch
    now?: () => number
  } = {},
): DeepSignalMcpIdentityService | null => {
  const hasAppKey = assertAppKey(env)
  const settings = loadUoaDelegatedIdentitySettings(env)
  if (!settings) {
    if (requiresHostedAuth(env)) {
      throw new DeepSignalMcpIdentityError(
        'DEEPSIGNAL_MCP_IDENTITY_UNCONFIGURED',
        'Hosted DeepSignal MCP calls require configured UOA signing and client credentials.',
      )
    }
    return null
  }
  if (!hasAppKey) return null

  const appKey = envValue(env, DEEPSIGNAL_MCP_CREDENTIAL_REF)!
  const delegated = createUoaDelegatedIdentityService({
    prisma,
    settings,
    ...options,
  })
  return {
    credentialRef: DEEPSIGNAL_MCP_CREDENTIAL_REF,
    async validateStoredCredentialSeparation() {
      const rows = await prisma.productWebhookSecret.findMany({
        where: { productSlug: DEEPSIGNAL_PRODUCT_SLUG },
        select: { authTag: true, ciphertext: true, iv: true },
      })
      if (rows.length === 0) return

      const encryptionSecret = envValue(env, 'NESSIE_AUTH_SECRET')
      if (!encryptionSecret) {
        throw new DeepSignalMcpIdentityError(
          'DEEPSIGNAL_MCP_WEBHOOK_SECRET_CHECK_FAILED',
          'Cannot verify DeepSignal webhook-key separation without NESSIE_AUTH_SECRET.',
        )
      }
      const key = deriveSecretKey(encryptionSecret)
      for (const row of rows) {
        let webhookSecret: string
        try {
          webhookSecret = decryptWithKey(key, row)
        } catch {
          throw new DeepSignalMcpIdentityError(
            'DEEPSIGNAL_MCP_WEBHOOK_SECRET_CHECK_FAILED',
            'A stored DeepSignal webhook secret could not be verified.',
          )
        }
        if (sameSecret(appKey, webhookSecret)) {
          throw new DeepSignalMcpIdentityError(
            'DEEPSIGNAL_MCP_APP_KEY_REUSED',
            'The DeepSignal MCP application key must be distinct from every stored webhook secret.',
          )
        }
      }
    },
    async requestHeaders(attribution, options) {
      if (!attribution.requestId?.trim() || !options.toolCallId.trim()) {
        throw new DeepSignalMcpIdentityError(
          'DEEPSIGNAL_MCP_PROVENANCE_REQUIRED',
          'DeepSignal MCP calls require stable request and tool-call provenance.',
        )
      }
      let audience: string
      try {
        audience = new URL(options.audience).origin
      } catch {
        audience = ''
      }
      if (audience !== DEEPSIGNAL_MCP_ORIGIN) {
        throw new DeepSignalMcpIdentityError(
          'DEEPSIGNAL_MCP_ORIGIN_INVALID',
          `DeepSignal MCP credentials are pinned to ${DEEPSIGNAL_MCP_ORIGIN}.`,
        )
      }
      if (!attribution.teamId) {
        throw new DeepSignalMcpIdentityError(
          'DEEPSIGNAL_MCP_TEAM_NOT_ENABLED',
          'DeepSignal calls require an originating enabled Nessie team.',
        )
      }
      const userId =
        attribution.userId
        ?? (attribution.actorType === 'user' ? attribution.actorId : null)
      if (!userId) {
        throw new DeepSignalMcpIdentityError(
          'DEEPSIGNAL_MCP_PROVENANCE_REQUIRED',
          'DeepSignal calls require an originating Nessie user.',
        )
      }
      const [enablement, team] = await Promise.all([
        prisma.productTeamEnablement.findUnique({
          where: {
            organizationId_teamId_productSlug: {
              organizationId: attribution.organizationId,
              teamId: attribution.teamId,
              productSlug: DEEPSIGNAL_PRODUCT_SLUG,
            },
          },
          select: {
            enabled: true,
            externalOrgId: true,
            externalTeamId: true,
          },
        }),
        prisma.team.findFirst({
          where: {
            id: attribution.teamId,
            members: { some: { userId } },
            project: { organizationId: attribution.organizationId },
          },
          select: {
            externalOrgId: true,
            externalWorkspaceId: true,
          },
        }),
      ])
      if (
        !enablement?.enabled
        || !enablement.externalOrgId
        || !enablement.externalTeamId
        || !team?.externalOrgId
        || !team.externalWorkspaceId
        || enablement.externalOrgId !== team.externalOrgId
        || enablement.externalTeamId !== team.externalWorkspaceId
      ) {
        throw new DeepSignalMcpIdentityError(
          'DEEPSIGNAL_MCP_TEAM_NOT_ENABLED',
          'DeepSignal is not enabled for the originating Nessie/SSO team mapping.',
        )
      }
      if (attribution.channelId) {
        const channel = await prisma.channel.findFirst({
          where: {
            id: attribution.channelId,
            organizationId: attribution.organizationId,
          },
          select: { dmKey: true },
        })
        const expectedDmKey =
          team?.externalWorkspaceId
            ? `extagent:${DEEPSIGNAL_PRODUCT_SLUG}:${attribution.organizationId}:${userId}:${team.externalWorkspaceId}`
            : null
        if (!expectedDmKey || channel?.dmKey !== expectedDmKey) {
          throw new DeepSignalMcpIdentityError(
            'DEEPSIGNAL_MCP_CHANNEL_WORKSPACE_MISMATCH',
            'The DeepSignal conversation channel does not belong to the originating SSO workspace.',
          )
        }
      }
      try {
        return await delegated.requestHeaders(attribution, {
          accountLinkProductSlug: DEEPSIGNAL_PRODUCT_SLUG,
          audience,
          delegationScope: 'ai.invoke',
          requireActiveWorkspace: true,
          requireUoaIdentity: true,
          toolCallId: options.toolCallId,
        })
      } catch (error) {
        if (!(error instanceof UoaDelegatedIdentityError)) throw error
        if (
          error.code === 'UOA_IDENTITY_REQUIRED'
          || error.code === 'UOA_ACTIVE_WORKSPACE_REQUIRED'
        ) {
          throw new DeepSignalMcpIdentityError(
            'DEEPSIGNAL_MCP_UOA_IDENTITY_REQUIRED',
            'DeepSignal requires the linked SSO user and active organization/team.',
          )
        }
        throw new DeepSignalMcpIdentityError(
          'DEEPSIGNAL_MCP_UOA_EXCHANGE_FAILED',
          error.message,
        )
      }
    },
  }
}
