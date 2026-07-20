import type { PrismaClient } from '@prisma/client'
import {
  createLedgerIdentityServiceFromEnv,
  LedgerIdentityError,
  type LedgerIdentityService,
} from '@nessie/runtime'
import {
  LedgerBillingUsageResponseSchema,
  NessieBillingUsageViewSchema,
  type AuthorizedActionContext,
  type LedgerBillingGroupBy,
  type NessieBillingUsageView,
} from '@nessie/schemas'
import {
  BillingWorkspaceError,
  resolveBillingWorkspace,
} from './billing-workspace.js'

export const NESSIE_LEDGER_BILLING_READ_KEY_ENV =
  'LEDGER_BILLING_READ_APP_KEY_NESSIE'

const NESSIE_PRODUCT = 'nessie'
const DEEP_WATER_PRODUCT_SLUG = 'deep-water'

type BillingUsagePrisma = Pick<
  PrismaClient,
  'productAccountLink' | 'team'
>

export class LedgerBillingUsageError extends Error {
  constructor(
    public readonly code:
      | 'LEDGER_BILLING_CONTEXT_MISMATCH'
      | 'LEDGER_BILLING_RESPONSE_INVALID'
      | 'LEDGER_BILLING_SSO_REQUIRED'
      | 'LEDGER_BILLING_UNCONFIGURED'
      | 'LEDGER_BILLING_UPSTREAM_REJECTED',
    message: string,
  ) {
    super(message)
    this.name = 'LedgerBillingUsageError'
  }
}

const envValue = (
  env: NodeJS.ProcessEnv,
  name: string,
): string | null => env[name]?.trim() || null

const requireBillingConfiguration = (
  env: NodeJS.ProcessEnv,
): { appKey: string; baseUrl: string } => {
  const appKey = envValue(env, NESSIE_LEDGER_BILLING_READ_KEY_ENV)
  const baseUrl = envValue(env, 'LEDGER_PUBLIC_URL')
  if (!appKey || !baseUrl) {
    throw new LedgerBillingUsageError(
      'LEDGER_BILLING_UNCONFIGURED',
      `Billing usage requires LEDGER_PUBLIC_URL and ${NESSIE_LEDGER_BILLING_READ_KEY_ENV}.`,
    )
  }
  const otherAppKeys = [
    envValue(env, 'LEDGER_PROXY_TOKEN'),
    envValue(env, 'NESSIE_MODEL_API_KEY'),
  ].filter((value): value is string => Boolean(value))
  if (otherAppKeys.includes(appKey)) {
    throw new LedgerBillingUsageError(
      'LEDGER_BILLING_UNCONFIGURED',
      `${NESSIE_LEDGER_BILLING_READ_KEY_ENV} must be a dedicated read-only Nessie app key.`,
    )
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new LedgerBillingUsageError(
      'LEDGER_BILLING_UNCONFIGURED',
      'LEDGER_PUBLIC_URL must be a valid URL.',
    )
  }
  return { appKey, baseUrl: parsedUrl.toString().replace(/\/$/, '') }
}

const labelsForBreakdown = async (
  prisma: BillingUsagePrisma,
  organizationId: string,
  groupBy: LedgerBillingGroupBy,
  dimensions: string[],
  team: { externalWorkspaceId: string | null; name: string },
): Promise<Record<string, string>> => {
  if (groupBy === 'team') {
    return team.externalWorkspaceId
      ? { [team.externalWorkspaceId]: team.name }
      : {}
  }
  if (groupBy !== 'user' || dimensions.length === 0) {
    return {}
  }
  const links = await prisma.productAccountLink.findMany({
    where: {
      organizationId,
      productSlug: DEEP_WATER_PRODUCT_SLUG,
      status: 'linked',
      uoaSub: { in: dimensions },
    },
    select: {
      uoaSub: true,
      user: { select: { displayName: true, email: true } },
    },
  })
  return Object.fromEntries(
    links.flatMap((link) =>
      link.uoaSub
        ? [[link.uoaSub, link.user.displayName || link.user.email]]
        : [],
    ),
  )
}

export const getLedgerBillingUsage = async (
  prisma: BillingUsagePrisma,
  actorContext: AuthorizedActionContext,
  input: { groupBy: LedgerBillingGroupBy; month: string },
  deps: {
    env?: NodeJS.ProcessEnv
    fetchImpl?: typeof fetch
    identityService?: LedgerIdentityService
  } = {},
): Promise<NessieBillingUsageView> => {
  const env = deps.env ?? process.env
  const config = requireBillingConfiguration(env)
  const fetchImpl = deps.fetchImpl ?? fetch
  const identityService =
    deps.identityService
    ?? createLedgerIdentityServiceFromEnv(prisma, env)
  if (!identityService) {
    throw new LedgerBillingUsageError(
      'LEDGER_BILLING_UNCONFIGURED',
      'Nessie UOA delegation signing is not configured.',
    )
  }

  let workspace: Awaited<ReturnType<typeof resolveBillingWorkspace>>
  try {
    workspace = await resolveBillingWorkspace(prisma, actorContext)
  } catch (error) {
    if (!(error instanceof BillingWorkspaceError)) throw error
    throw new LedgerBillingUsageError(
      error.code === 'BILLING_CONTEXT_MISMATCH'
        ? 'LEDGER_BILLING_CONTEXT_MISMATCH'
        : 'LEDGER_BILLING_SSO_REQUIRED',
      error.message,
    )
  }
  const { attribution, identity } = workspace

  let identityHeaders: Record<string, string>
  try {
    identityHeaders = await identityService.requestHeaders(attribution, {
      delegationScope: 'billing.read',
      requireUoaIdentity: true,
    })
  } catch (error) {
    if (
      error instanceof LedgerIdentityError
      && error.code === 'LEDGER_UOA_IDENTITY_REQUIRED'
    ) {
      throw new LedgerBillingUsageError(
        'LEDGER_BILLING_SSO_REQUIRED',
        error.message,
      )
    }
    throw new LedgerBillingUsageError(
      'LEDGER_BILLING_UPSTREAM_REJECTED',
      error instanceof Error
        ? error.message
        : 'UOA delegation exchange failed.',
    )
  }

  const url = new URL('/v1/billing/usage', config.baseUrl)
  url.searchParams.set('month', input.month)
  url.searchParams.set('organization_id', identity.organizationId)
  url.searchParams.set('team_id', identity.teamId)
  url.searchParams.set('group_by', input.groupBy)
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        ...identityHeaders,
        // App identity is deployment-owned. Delegated user/context headers must
        // never be able to replace the product-bound Nessie credential.
        'X-Ledger-App-Key': config.appKey,
      },
    })
  } catch {
    throw new LedgerBillingUsageError(
      'LEDGER_BILLING_UPSTREAM_REJECTED',
      'Ledger billing usage is temporarily unavailable.',
    )
  }
  if (!response.ok) {
    throw new LedgerBillingUsageError(
      'LEDGER_BILLING_UPSTREAM_REJECTED',
      `Ledger rejected the billing usage request with status ${response.status}.`,
    )
  }

  let responseBody: unknown
  try {
    responseBody = await response.json()
  } catch {
    throw new LedgerBillingUsageError(
      'LEDGER_BILLING_RESPONSE_INVALID',
      'Ledger returned a non-JSON billing usage response.',
    )
  }
  const parsed = LedgerBillingUsageResponseSchema.safeParse(responseBody)
  if (
    !parsed.success
    || parsed.data.product !== NESSIE_PRODUCT
    || parsed.data.scope.organizationId !== identity.organizationId
    || parsed.data.scope.teamId !== identity.teamId
    || parsed.data.scope.month !== input.month
    || parsed.data.groupBy !== input.groupBy
  ) {
    throw new LedgerBillingUsageError(
      'LEDGER_BILLING_RESPONSE_INVALID',
      'Ledger returned an invalid or mismatched billing usage response.',
    )
  }

  const dimensions = [
    ...new Set(
      parsed.data.breakdown
        .map((row) => row.dimension)
        .filter((dimension): dimension is string => Boolean(dimension)),
    ),
  ]
  const dimensionLabels = await labelsForBreakdown(
    prisma,
    actorContext.tenant.organizationId,
    input.groupBy,
    dimensions,
    {
      externalWorkspaceId: workspace.externalTeamId,
      name: workspace.teamName,
    },
  )
  return NessieBillingUsageViewSchema.parse({
    ...parsed.data,
    display: {
      dimensionLabels,
      organizationName: workspace.organizationName,
      teamName: workspace.teamName,
    },
  })
}
