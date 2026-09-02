import type { ModelSubscriptionProvider } from '@prisma/client'

/**
 * Personal model subscriptions — a person links their own consumer AI plan and
 * the agents THEY own run on it, instead of on the organization's Ledger
 * credits.
 *
 * Spec: docs/plans/2026-09-02-personal-model-subscriptions.md
 */

/** The adapter keys, identical to the Prisma enum so neither can drift. */
export type SubscriptionProviderKey = ModelSubscriptionProvider

/**
 * How a person proves the subscription is theirs. `api_key` is a pasted
 * console key; `oauth_device` is Nessie's OWN device-code grant (phase 2) —
 * never an import of a vendor CLI's stored credentials, because two apps
 * sharing one grant rotate each other out.
 */
export type SubscriptionAuthStrategy = 'api_key' | 'oauth_device'

/**
 * The token material for one link. Lives in the vault as a single
 * self-describing JSON value, so the vault alone is authoritative and a
 * partially-updated pair is not representable.
 */
export type SubscriptionCredentialBundle = {
  accessToken: string
  refreshToken?: string
  /** Epoch milliseconds. Absent for a key that does not expire. */
  expiresAt?: number
  tokenType?: string
  scope?: string
}

/** What a probe learned about the account behind a credential. */
export type SubscriptionAccountIdentity = {
  /** Stable account identity. Relink refuses a different one. */
  providerAccountId: string
  /** Human label for the account picker. Never a credential. */
  accountLabel?: string
}

export type SubscriptionModelOption = {
  model: string
  displayName: string
  description?: string
}

/**
 * A provider adapter. Everything a subscription needs to be linked, verified,
 * refreshed and dispatched, declared in code — never configured by a caller,
 * so no model- or user-supplied value can become an egress address.
 */
export type SubscriptionProviderAdapter = {
  key: SubscriptionProviderKey
  displayName: string
  authStrategy: SubscriptionAuthStrategy
  transport: {
    /** Which compiled connector carries this provider's wire protocol. */
    runtimeProvider: 'openai' | 'openai-compatible' | 'kimi' | 'deepseek'
    /** Code constant. The one allowed origin for this adapter's dispatch. */
    baseUrl: string
  }
  models: SubscriptionModelOption[]
  /** Rendered verbatim in the linking UI before a person commits. */
  termsNote: string
  /**
   * Probe the credential and learn whose account it is. Deliberately takes no
   * injectable fetch: every adapter reaches its provider through `safeFetch`,
   * so no test seam can become a way around IP pinning.
   */
  verify: (
    bundle: SubscriptionCredentialBundle,
  ) => Promise<SubscriptionAccountIdentity>
  /** OAuth adapters only. Absent means the credential never rotates. */
  refresh?: (
    bundle: SubscriptionCredentialBundle,
  ) => Promise<SubscriptionCredentialBundle>
  /**
   * Classify a provider HTTP failure. Only `auth` transitions a link to
   * `needs_reauthorization`: providers reuse 403 for missing entitlement,
   * policy and content refusals too, and disabling a healthy grant with the
   * wrong remedy is the failure this separation exists to prevent.
   */
  classifyFailure: (input: {
    status: number
    body?: unknown
  }) => SubscriptionFailureKind
}

export type SubscriptionFailureKind =
  | 'auth'
  | 'quota'
  | 'entitlement'
  | 'policy'
  | 'transient'
  | 'unknown'

export const SUBSCRIPTION_ERROR_CODES = {
  ACCOUNT_MISMATCH: 'MODEL_SUBSCRIPTION_ACCOUNT_MISMATCH',
  ADAPTER_UNKNOWN: 'MODEL_SUBSCRIPTION_ADAPTER_UNKNOWN',
  CREDENTIAL_MISSING: 'MODEL_SUBSCRIPTION_CREDENTIAL_MISSING',
  EPOCH_CONFLICT: 'MODEL_SUBSCRIPTION_EPOCH_CONFLICT',
  NOT_ACTIVE: 'MODEL_SUBSCRIPTION_NOT_ACTIVE',
  NOT_FOUND: 'MODEL_SUBSCRIPTION_NOT_FOUND',
  OWNER_INACTIVE: 'MODEL_SUBSCRIPTION_OWNER_INACTIVE',
  REFRESH_INDETERMINATE: 'MODEL_SUBSCRIPTION_REFRESH_INDETERMINATE',
  VAULT_UNAVAILABLE: 'MODEL_SUBSCRIPTION_VAULT_UNAVAILABLE',
  VERIFY_FAILED: 'MODEL_SUBSCRIPTION_VERIFY_FAILED',
} as const

export type SubscriptionErrorCode =
  (typeof SUBSCRIPTION_ERROR_CODES)[keyof typeof SUBSCRIPTION_ERROR_CODES]

export class ModelSubscriptionError extends Error {
  override readonly name = 'ModelSubscriptionError'

  constructor(
    readonly code: SubscriptionErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message)
  }
}
