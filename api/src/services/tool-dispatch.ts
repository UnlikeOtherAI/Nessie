import type { PrismaClient } from '@prisma/client'
import {
  ToolTransportConfigSchema,
  type ToolTransportConfig,
} from '@nessie/schemas'

import { resolveCredentialRef } from '@nessie/mcp-manage'
import type { CredentialResolutionContext } from '@nessie/mcp-manage'
import { hasAllowedGrantForPrincipals } from './tool-grants.js'
import { NullSecretResolver, type SecretResolver } from '@nessie/mcp-manage'
import {
  McpSecurityError,
  assertUserAuthoredMcpTransportSafe,
} from '@nessie/mcp-manage'

/**
 * API-side tool dispatch orchestration (plan §5/§6).
 *
 * Responsibilities, in order:
 *   1. Load the `ToolRegistryEntry` row + decode its `transportConfig`.
 *   2. Reject calls when the entry is not `active` or not `enabled`.
 *   3. Reject when no `ToolGrant` for the calling principal chain is `allowed`.
 *   4. For MCP transport: walk the 7-level `resolveCredentialRef` chain to find
 *      the right opaque ref, then ask the `SecretResolver` for plaintext.
 *   5. Return a `DispatchPlan` describing exactly what the worker should call
 *      and with what secret. The plaintext NEVER touches the DB or audit log.
 *
 * The actual transport call lives in `worker/src/run/tool-dispatch.ts`. Keeping
 * resolution here ensures every dispatch path goes through the same grant +
 * credential gating.
 */

export const TOOL_DISPATCH_ERROR_CODES = {
  TOOL_NOT_FOUND: 'TOOL_DISPATCH_TOOL_NOT_FOUND',
  TOOL_DISABLED: 'TOOL_DISPATCH_TOOL_DISABLED',
  TOOL_PENDING_REVIEW: 'TOOL_DISPATCH_TOOL_PENDING_REVIEW',
  GRANT_DENIED: 'TOOL_DISPATCH_GRANT_DENIED',
  MCP_INSTANCE_NOT_FOUND: 'TOOL_DISPATCH_MCP_INSTANCE_NOT_FOUND',
  MCP_INSTANCE_INACTIVE: 'TOOL_DISPATCH_MCP_INSTANCE_INACTIVE',
  TRANSPORT_UNSUPPORTED: 'TOOL_DISPATCH_TRANSPORT_UNSUPPORTED',
  TRANSPORT_CONFIG_INVALID: 'TOOL_DISPATCH_TRANSPORT_CONFIG_INVALID',
  SECRET_UNAVAILABLE: 'TOOL_DISPATCH_SECRET_UNAVAILABLE',
} as const

export class ToolDispatchError extends Error {
  override readonly name = 'ToolDispatchError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

export type DispatchPrincipals = {
  roleIds?: string[]
  agentIds?: string[]
}

export type DispatchContext = {
  /**
   * Organization the caller belongs to. Used to scope the registry lookup so
   * org B cannot dispatch tools that belong exclusively to org A. Global
   * registry entries (`organizationId: null`) remain reachable to every org.
   */
  organizationId: string
  principals: DispatchPrincipals
  credentialContext: CredentialResolutionContext
}

/**
 * Resolved plan ready to hand off to `worker/src/run/tool-dispatch.ts`. We
 * model MCP and HTTP transports here because they're the two that flow through
 * the universal dispatcher; `direct` keeps using `executeBuiltinTool`.
 */
export type DispatchPlan =
  | {
      transport: 'mcp'
      toolName: string
      /** Untyped `McpServerInstance.transportConfig`; the worker validates it. */
      mcpInstance: {
        id: string
        transportConfig: unknown
        catalog: { defaultTransportConfig: unknown }
      }
      /** Plaintext secret resolved from the 7-level chain — DO NOT persist. */
      secret: string | null
    }
  | {
      transport: 'http'
      /** Worker-side `HttpToolEndpoint` payload (raw — worker validates). */
      endpoint: unknown
      /** Plaintext secret if the endpoint declares an auth block. */
      secret: string | null
    }

export type DispatchOptions = {
  secretResolver?: SecretResolver
}

const decodeTransportConfig = (value: unknown): ToolTransportConfig => {
  const parsed = ToolTransportConfigSchema.safeParse(value)
  if (!parsed.success) {
    throw new ToolDispatchError(
      TOOL_DISPATCH_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
      `Invalid tool transportConfig: ${parsed.error.issues[0]?.message ?? 'shape mismatch'}`,
    )
  }
  return parsed.data
}

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const mapSecurityError = (error: unknown): never => {
  if (error instanceof McpSecurityError) {
    throw new ToolDispatchError(
      TOOL_DISPATCH_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
      error.message,
    )
  }
  throw error
}

/**
 * Build a `DispatchPlan` for the given tool registry id. The caller is the API
 * tier (HTTP handler) or a worker dispatch boundary that has just received a
 * tool call from the agentic loop.
 */
export const planToolDispatch = async (
  prisma: PrismaClient,
  toolRegistryEntryId: string,
  context: DispatchContext,
  options: DispatchOptions = {},
): Promise<DispatchPlan> => {
  const entry = await prisma.toolRegistryEntry.findFirst({
    where: {
      id: toolRegistryEntryId,
      OR: [{ organizationId: null }, { organizationId: context.organizationId }],
    },
    select: {
      id: true,
      enabled: true,
      status: true,
      transport: true,
      transportConfig: true,
      mcpInstanceId: true,
    },
  })
  if (!entry) {
    throw new ToolDispatchError(
      TOOL_DISPATCH_ERROR_CODES.TOOL_NOT_FOUND,
      `Tool registry entry ${toolRegistryEntryId} not found`,
    )
  }
  if (!entry.enabled || entry.status === 'disabled') {
    throw new ToolDispatchError(
      TOOL_DISPATCH_ERROR_CODES.TOOL_DISABLED,
      `Tool ${toolRegistryEntryId} is disabled`,
    )
  }
  if (entry.status === 'pending_review') {
    throw new ToolDispatchError(
      TOOL_DISPATCH_ERROR_CODES.TOOL_PENDING_REVIEW,
      `Tool ${toolRegistryEntryId} is pending review`,
    )
  }

  const allowed = await hasAllowedGrantForPrincipals(
    prisma,
    toolRegistryEntryId,
    context.principals,
  )
  if (!allowed) {
    throw new ToolDispatchError(
      TOOL_DISPATCH_ERROR_CODES.GRANT_DENIED,
      'No allowed grant for the calling principals',
    )
  }

  const transportConfig = decodeTransportConfig(entry.transportConfig)
  // Default to NullSecretResolver: if no resolver is injected at boot, refs
  // resolve to `null` and the call arrives at the transport with `secret:
  // null`. The transport then fails loudly if auth was required, instead of
  // the old EnvSecretResolver default silently looking up opaque `secret_*`
  // refs as env-var names (always undefined → silent null). Production
  // callers MUST inject a concrete `SecretResolver` via
  // `options.secretResolver`.
  const secretResolver = options.secretResolver ?? new NullSecretResolver()

  switch (transportConfig.transport) {
    case 'mcp': {
      // The registry row's mcpInstanceId is the source of truth — the embedded
      // serverId on transportConfig should match. We trust the column to avoid
      // dual lookups.
      const instanceId = entry.mcpInstanceId ?? transportConfig.serverId
      const instance = await prisma.mcpServerInstance.findUnique({
        where: { id: instanceId },
        select: {
          id: true,
          credentialRef: true,
          lifecycleState: true,
          transportConfig: true,
          catalogEntry: { select: { defaultTransportConfig: true } },
        },
      })
      if (!instance) {
        throw new ToolDispatchError(
          TOOL_DISPATCH_ERROR_CODES.MCP_INSTANCE_NOT_FOUND,
          `MCP instance ${instanceId} not found`,
        )
      }
      if (instance.lifecycleState !== 'active') {
        throw new ToolDispatchError(
          TOOL_DISPATCH_ERROR_CODES.MCP_INSTANCE_INACTIVE,
          `MCP instance ${instanceId} is not active (state=${instance.lifecycleState})`,
        )
      }
      try {
        await assertUserAuthoredMcpTransportSafe({
          ...toRecord(instance.catalogEntry.defaultTransportConfig),
          ...toRecord(instance.transportConfig),
        })
      } catch (error) {
        mapSecurityError(error)
      }
      const ref = await resolveCredentialRef(prisma, instance.id, context.credentialContext)
      const secret = ref ? await secretResolver.resolve(ref) : null
      // A `null` secret is OK only when the credential chain explicitly chose
      // "no auth"; flagging that here would require knowing the catalog's
      // authMethod. We defer to the transport layer: it will fail loudly if
      // the server demands auth and none is provided.
      return {
        transport: 'mcp',
        toolName: transportConfig.toolName,
        mcpInstance: {
          id: instance.id,
          transportConfig: instance.transportConfig,
          catalog: { defaultTransportConfig: instance.catalogEntry.defaultTransportConfig },
        },
        secret,
      }
    }
    case 'http': {
      // HTTP tools store their endpoint shape in `transportConfig` keyed by
      // `endpointId`. The full endpoint payload lives on the bundle/tool row
      // metadata in a follow-up slice; for now we forward the raw value.
      const ref = entry.mcpInstanceId
        ? await resolveCredentialRef(
          prisma,
          entry.mcpInstanceId,
          context.credentialContext,
        )
        : null
      const secret = ref ? await secretResolver.resolve(ref) : null
      return {
        transport: 'http',
        endpoint: entry.transportConfig,
        secret,
      }
    }
    case 'direct':
    case 'stdio':
    case 'pty':
      throw new ToolDispatchError(
        TOOL_DISPATCH_ERROR_CODES.TRANSPORT_UNSUPPORTED,
        `Transport "${transportConfig.transport}" is not handled by the universal `
          + 'dispatcher; route through the builtin handler instead',
      )
    default: {
      const _never: never = transportConfig
      void _never
      throw new ToolDispatchError(
        TOOL_DISPATCH_ERROR_CODES.TRANSPORT_UNSUPPORTED,
        'Unknown transport',
      )
    }
  }
}
