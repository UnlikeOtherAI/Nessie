import {
  buildAuthorizedTransport,
  resolveCredentialRef,
  EnvSecretResolver,
  type SecretResolver,
} from '@nessie/mcp-manage'
import { recordConnectorUsage, type LedgerAttribution } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, McpTransportConfig } from '@nessie/schemas'
import {
  buildDeferredView,
  buildInlineView,
  DEFAULT_INLINE_TOOL_LIMIT,
  type McpToolsetView,
} from './mcp-toolset-deferred.js'
import { dispatchTool } from './tool-dispatch.js'
import { summarizeToolInput } from './tool-util.js'
import type { AgenticToolResult } from './tools.js'

export type McpToolPolicy = Record<string, boolean> | null

const EXPOSE_NAME_PREFIX = 'mcp_'

const sanitizeName = (raw: string): string => {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60)
  return cleaned.length > 0 ? cleaned : 'tool'
}

const exposedNameFor = (toolName: string): string => `${EXPOSE_NAME_PREFIX}${sanitizeName(toolName)}`

type RegistryRow = {
  id: string
  toolId: string
  label: string
  description: string
  inputSchema: unknown
  transportConfig: unknown
  mcpInstanceId: string | null
  mcpInstance: {
    credentialRef: string | null
    scopeType: string
    scopeId: string
    transportConfig: unknown
    catalogEntry: {
      label: string
      authConfig: unknown
      defaultTransportConfig: unknown
    }
  } | null
}

const stringRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

type RunScopeContext = {
  agentKind: 'personal_assistant' | 'shared'
  effectiveUserId: string | null
  channelId: string
  teamId: string | null
  projectId: string | null
}

/**
 * Whether an instance's install scope reaches this run. Shared scopes follow
 * tenancy: org-/system-wide instances reach every run in the org, team /
 * project / channel instances reach runs inside that container. User-scoped
 * instances reach ONLY the installing user's delegated personal-assistant
 * runs — a user's personal connector must never surface in a shared agent's
 * channel where other people could drive it.
 */
const scopeMatchesRun = (
  scopeType: string,
  scopeId: string,
  ctx: RunScopeContext,
): boolean => {
  switch (scopeType) {
    case 'system':
    case 'organization':
      return true
    case 'project':
      return ctx.projectId === scopeId
    case 'team':
      return ctx.teamId === scopeId
    case 'channel':
      return ctx.channelId === scopeId
    case 'user':
      return ctx.agentKind === 'personal_assistant' && ctx.effectiveUserId === scopeId
    default:
      return false
  }
}

/**
 * Exposure rule for one registry entry: an explicit per-agent policy verdict
 * always wins (true exposes, false hides); otherwise the instance's install
 * scope decides. This is what makes an admin's org-scope install available to
 * the whole org, and a member's self-installed connector available to their
 * own personal assistant, without owner-managed per-agent policy edits.
 */
const isExposed = (
  toolPolicy: McpToolPolicy,
  registryEntryId: string,
  instance: { scopeType: string; scopeId: string },
  ctx: RunScopeContext,
): boolean => {
  const verdict = toolPolicy?.[registryEntryId]
  if (verdict === true) return true
  if (verdict === false) return false
  return scopeMatchesRun(instance.scopeType, instance.scopeId, ctx)
}

const buildRunScopeContext = (
  actorContext: AuthorizedActionContext,
  runtimeContext: { agentId: string; agentKind: 'personal_assistant' | 'shared'; channelId: string },
): RunScopeContext => ({
  agentKind: runtimeContext.agentKind,
  effectiveUserId:
    actorContext.actionContext.effectiveUserId
    ?? (actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : null),
  channelId: runtimeContext.channelId,
  teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId ?? null,
  projectId: actorContext.tenant.projectId ?? null,
})

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
  dispatch: (exposedName: string, args: Record<string, unknown>) => Promise<AgenticToolResult>
}

const resolveInlineToolLimit = (override?: number): number => {
  if (typeof override === 'number' && override >= 0) return override
  const fromEnv = Number(process.env.NESSIE_MCP_INLINE_TOOL_LIMIT)
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_INLINE_TOOL_LIMIT
}

const defaultSecretResolver = new EnvSecretResolver()

export const buildMcpToolset = async (
  prisma: PrismaClient,
  organizationId: string,
  toolPolicy: McpToolPolicy,
  actorContext: AuthorizedActionContext,
  runtimeContext: {
    agentId: string
    agentKind: 'personal_assistant' | 'shared'
    channelId: string
  },
  // Attribution for connector usage billing — every dispatched MCP tool call
  // writes a connector_usage_events row keyed to the run's org/agent/channel/run.
  attribution: LedgerAttribution,
  options: { secretResolver?: SecretResolver; inlineToolLimit?: number } = {},
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
      transportConfig: true,
      mcpInstanceId: true,
      mcpInstance: {
        select: {
          credentialRef: true,
          scopeType: true,
          scopeId: true,
          transportConfig: true,
          catalogEntry: {
            select: { label: true, authConfig: true, defaultTransportConfig: true },
          },
        },
      },
    },
  })) as unknown as RegistryRow[]

  const runScope = buildRunScopeContext(actorContext, runtimeContext)

  const entries: McpToolEntry[] = []
  type TransportTarget = {
    transport: McpTransportConfig
    originalToolName: string
    instanceId: string
  }
  const transportByExposedName = new Map<string, TransportTarget>()
  const usedNames = new Set<string>()

  for (const row of rows) {
    if (!row.mcpInstanceId || !row.mcpInstance) continue
    if (!isExposed(toolPolicy, row.id, row.mcpInstance, runScope)) continue

    const originalToolName = extractOriginalToolName(row)
    if (!originalToolName) continue

    let exposedName = exposedNameFor(originalToolName)
    let suffix = 2
    while (usedNames.has(exposedName)) {
      exposedName = `${exposedNameFor(originalToolName)}_${suffix}`
      suffix += 1
    }
    usedNames.add(exposedName)

    const credentialRef = await resolveCredentialRef(prisma, row.mcpInstanceId, {
      userId: runScope.effectiveUserId,
      agentId: runtimeContext.agentId,
      channelId: runtimeContext.channelId,
      teamId: runScope.teamId,
      projectId: runScope.projectId,
      organizationId,
    })
    const secret = credentialRef ? await secretResolver.resolve(credentialRef) : null

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
      transport,
      originalToolName,
      instanceId: row.mcpInstanceId,
    })
  }

  // Record one connector_usage_events row per MCP tool call. Best-effort: a
  // ledger failure must never break the tool dispatch.
  const recordMcpUsage = async (
    target: TransportTarget,
    success: boolean,
    latencyMs: number,
  ): Promise<void> => {
    await recordConnectorUsage(prisma, {
      attribution,
      event: {
        connectorType: 'mcp',
        connectorId: target.instanceId,
        target: target.originalToolName,
        operation: target.originalToolName,
        success,
        latencyMs,
      },
    }).catch(() => {
      // best-effort billing capture
    })
  }

  const dispatch = async (
    exposedName: string,
    args: Record<string, unknown>,
  ): Promise<AgenticToolResult> => {
    const inputSummary = summarizeToolInput(args)
    const target = transportByExposedName.get(exposedName)
    if (!target) {
      return { inputSummary, output: `Unknown MCP tool: ${exposedName}`, success: false }
    }
    const startedAt = Date.now()
    try {
      const result = await dispatchTool({
        spec: { transport: 'mcp', connection: target.transport, toolName: target.originalToolName },
        args,
        secret: null,
      })
      await recordMcpUsage(target, result.success, Date.now() - startedAt)
      return {
        inputSummary,
        output: result.output,
        success: result.success,
      }
    } catch (error) {
      await recordMcpUsage(target, false, Date.now() - startedAt)
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
    mode,
    createView: () =>
      mode === 'deferred'
        ? buildDeferredView(entries, dispatch)
        : buildInlineView(entries, dispatch),
    dispatch,
  }
}
