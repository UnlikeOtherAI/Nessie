import {
  buildAuthorizedTransport,
  buildMcpRunScopeContext,
  EnvSecretResolver,
  fingerprintMcpToolDescriptor,
  isMcpRegistryRowExposed,
  mcpToolDescriptorAnnotationsFromMetadata,
  mcpAuthRequiresCredential,
  resolveCredentialRefWithSource,
  type SecretResolver,
} from '@nessie/mcp-manage'
import {
  type LedgerAttribution,
  type LedgerIdentityService,
} from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  McpCatalogAuthMethod,
  McpTransportConfig,
} from '@nessie/schemas'
import {
  buildDeferredView,
  buildInlineView,
  DEFAULT_INLINE_TOOL_LIMIT,
  type McpToolsetView,
} from './mcp-toolset-deferred.js'
import type { DeepWaterHandoffGuard } from './deepwater-handoff-guard.js'
import type { DeepWaterRunBinder } from './deepwater-run-binder.js'
import {
  addDeepWaterIdentityHeaders,
  isManagedDeepWaterCatalog,
} from './deepwater-ledger-transport.js'
import {
  createMcpToolNameAllocator,
  MANAGED_DEEP_WATER_TOOL_NAMES,
} from './mcp-tool-names.js'
import { recordMcpConnectorUsage } from './mcp-usage.js'
import { isFatalToolExecutionError } from './tool-execution-errors.js'
import { dispatchTool } from './tool-dispatch.js'
import { summarizeToolInput } from './tool-util.js'
import type { AgenticToolResult } from './tools.js'
import type { ConsumedSourceSink } from './execute/disclosure-basis.js'

export type McpToolPolicy = Record<string, boolean> | null

type RegistryRow = {
  id: string
  toolId: string
  label: string
  description: string
  inputSchema: unknown
  outputSchema: unknown
  transportConfig: unknown
  metadata: unknown
  grants: Array<{ agentId: string | null; config: unknown; state: string }>
  mcpInstanceId: string | null
  mcpInstance: {
    credentialRef: string | null
    scopeType: string
    scopeId: string
    transportConfig: unknown
    catalogEntry: {
      label: string
      name: string
      visibility: string
      integratedProducts: Array<{ slug: string }>
      authMethod: McpCatalogAuthMethod
      authConfig: unknown
      defaultTransportConfig: unknown
    }
  } | null
}

const stringRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

const isManagedDeepWaterRow = (row: RegistryRow): boolean =>
  Boolean(
    row.mcpInstance
    && isManagedDeepWaterCatalog(row.mcpInstance.catalogEntry),
  )

const extractOriginalToolName = (row: RegistryRow): string | null => {
  const tc = stringRecord(row.transportConfig)
  if (typeof tc.toolName === 'string' && tc.toolName.length > 0) {
    return tc.toolName
  }
  // Fallback: toolId is `mcp:${instanceId}:${toolName}` — take everything after the last `:`.
  const idx = row.toolId.lastIndexOf(':')
  if (idx >= 0 && idx < row.toolId.length - 1) {
    return row.toolId.slice(idx + 1)
  }
  return null
}

export type McpToolEntry = {
  registryEntryId: string
  originalToolName: string
  exposedName: string
  description: string
  inputSchema: Record<string, unknown>
  instanceId: string
  connectorLabel: string
}

export type McpToolset = {
  entries: McpToolEntry[]
  /**
   * The Ledger names of the managed DeepWater tools that actually reached
   * this run (granted AND in scope) — the structural fact behind the research
   * routing block in the system prompt, which names only these.
   */
  managedResearchToolNames: ReadonlySet<string>
  /**
   * `inline` exposes every tool schema directly (small setups); `deferred`
   * exposes the mcp_find_tools / mcp_load_tools / mcp_drop_tools flow so a
   * large connector fleet doesn't flood the model's context with schemas.
   */
  mode: 'inline' | 'deferred'
  /**
   * Per-consumer presentation. The main loop and each delegate sub-agent
   * create their own view so loading schemas in one context never mutates
   * another. `view.descriptors` is LIVE — recompose the model's tool list
   * from it on every inference call.
   */
  createView: () => McpToolsetView
  /** Direct dispatch of a real MCP tool by exposed name (views wrap this). */
  dispatch: (
    exposedName: string,
    args: Record<string, unknown>,
    toolCallId?: string,
  ) => Promise<AgenticToolResult>
  timeoutErrorFor: (exposedName: string) => Error | null
}

const resolveInlineToolLimit = (override?: number): number => {
  if (typeof override === 'number' && override >= 0) return override
  const fromEnv = Number(process.env.NESSIE_MCP_INLINE_TOOL_LIMIT)
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_INLINE_TOOL_LIMIT
}

const defaultSecretResolver = new EnvSecretResolver()

export { addDeepWaterIdentityHeaders, isManagedDeepWaterCatalog }

export const buildMcpToolset = async (
  prisma: PrismaClient,
  organizationId: string,
  toolPolicy: McpToolPolicy,
  actorContext: AuthorizedActionContext,
  runtimeContext: {
    agentId: string
    agentKind: 'personal_assistant' | 'shared'
    channelId: string
    isPersonalAssistantPresence?: boolean
  },
  // Attribution for operational connector telemetry — every dispatched MCP
  // tool call writes a cost-free row keyed to its org/agent/channel/run. Ledger
  // owns raw provider metering and UOA alone supplies customer billing.
  attribution: LedgerAttribution,
  options: {
    consumedSources?: ConsumedSourceSink
    /** Test seam for the one worker-side transport call. */
    dispatchMcpTool?: typeof dispatchTool
    deepWaterHandoffGuard?: DeepWaterHandoffGuard
    /** Binds every DeepWater call outside a launcher handoff turn to its product run. */
    deepWaterRunBinder?: DeepWaterRunBinder
    ledgerIdentity?: LedgerIdentityService | null
    secretResolver?: SecretResolver
    inlineToolLimit?: number
  } = {},
): Promise<McpToolset> => {
  const secretResolver = options.secretResolver ?? defaultSecretResolver
  const rows = (await prisma.toolRegistryEntry.findMany({
    where: {
      organizationId,
      handlerKind: 'mcp',
      enabled: true,
      status: 'active',
    },
    select: {
      id: true,
      toolId: true,
      label: true,
      description: true,
      inputSchema: true,
      outputSchema: true,
      transportConfig: true,
      metadata: true,
      grants: {
        where: {
          agentId: runtimeContext.agentId,
          roleId: null,
          state: 'allowed',
        },
        select: { agentId: true, config: true, state: true },
      },
      mcpInstanceId: true,
      mcpInstance: {
        select: {
          credentialRef: true,
          scopeType: true,
          scopeId: true,
          transportConfig: true,
          catalogEntry: {
            select: {
              label: true,
              name: true,
              visibility: true,
              integratedProducts: { select: { slug: true } },
              authMethod: true,
              authConfig: true,
              defaultTransportConfig: true,
            },
          },
        },
      },
    },
  })) as unknown as RegistryRow[]

  const runScope = buildMcpRunScopeContext(actorContext, runtimeContext)

  const entries: McpToolEntry[] = []
  type TransportTarget = {
    deepWater: boolean
    transport: McpTransportConfig
    originalToolName: string
    instanceId: string
    /** Present only when the returned tool output is bound to one user. */
    userCredentialScopeId: string | null
  }
  const transportByExposedName = new Map<string, TransportTarget>()
  const managedToolNames = rows.some(isManagedDeepWaterRow)
    ? MANAGED_DEEP_WATER_TOOL_NAMES
    : new Set<string>()
  // Managed DeepWater rows claim the canonical names first, then a fixed key —
  // Prisma reads unordered, and a reshuffle would re-suffix a colliding tool.
  const allocationKey = (row: RegistryRow): string =>
    `${isManagedDeepWaterRow(row) ? 0 : 1}\u0000${row.toolId}\u0000${row.id}`
  const orderedRows = [...rows].sort((left, right) => (allocationKey(left) < allocationKey(right) ? -1 : 1))
  const allocateExposedName = createMcpToolNameAllocator(managedToolNames)

  for (const row of orderedRows) {
    if (!row.mcpInstanceId || !row.mcpInstance) continue
    const originalToolName = extractOriginalToolName(row)
    if (!originalToolName) continue
    const deepWater = isManagedDeepWaterCatalog(row.mcpInstance.catalogEntry)
    if (
      !isMcpRegistryRowExposed(
        toolPolicy,
        row.id,
        row.mcpInstance,
        runScope,
        row.metadata,
        row.grants,
        runtimeContext.agentId,
        fingerprintMcpToolDescriptor({
          annotations: mcpToolDescriptorAnnotationsFromMetadata(row.metadata),
          description: row.description,
          inputSchema: row.inputSchema,
          name: originalToolName,
          outputSchema: row.outputSchema,
        }),
      )
    ) {
      continue
    }

    const exposedName = allocateExposedName(originalToolName, deepWater)

    const credential = deepWater
      ? { credentialRef: row.mcpInstance.credentialRef, source: 'instance_default' as const }
      : await resolveCredentialRefWithSource(prisma, row.mcpInstanceId, {
        userId: runScope.effectiveUserId,
        agentId: runtimeContext.agentId,
        channelId: runtimeContext.channelId,
        teamId: runScope.teamId,
        projectId: runScope.projectId,
        organizationId,
      })
    const credentialRef = credential.credentialRef
    const secret = credentialRef ? await secretResolver.resolve(credentialRef) : null
    // A connection requiring credentials is not a callable capability for a
    // person without a usable one. This is particularly important for shared
    // OAuth installs: another member must not even see a tool backed by
    // somebody else's personal override, or a stale secret reference whose
    // plaintext can no longer be resolved.
    if (
      !deepWater
      && mcpAuthRequiresCredential(
        row.mcpInstance.catalogEntry.authMethod,
        row.mcpInstance.catalogEntry.authConfig,
      )
      && !secret
    ) {
      continue
    }
    const userCredentialScopeId = !deepWater
      && runScope.effectiveUserId
      && (
        credential.source === 'user_override'
        || row.mcpInstance.scopeType === 'user'
      )
      ? runScope.effectiveUserId
      : null

    let transport: McpTransportConfig
    try {
      // Merge + parse + apply auth once here so probe (API), the toolset, and
      // the external driver share the exact same header semantics.
      transport = buildAuthorizedTransport({
        catalogDefaultTransportConfig: row.mcpInstance.catalogEntry.defaultTransportConfig,
        instanceTransportConfig: row.mcpInstance.transportConfig,
        authConfig: row.mcpInstance.catalogEntry.authConfig,
        secret,
      })
    } catch {
      // Skip malformed transport configs rather than failing the whole sub-agent.
      continue
    }

    entries.push({
      registryEntryId: row.id,
      originalToolName,
      exposedName,
      description: row.description,
      inputSchema: stringRecord(row.inputSchema),
      instanceId: row.mcpInstanceId,
      connectorLabel: row.mcpInstance.catalogEntry.label,
    })
    transportByExposedName.set(exposedName, {
      deepWater,
      transport,
      originalToolName,
      instanceId: row.mcpInstanceId,
      userCredentialScopeId,
    })
  }

  const dispatch = async (
    exposedName: string,
    args: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<AgenticToolResult> => {
    const inputSummary = summarizeToolInput(args)
    const target = transportByExposedName.get(exposedName)
    if (!target) {
      return { inputSummary, output: `Unknown MCP tool: ${exposedName}`, success: false }
    }
    const startedAt = Date.now()
    let transportInvoked = false
    const recordUserCredentialDisclosure = () => {
      if (target.userCredentialScopeId) {
        options.consumedSources?.add({
          scopeId: target.userCredentialScopeId,
          scopeType: 'user',
        })
      }
    }
    try {
      const dispatchTarget = async (
        stableToolCallId = toolCallId ?? '',
        stableArgs = args,
      ) => {
        let transport = target.transport
        if (target.deepWater) {
          if (!stableToolCallId) {
            throw new Error('LEDGER_TOOL_CALL_ID_REQUIRED')
          }
          transport = await addDeepWaterIdentityHeaders(
            transport,
            options.ledgerIdentity,
            attribution,
            stableToolCallId,
          )
        }
        transportInvoked = true
        return (options.dispatchMcpTool ?? dispatchTool)({
          spec: { transport: 'mcp', connection: transport, toolName: target.originalToolName },
          args: stableArgs,
          secret: null,
        })
      }
      // A launcher handoff turn belongs to its guard; every other DeepWater
      // call to the run binder (N9.2). The two never see the same call.
      const guarded = target.deepWater && options.deepWaterHandoffGuard?.bound
        ? await options.deepWaterHandoffGuard.dispatchDeepWater(
            target.originalToolName,
            toolCallId,
            args,
            dispatchTarget,
          )
        : target.deepWater && options.deepWaterRunBinder
          ? {
              deliveryToken: null,
              result: (await options.deepWaterRunBinder.dispatch(
                target.originalToolName,
                toolCallId,
                args,
                dispatchTarget,
              )).result,
            }
          : {
              deliveryToken: null,
              result: await dispatchTarget(toolCallId, args),
            }
      const { deliveryToken, result } = guarded
      // A user-specific credential can make its tool result private even when
      // the agent and destination are shared. Record this immediately before
      // returning model-visible output; every view (main and delegate) shares
      // this dispatch closure.
      recordUserCredentialDisclosure()
      if (transportInvoked) {
        await recordMcpConnectorUsage(prisma, attribution, {
          connectorId: target.instanceId,
          latencyMs: Date.now() - startedAt,
          operation: target.originalToolName,
          success: result.success,
        })
      }
      return {
        ...(target.deepWater && deliveryToken && options.deepWaterHandoffGuard
          ? {
              acknowledgeDelivery: () =>
                options.deepWaterHandoffGuard?.markDelivered(deliveryToken),
            }
          : {}),
        inputSummary,
        output: result.output,
        success: result.success,
      }
    } catch (error) {
      if (transportInvoked) {
        recordUserCredentialDisclosure()
        await recordMcpConnectorUsage(prisma, attribution, {
          connectorId: target.instanceId,
          latencyMs: Date.now() - startedAt,
          operation: target.originalToolName,
          success: false,
        })
      }
      if (isFatalToolExecutionError(error)) throw error
      const message = error instanceof Error ? error.message : String(error)
      return { inputSummary, output: `MCP dispatch error: ${message}`, success: false }
    }
  }

  const mode: McpToolset['mode'] =
    entries.length > resolveInlineToolLimit(options.inlineToolLimit)
      ? 'deferred'
      : 'inline'

  return {
    entries,
    managedResearchToolNames: new Set(
      [...transportByExposedName.values()].filter((t) => t.deepWater).map((t) => t.originalToolName),
    ),
    mode,
    createView: () =>
      mode === 'deferred'
        ? buildDeferredView(entries, dispatch)
        : buildInlineView(entries, dispatch),
    dispatch,
    timeoutErrorFor: (exposedName) => {
      const target = transportByExposedName.get(exposedName)
      return target?.deepWater
        ? options.deepWaterHandoffGuard?.timeoutErrorFor(target.originalToolName) ?? null
        : null
    },
  }
}
