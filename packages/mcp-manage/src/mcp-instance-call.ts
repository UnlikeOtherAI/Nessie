import { McpClientManager, type McpToolResult } from '@nessie/mcp-client'
import { McpTransportConfigSchema, type McpTransportConfig } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import { applyAuthSecretToTransport, mcpAuthRequiresCredential } from './auth-apply.js'
import { resolveCredentialRef, type CredentialResolutionContext } from './mcp-credentials.js'
import { MCP_INSTANCE_ERROR_CODES, McpInstanceError } from './mcp-instance-errors.js'
import { assertMcpTransportSafe } from './mcp-security.js'
import { transportToConnectionSpec, type ManagerFactory } from './mcp-instance-probe.js'
import type { SecretResolver } from './secret-resolver.js'

/**
 * Shared "connect to one instance + call one tool" plumbing.
 *
 * Both the worker (the agent-loop MCP toolset + the external-conversation driver)
 * and the API (external-agent history hydration) need to turn a stored
 * `McpServerInstance` + its catalog entry into a ready-to-dispatch transport with
 * the right auth header applied, and to open a one-shot connection to call a
 * single tool. Keeping the transport-build + auth-apply + tool-call in one place
 * (alongside `probeConnection`, which already opens connections API-side) means
 * probe, the toolset, the driver, and hydration can never disagree about how a
 * credential becomes a header. Pure `@nessie/mcp-manage` internals — no worker or
 * API imports — so both sides consume the identical implementation.
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
  const parsed = McpTransportConfigSchema.safeParse({
    ...stringRecord(input.catalogDefaultTransportConfig),
    ...stringRecord(input.instanceTransportConfig),
  })
  if (!parsed.success) {
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
      `Resolved transport config is invalid: ${
        parsed.error.issues[0]?.message ?? 'shape mismatch'
      }`,
    )
  }
  return applyAuthSecretToTransport(parsed.data, input.authConfig, input.secret)
}

export type ResolvedMcpInstance = {
  transport: McpTransportConfig
  lifecycleState: string
  authMethod: string
}

/**
 * Load one MCP server instance + its catalog entry, resolve the per-principal
 * credential (7-level chain, OAuth-aware via the injected resolver), and return
 * a transport with auth applied. Returns `null` when the instance is missing
 * or an auth-requiring catalog entry has no resolvable credential, so callers
 * can surface a "needs setup" state rather than making an unauthenticated call.
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

  // A pending OAuth instance deliberately reaches the caller without a
  // credential so it can render its actionable sign-in state from
  // `lifecycleState`. It remains non-callable: every consumer checks that
  // state before opening a transport. Other auth-requiring instances fail
  // closed when their caller has no usable plaintext secret.
  const pendingOAuth =
    instance.catalogEntry.authMethod === 'oauth2'
    && instance.lifecycleState !== 'active'
  if (
    mcpAuthRequiresCredential(
      instance.catalogEntry.authMethod,
      instance.catalogEntry.authConfig,
    )
    && !secret
    && !pendingOAuth
  ) {
    return null
  }

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

const defaultManagerFactory: ManagerFactory = () => new McpClientManager()

/**
 * Open a one-shot connection to `transport` and call `toolName` with `args`,
 * returning the raw MCP tool result. The transport must already carry any auth
 * header (build it with {@link resolveInstanceMcpTransport}). The connection is
 * always closed, and the SSRF guard runs before any socket opens.
 */
export const callInstanceTool = async (input: {
  transport: McpTransportConfig
  toolName: string
  args: unknown
  timeoutMs?: number
  abort?: AbortSignal
  managerFactory?: ManagerFactory
}): Promise<McpToolResult> => {
  await assertMcpTransportSafe(input.transport)
  const manager = (input.managerFactory ?? defaultManagerFactory)()
  let connectionId: Awaited<ReturnType<McpClientManager['open']>> | null = null
  try {
    connectionId = await manager.open(transportToConnectionSpec(input.transport))
    return await manager.callTool(connectionId, input.toolName, input.args, {
      timeoutMs: input.timeoutMs,
      abort: input.abort,
    })
  } finally {
    if (connectionId) {
      await manager.close(connectionId).catch(() => undefined)
    }
    await manager.closeAll().catch(() => undefined)
  }
}
