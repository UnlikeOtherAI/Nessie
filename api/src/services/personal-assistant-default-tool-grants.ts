import { Prisma, type PrismaClient } from '@prisma/client'
import {
  fingerprintMcpToolDescriptor,
  MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY,
  mcpToolDescriptorAnnotationsFromMetadata,
} from '@nessie/mcp-manage'

import { acquireAgentToolPolicyLock } from './agent-tool-policy.js'

type PersonalAssistantDefaultGrantTarget = {
  agentId: string
  organizationId: string | null
}

const protectedMcpEntrySelect = {
  description: true,
  id: true,
  inputSchema: true,
  metadata: true,
  outputSchema: true,
  toolId: true,
  transportConfig: true,
} satisfies Prisma.ToolRegistryEntrySelect

type ProtectedMcpEntry = Prisma.ToolRegistryEntryGetPayload<{
  select: typeof protectedMcpEntrySelect
}>

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const descriptorName = (entry: ProtectedMcpEntry): string | null => {
  const configuredName = record(entry.transportConfig).toolName
  if (typeof configuredName === 'string' && configuredName.length > 0) {
    return configuredName
  }
  const separator = entry.toolId.lastIndexOf(':')
  return separator >= 0 && separator < entry.toolId.length - 1
    ? entry.toolId.slice(separator + 1)
    : null
}

const fingerprintConfig = (entry: ProtectedMcpEntry): Prisma.InputJsonValue => {
  const name = descriptorName(entry)
  if (!name) {
    throw new Error(`Protected MCP registry entry ${entry.id} has no descriptor name`)
  }
  return {
    [MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]: fingerprintMcpToolDescriptor({
      annotations: mcpToolDescriptorAnnotationsFromMetadata(entry.metadata),
      description: entry.description,
      inputSchema: entry.inputSchema,
      name,
      outputSchema: entry.outputSchema,
    }),
  }
}

/**
 * Give a Personal Assistant its default protected MCP grants. Existing direct
 * grants are deliberate owner policy, including denied tombstones, and are
 * never altered or refreshed here.
 */
export const reconcilePersonalAssistantDefaultToolGrants = async (
  tx: Prisma.TransactionClient,
  input: PersonalAssistantDefaultGrantTarget,
): Promise<number> => {
  await acquireAgentToolPolicyLock(tx, input.agentId)

  const organizationScope = input.organizationId === null
    ? [{ organizationId: null }]
    : [{ organizationId: null }, { organizationId: input.organizationId }]
  const [entries, directGrants] = await Promise.all([
    tx.toolRegistryEntry.findMany({
      where: {
        handlerKind: 'mcp',
        metadata: { path: ['requiresExplicitGrant'], equals: true },
        OR: organizationScope,
      },
      select: protectedMcpEntrySelect,
    }),
    tx.toolGrant.findMany({
      where: { agentId: input.agentId, roleId: null },
      select: { config: true, state: true, toolId: true },
    }),
  ])
  const grantedToolIds = new Set(directGrants.map((grant) => grant.toolId))
  let created = 0

  for (const entry of entries) {
    if (grantedToolIds.has(entry.id)) continue
    await tx.toolGrant.create({
      data: {
        agentId: input.agentId,
        config: fingerprintConfig(entry),
        roleId: null,
        source: 'agent_override' as never,
        state: 'allowed',
        toolId: entry.id,
      },
    })
    created += 1
  }

  return created
}

/** Run PA default provisioning once per assistant, each under its own lock. */
export const reconcilePersonalAssistantDefaultToolGrantsAtStartup = async (
  prisma: PrismaClient,
): Promise<{ agentCount: number; grantCount: number }> => {
  const assistants = await prisma.agent.findMany({
    where: { agentKind: 'personal_assistant', systemManaged: true },
    select: { id: true, organizationId: true },
  })
  let agentCount = 0
  let grantCount = 0

  for (const assistant of assistants) {
    const created = await prisma.$transaction((tx) =>
      reconcilePersonalAssistantDefaultToolGrants(tx, {
        agentId: assistant.id,
        organizationId: assistant.organizationId,
      }))
    if (created > 0) {
      agentCount += 1
      grantCount += created
    }
  }

  return { agentCount, grantCount }
}
