import type {
  NormalisedItem,
  OutboundChange,
  SyncCheckpoint,
  SyncPage,
} from './items.js'
import type {
  WebhookDelivery,
  WebhookRegistration,
  WebhookRequest,
  WebhookSecrets,
} from './webhook.js'

/** The providers this codebase can speak to. Matches `BoardSourceProvider`. */
export type BoardSourceProvider = 'jira' | 'linear' | 'trello' | 'github'

export type CredentialBundle = {
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  scopes: string[]
}

/**
 * What an adapter needs to make one call: the decrypted credential and the
 * identity it belongs to. Adapters never touch Prisma or the secret store.
 */
export type ConnectionContext = {
  connectionId: string
  organizationId: string
  ownerUserId: string
  provider: BoardSourceProvider
  externalAccountId: string
  externalTenantId: string
  credential: CredentialBundle
}

/** One external container a person can attach: a Jira project, Linear team, … */
export type ContainerDescriptor = {
  /** The adapter's canonical string form, unique within the provider. */
  key: string
  /** The provider-specific object persisted as `BoardSource.container`. */
  container: Record<string, unknown>
  label: string
  /** A second line for the picker — the site, the org, the repo owner. */
  hint?: string
}

export type ContainerState = {
  id: string
  name: string
  /** The adapter's own reading of what this state means, used to seed mappings. */
  suggestedCategory: 'todo' | 'in_progress' | 'review' | 'done' | 'archived' | null
}

export type ContainerField = {
  key: string
  label: string
  /** Which of the seven custom-field types this external field lands in. */
  type: 'text' | 'number' | 'date' | 'url' | 'select' | 'multi_select' | 'user'
  options?: { id: string; label: string }[]
}

export type ContainerMember = {
  externalUserId: string
  displayName: string
  /** Only where the provider exposes it; used for exact-equality auto-matching. */
  email?: string
}

export type ContainerDescription = {
  states: ContainerState[]
  fields: ContainerField[]
  members: ContainerMember[]
}

export type OAuthExchangeInput = {
  code: string
  redirectUri: string
  codeVerifier?: string
}

export type ConnectResult = {
  externalAccountId: string
  externalTenantId: string
  credential: CredentialBundle
  grantedScopes: string[]
}

/** How a credential was obtained. Persisted, because the remedies differ. */
export type BoardSourceAuthMethodKind = 'oauth' | 'api_key'

/**
 * One field of a pasted credential. `secret` is write-only and never returned
 * by any route; the rest are stored in the clear because they are addresses
 * and identifiers, not secrets.
 */
export type CredentialField = {
  key: string
  label: string
  kind: 'secret' | 'text' | 'email' | 'url'
  /** Rendered under the field. Says where the value comes from, in words. */
  help?: string
  placeholder?: string
}

/**
 * What the admin renders. Declared by the adapter rather than hand-written per
 * provider, because the providers genuinely differ — one field for Linear, two
 * for Trello, four for Jira Cloud — and a form per vendor is four ways to drift.
 */
export type CredentialForm = {
  /** Where the person creates the credential. Linked from the form. */
  createUrl: string
  /** What that page is called, so the link can be a sentence rather than a URL. */
  createLabel: string
  fields: CredentialField[]
}

export type ApiKeyMethod = {
  readonly form: CredentialForm
  /**
   * Prove the pasted values work and say whose account they are. The adapter
   * composes the stored credential from the fields — Jira's is `email:token`,
   * Linear's is the key itself — so no route ever learns a provider's shape.
   *
   * Throws `SourceCredentialRejectedError` when the provider refuses them.
   */
  verify(values: Record<string, string>): Promise<ConnectResult>
}

export type OAuthMethod = {
  buildAuthorizeUrl(input: {
    state: string
    redirectUri: string
    codeChallenge?: string
  }): string
  exchange(input: OAuthExchangeInput): Promise<ConnectResult>
  refresh(credential: CredentialBundle): Promise<CredentialBundle>
}

/**
 * At least one method, enforced by `registerBoardSourceAdapter`. Both optional
 * rather than a discriminating flag: a route asks "is there an `apiKey`?" and
 * branches on the answer, instead of every consumer switching on a kind.
 */
export type BoardSourceAuthMethods = {
  oauth?: OAuthMethod
  apiKey?: ApiKeyMethod
}

/**
 * The contract every provider adapter implements — strictly the connector
 * layer: authentication, retrieval, normalisation, webhooks and one write. No
 * mapping decisions, no Nessie identity, no Prisma. Those live in
 * `@nessie/team-admin` `board-source-apply.ts`, which is the same boundary the
 * communications connector draws.
 */
export interface BoardSourceAdapter {
  readonly provider: BoardSourceProvider

  /**
   * Opt into the periodic incremental sweep. A provider with reliable webhooks
   * still declares one as the fallback, so a missed delivery costs freshness
   * rather than correctness.
   */
  readonly incrementalPollingIntervalMs?: number

  /** Hosts this adapter may reach. Enforced by `sourceFetch`. */
  readonly allowedHosts: readonly string[]

  /**
   * How a person may connect this provider. At least one method is present;
   * which ones depends on the vendor and on what the deployment configured.
   * Nothing outside this object ever asks how a credential was born.
   */
  readonly auth: BoardSourceAuthMethods

  listContainers(ctx: ConnectionContext): Promise<ContainerDescriptor[]>

  describeContainer(
    ctx: ConnectionContext,
    container: Record<string, unknown>,
  ): Promise<ContainerDescription>

  /** One page, from `checkpoint`. Drives both the initial and incremental sync. */
  fetchPage(
    ctx: ConnectionContext,
    container: Record<string, unknown>,
    checkpoint: SyncCheckpoint,
    options: { syncWindowDays: number },
  ): Promise<SyncPage>

  /** Re-read specific items, after a webhook that carried ids only. */
  fetchItems(
    ctx: ConnectionContext,
    container: Record<string, unknown>,
    externalIds: string[],
  ): Promise<NormalisedItem[]>

  /** Register or refresh the vendor webhook; null when the provider has none. */
  ensureWebhook(
    ctx: ConnectionContext,
    container: Record<string, unknown>,
    callback: { url: string; token: string },
  ): Promise<WebhookRegistration | null>

  verifyWebhook(request: WebhookRequest, secrets: WebhookSecrets): boolean

  parseWebhook(request: WebhookRequest): WebhookDelivery

  /**
   * Apply one change upstream and return the vendor's echo. The mirror is
   * always written from the echo, never from the request, so what the board
   * shows is what the provider actually stored.
   */
  applyChange(
    ctx: ConnectionContext,
    container: Record<string, unknown>,
    item: { externalId: string; externalKey: string },
    change: OutboundChange,
  ): Promise<NormalisedItem>
}
