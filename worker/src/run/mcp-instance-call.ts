import {
  applyAuthSecretToTransport,
  resolveCredentialRef,
  type CredentialResolutionContext,
  type SecretResolver,
} from '@nessie/mcp-manage'
import type { PrismaClient } from '@prisma/client'
import type { McpTransportConfig } from '@nessie/schemas'

import { parseMcpTransportConfig } from './tool-dispatch.js'

/**
 * Shared "connect + call one tool on one instance" plumbing.
 *
 * The MCP toolset (agent loop) and the external-conversation driver both need
 * to turn a stored `McpServerInstance` + its catalog entry into a
 * ready-to-dispatch transport with the right auth header applied. Keeping the
 * transport-build + auth-apply in one place means probe (API), the toolset, and
 * the driver can never disagree about how a credential becomes a header.
 */

const stringRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * Merge a catalog entry's default transport config with the instance override,
 * parse it into a typed transport, and apply the resolved secret as the auth
 * header the catalog's `authConfig` dictates. Pure — no I/O.
 */
export const buildAuthorizedTransport = (input: {
  catalogDefaultTransportConfig: unknown
  instanceTransportConfig: unknown
  authConfig: unknown
  secret: string | null
}): McpTransportConfig => {
  const transport = parseMcpTransportConfig({
    ...stringRecord(input.catalogDefaultTransportConfig),
    ...stringRecord(input.instanceTransportConfig),
  })
  return applyAuthSecretToTransport(transport, input.authConfig, input.secret)
}

export type ResolvedMcpInstance = {
  transport: McpTransportConfig
  lifecycleState: string
  authMethod: string
}

/**
 * Load one MCP server instance + its catalog entry, resolve the per-principal
 * credential (7-level chain, OAuth-aware via the injected resolver), and return
 * a transport with auth applied. Returns `null` when the instance is missing so
 * callers can surface a "needs setup" state rather than throw.
 */
export const resolveInstanceMcpTransport = async (
  prisma: PrismaClient,
  instanceId: string,
  credentialContext: CredentialResolutionContext,
  secretResolver: SecretResolver,
): Promise<ResolvedMcpInstance | null> => {
  const instance = await prisma.mcpServerInstance.findUnique({
    where: { id: instanceId },
    select: {
      transportConfig: true,
      lifecycleState: true,
      catalogEntry: {
        select: { authConfig: true, authMethod: true, defaultTransportConfig: true },
      },
    },
  })
  if (!instance || !instance.catalogEntry) {
    return null
  }

  const credentialRef = await resolveCredentialRef(prisma, instanceId, credentialContext)
  const secret = credentialRef ? await secretResolver.resolve(credentialRef) : null

  return {
    transport: buildAuthorizedTransport({
      catalogDefaultTransportConfig: instance.catalogEntry.defaultTransportConfig,
      instanceTransportConfig: instance.transportConfig,
      authConfig: instance.catalogEntry.authConfig,
      secret,
    }),
    lifecycleState: instance.lifecycleState,
    authMethod: instance.catalogEntry.authMethod,
  }
}
