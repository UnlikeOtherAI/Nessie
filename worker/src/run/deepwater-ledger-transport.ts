import type { PrismaClient } from '@prisma/client'
import {
  buildAuthorizedTransport,
  EnvSecretResolver,
  type SecretResolver,
} from '@nessie/mcp-manage'
import type {
  LedgerAttribution,
  LedgerIdentityService,
} from '@nessie/runtime'
import type { McpTransportConfig } from '@nessie/schemas'

/**
 * The transport every DeepWater call takes to Ledger, shared by an agent run's
 * toolset and by the worker's own calls outside a run (the watch, delivery and
 * a person's brief actions; Water plan amendments-fable F7.1). One place
 * decides which connector is the managed DeepWater one, how its bearer app key
 * is applied, and which signed identity headers ride on each call, so the two
 * callers can never send Ledger different proof.
 */

/** Is this catalog entry the first-party DeepWater connector Nessie manages? */
export const isManagedDeepWaterCatalog = (catalog: {
  integratedProducts: Array<{ slug: string }>
  name: string
  visibility: string
}): boolean =>
  catalog.name === 'deep-water'
  && catalog.visibility === 'public'
  && catalog.integratedProducts.some((product) => product.slug === 'deep-water')

/**
 * Add the signed `X-Nessie-Context` and UOA delegation for one call. The
 * `toolCallId` is the stable idempotency key Ledger replays on, so a logical
 * retry must pass the same one.
 */
export const addDeepWaterIdentityHeaders = async (
  transport: McpTransportConfig,
  ledgerIdentity: LedgerIdentityService | null | undefined,
  attribution: LedgerAttribution,
  toolCallId: string,
): Promise<McpTransportConfig> => {
  if (!ledgerIdentity) {
    throw new Error('LEDGER_IDENTITY_UNCONFIGURED')
  }
  if (
    transport.transport === 'stdio'
    || !transport.headers?.Authorization
  ) {
    throw new Error('LEDGER_PROXY_TOKEN_UNSET')
  }
  if (!toolCallId.trim()) {
    throw new Error('LEDGER_TOOL_CALL_ID_REQUIRED')
  }
  const identityHeaders = await ledgerIdentity.requestHeaders(
    attribution,
    { requireUoaIdentity: true, toolCallId },
  )
  return {
    ...transport,
    headers: { ...(transport.headers ?? {}), ...identityHeaders },
  }
}

const defaultSecretResolver = new EnvSecretResolver()

/**
 * The authorised transport of one team's managed DeepWater connector, or null
 * when it is gone or no longer the managed first-party one (a disabled team,
 * a paused connector). The bearer is Nessie's product-bound Ledger app key.
 */
export const loadDeepWaterConnectorTransport = async (
  prisma: Pick<PrismaClient, 'mcpServerInstance'>,
  input: { organizationId: string; connectorId: string },
  secretResolver: SecretResolver = defaultSecretResolver,
): Promise<McpTransportConfig | null> => {
  const instance = await prisma.mcpServerInstance.findFirst({
    where: { id: input.connectorId, organizationId: input.organizationId, lifecycleState: 'active' },
    select: {
      credentialRef: true,
      transportConfig: true,
      catalogEntry: {
        select: {
          authConfig: true,
          defaultTransportConfig: true,
          name: true,
          visibility: true,
          integratedProducts: { select: { slug: true } },
        },
      },
    },
  })
  if (!instance || !isManagedDeepWaterCatalog(instance.catalogEntry)) return null
  const secret = instance.credentialRef ? await secretResolver.resolve(instance.credentialRef) : null
  return buildAuthorizedTransport({
    catalogDefaultTransportConfig: instance.catalogEntry.defaultTransportConfig,
    instanceTransportConfig: instance.transportConfig,
    authConfig: instance.catalogEntry.authConfig,
    secret,
  })
}
