import { recordConnectorUsage, type LedgerAttribution, type ToolSchemaDescriptor } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'
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
  mcpInstance: { transportConfig: unknown } | null
}

const isAllowedByPolicy = (toolPolicy: McpToolPolicy, registryEntryId: string): boolean => {
  if (!toolPolicy) return false
  return toolPolicy[registryEntryId] === true
}

const stringRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

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
      mcpInstance: { select: { transportConfig: true } },
    },
  })) as unknown as RegistryRow[]

  const entries: McpToolEntry[] = []
  type TransportTarget = {
    transport: ReturnType<typeof parseMcpTransportConfig>
    originalToolName: string
    instanceId: string
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
      transport = parseMcpTransportConfig(row.mcpInstance.transportConfig)
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
    })
    transportByExposedName.set(exposedName, {
      transport,
      originalToolName,
      instanceId: row.mcpInstanceId,
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
