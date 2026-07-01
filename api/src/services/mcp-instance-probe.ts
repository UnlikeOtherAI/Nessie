import { McpClientManager, type McpToolDescriptor } from '@nessie/mcp-client'
import {
  McpTransportConfigSchema,
  type McpTransportConfig,
} from '@nessie/schemas'

import { MCP_INSTANCE_ERROR_CODES, McpInstanceError } from './mcp-instance-errors.js'
import { assertMcpTransportSafe } from './mcp-security.js'
import { EnvSecretResolver, type SecretResolver } from './secret-resolver.js'
import type { McpInstanceRow } from './mcp-instances.js'

export const resolveInstanceTransport = (
  instance: McpInstanceRow,
  catalogEntry: { defaultTransportConfig: unknown },
): McpTransportConfig => {
  const toRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const merged = {
    ...toRecord(catalogEntry.defaultTransportConfig),
    ...toRecord(instance.transportConfig),
  }
  const parsed = McpTransportConfigSchema.safeParse(merged)
  if (!parsed.success) {
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
      `Resolved transport config is invalid: ${
        parsed.error.issues[0]?.message ?? 'shape mismatch'
      }`,
    )
  }
  return parsed.data
}

const transportToConnectionSpec = (
  config: McpTransportConfig,
): Parameters<McpClientManager['open']>[0] => {
  switch (config.transport) {
    case 'stdio':
      return {
        transport: 'stdio',
        command: config.command,
        args: config.args ?? [],
        env: config.env,
      }
    case 'http':
      return { transport: 'http', url: config.url, headers: config.headers }
    case 'sse':
      return { transport: 'sse', url: config.url, headers: config.headers }
    case 'ws':
      // The universal client supports stdio/http/sse only today (per plan
      // section 5 and packages/mcp-client/src/types.ts). Surface a typed
      // error rather than a silent crash so the UI can prompt for an alternative.
      throw new McpInstanceError(
        MCP_INSTANCE_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
        'ws transport is not yet supported by the MCP client',
      )
    default: {
      const _never: never = config
      void _never
      throw new McpInstanceError(
        MCP_INSTANCE_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
        'Unsupported MCP transport',
      )
    }
  }
}

export type ManagerFactory = () => McpClientManager

const defaultManagerFactory: ManagerFactory = () => new McpClientManager()
const defaultSecretResolver = new EnvSecretResolver()

const stringifyError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const applyBearerSecret = (
  transport: McpTransportConfig,
  secret: string | null,
): McpTransportConfig => {
  if (!secret || transport.transport === 'stdio') return transport
  return {
    ...transport,
    headers: {
      ...(transport.headers ?? {}),
      Authorization: `Bearer ${secret}`,
    },
  }
}

export const resolveProbeTransport = async (
  instance: McpInstanceRow,
  catalogEntry: {
    authMethod: string
    defaultTransportConfig: unknown
  },
  secretResolver: SecretResolver = defaultSecretResolver,
): Promise<McpTransportConfig> => {
  const transport = resolveInstanceTransport(instance, catalogEntry)
  if (catalogEntry.authMethod !== 'bearer' || !instance.credentialRef) {
    return transport
  }
  const secret = await secretResolver.resolve(instance.credentialRef)
  return applyBearerSecret(transport, secret)
}

/**
 * Structured outcome of a single probe attempt. Returned from `probeConnection`
 * and surfaced via `testInstance` so callers (route handler, admin UI) can
 * render lifecycle transitions accurately. `ok: true` means we opened the
 * connection, ran `tools/list`, and received a well-formed descriptor array
 * (which may legitimately be empty for a server that has not registered any
 * tools yet -- that is still a successful handshake).
 */
export type McpProbeResult = {
  ok: boolean
  error?: string
  latencyMs: number
  toolCount?: number
  descriptors?: McpToolDescriptor[]
}

/**
 * Run a one-shot probe against an already-resolved transport spec. Pure with
 * respect to Prisma: takes a `ManagerFactory` so tests can inject a fake
 * `McpClientManager` and assert on probe outcomes without touching the DB.
 *
 * A throw at any stage (transport, protocol, auth, timeout) is captured as
 * `{ ok: false, error }`. A return shape from `listTools` that is not an array
 * is treated as a malformed handshake -- also `ok: false`. Empty arrays are
 * considered a successful handshake.
 */
export const probeConnection = async (
  transport: McpTransportConfig,
  managerFactory: ManagerFactory = defaultManagerFactory,
): Promise<McpProbeResult> => {
  const manager = managerFactory()
  const startedAt = Date.now()
  try {
    await assertMcpTransportSafe(transport)
    const connectionId = await manager.open(transportToConnectionSpec(transport))
    try {
      const descriptors = await manager.listTools(connectionId)
      if (!Array.isArray(descriptors)) {
        return {
          ok: false,
          error: 'tools/list response was not an array',
          latencyMs: Date.now() - startedAt,
        }
      }
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        toolCount: descriptors.length,
        descriptors,
      }
    } finally {
      await manager.close(connectionId).catch(() => undefined)
    }
  } catch (error) {
    return {
      ok: false,
      error: stringifyError(error),
      latencyMs: Date.now() - startedAt,
    }
  } finally {
    await manager.closeAll().catch(() => undefined)
  }
}
