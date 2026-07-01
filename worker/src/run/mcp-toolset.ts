import { recordConnectorUsage, type LedgerAttribution, type ToolSchemaDescriptor } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, McpCredentialPrincipalType } from '@nessie/schemas'
import { dispatchTool, parseMcpTransportConfig } from './tool-dispatch.js'
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
    transportConfig: unknown
    catalogEntry: {
      defaultTransportConfig: unknown
    }
  } | null
}

const isAllowedByPolicy = (toolPolicy: McpToolPolicy, registryEntryId: string): boolean => {
  if (!toolPolicy) return false
  return toolPolicy[registryEntryId] === true
}

const stringRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

type CredentialResolutionContext = {
  userId?: string | null
  agentId?: string | null
  channelId?: string | null
  teamId?: string | null
  projectId?: string | null
  organizationId?: string | null
}

const CREDENTIAL_RESOLUTION_ORDER: Array<{
  principalType: McpCredentialPrincipalType
  field: keyof CredentialResolutionContext
}> = [
  { principalType: 'user', field: 'userId' },
  { principalType: 'agent', field: 'agentId' },
  { principalType: 'channel', field: 'channelId' },
  { principalType: 'team', field: 'teamId' },
  { principalType: 'project', field: 'projectId' },
  { principalType: 'organization', field: 'organizationId' },
]

const buildCredentialContext = (
  actorContext: AuthorizedActionContext,
  agentId: string,
  channelId: string,
): CredentialResolutionContext => ({
  userId:
    actorContext.actor.actorType === 'user'
      ? actorContext.actor.actorId
      : actorContext.actionContext.effectiveUserId,
  agentId,
  channelId,
  teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId,
  projectId: actorContext.tenant.projectId,
  organizationId: actorContext.tenant.organizationId,
})

const resolveCredentialRef = async (
  prisma: PrismaClient,
  instanceId: string,
  context: CredentialResolutionContext,
  defaultRef: string | null,
): Promise<string | null> => {
  for (const { principalType, field } of CREDENTIAL_RESOLUTION_ORDER) {
    const principalId = context[field]
    if (!principalId) continue
    const override = await prisma.mcpServerCredentialOverride.findUnique({
      where: {
        instanceId_principalType_principalId: {
          instanceId,
          principalType,
          principalId,
        },
      },
      select: { credentialRef: true },
    })
    if (override?.credentialRef) return override.credentialRef
  }
  return defaultRef
}

const resolveSecret = (credentialRef: string | null): string | null => {
  if (!credentialRef) return null
  const value = process.env[credentialRef]
  return typeof value === 'string' && value.length > 0 ? value : null
}

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
}

export type McpToolset = {
  entries: McpToolEntry[]
  descriptors: ToolSchemaDescriptor[]
  dispatch: (exposedName: string, args: Record<string, unknown>) => Promise<AgenticToolResult>
}

export const buildMcpToolset = async (
  prisma: PrismaClient,
  organizationId: string,
  toolPolicy: McpToolPolicy,
  actorContext: AuthorizedActionContext,
  runtimeContext: { agentId: string; channelId: string },
  // Attribution for connector usage billing — every dispatched MCP tool call
  // writes a connector_usage_events row keyed to the run's org/agent/channel/run.
  attribution: LedgerAttribution,
): Promise<McpToolset> => {
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
          transportConfig: true,
          catalogEntry: { select: { defaultTransportConfig: true } },
        },
      },
    },
  })) as unknown as RegistryRow[]

  const entries: McpToolEntry[] = []
  type TransportTarget = {
    transport: ReturnType<typeof parseMcpTransportConfig>
    originalToolName: string
    instanceId: string
    secret: string | null
  }
  const transportByExposedName = new Map<string, TransportTarget>()
  const usedNames = new Set<string>()

  for (const row of rows) {
    if (!row.mcpInstanceId || !row.mcpInstance) continue
    if (!isAllowedByPolicy(toolPolicy, row.id)) continue

    const originalToolName = extractOriginalToolName(row)
    if (!originalToolName) continue

    let exposedName = exposedNameFor(originalToolName)
    let suffix = 2
    while (usedNames.has(exposedName)) {
      exposedName = `${exposedNameFor(originalToolName)}_${suffix}`
      suffix += 1
    }
    usedNames.add(exposedName)

    let transport: ReturnType<typeof parseMcpTransportConfig>
    try {
      transport = parseMcpTransportConfig({
        ...stringRecord(row.mcpInstance.catalogEntry.defaultTransportConfig),
        ...stringRecord(row.mcpInstance.transportConfig),
      })
    } catch {
      // Skip malformed transport configs rather than failing the whole sub-agent.
      continue
    }
    const credentialRef = await resolveCredentialRef(
      prisma,
      row.mcpInstanceId,
      buildCredentialContext(
        actorContext,
        runtimeContext.agentId,
        runtimeContext.channelId,
      ),
      row.mcpInstance.credentialRef,
    )

    entries.push({
      registryEntryId: row.id,
      originalToolName,
      exposedName,
      description: row.description,
      inputSchema: stringRecord(row.inputSchema),
      instanceId: row.mcpInstanceId,
    })
    transportByExposedName.set(exposedName, {
      transport,
      originalToolName,
      instanceId: row.mcpInstanceId,
      secret: resolveSecret(credentialRef),
    })
  }

  const descriptors: ToolSchemaDescriptor[] = entries.map((entry) => ({
    toolName: entry.exposedName,
    description: entry.description || `MCP tool ${entry.originalToolName}`,
    inputSchema: entry.inputSchema,
  }))

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
        secret: target.secret,
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

  return { entries, descriptors, dispatch }
}
