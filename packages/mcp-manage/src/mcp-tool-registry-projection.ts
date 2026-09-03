import { Prisma } from '@prisma/client'
import type { McpToolDescriptor } from '@nessie/mcp-client'
import type { McpServerScopeType } from '@nessie/schemas'
import { acquireAgentToolPolicyLock } from '@nessie/team-admin'

import {
  fingerprintMcpToolDescriptor,
  MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY,
} from './mcp-tool-grant-fingerprint.js'
import { toPrismaToolRegistrySource } from './tool-enum-mapping.js'

type ToolRegistryTx = Pick<
  Prisma.TransactionClient,
  '$executeRaw' | 'agent' | 'toolGrant' | 'toolRegistryEntry'
>

type ProjectionInstance = {
  id: string
  scopeType: McpServerScopeType
  scopeId: string
  /**
   * This connection's tools are default-OFF until an agent is explicitly
   * granted them (`worker` `isExposed`). Carried from the durable instance
   * column rather than decided here, because the OAuth callback and the
   * generic instance refresh both re-project through this function — a marker
   * applied only at the App Store's own call sites would be dropped by the
   * next probe and silently widen the app.
   */
  requiresExplicitToolGrant?: boolean
}

/**
 * Registry metadata is also used for Nessie-owned projection facts such as
 * `requiresExplicitGrant`. Keep the upstream descriptor annotations under a
 * namespaced key so a consent fingerprint cannot accidentally include either
 * those facts or future registry metadata.
 */
export const MCP_TOOL_DESCRIPTOR_ANNOTATIONS_METADATA_KEY =
  'mcpToolDescriptorAnnotations'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

/**
 * Build a stable scope-key string for projecting discovered MCP tools into
 * `ToolRegistryEntry`. The base CRUD-side registry uses a string `scopeKey`
 * (see `services/tools.ts`); we mirror that here so MCP-emitted rows compose
 * with builtin/custom rows under the same unique constraint.
 */
const toRegistryScopeKey = (
  organizationId: string,
  scopeType: McpServerScopeType,
  scopeId: string,
): string => `mcp:${organizationId}:${scopeType}:${scopeId}`

const toRegistryToolId = (instanceId: string, toolName: string): string =>
  `mcp:${instanceId}:${toolName}`

/**
 * Stable deep-equality for the JSON-ish payloads we persist on
 * `ToolRegistryEntry` (inputSchema, outputSchema). Object keys are sorted so
 * field-order differences from the upstream MCP server don't trigger a false
 * "schema drifted" reset. `undefined`, `null`, and missing keys all collapse
 * to the same canonical form (the stored `outputSchema` is nullable but a
 * descriptor may simply omit it).
 */
const canonicalJson = (value: unknown): unknown => {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalJson(v)] as const)
    return Object.fromEntries(entries)
  }
  return value
}

/**
 * Read the annotations that came from the upstream MCP descriptor, not the
 * registry metadata surrounding them. Historic projections had no separate
 * annotation field, which canonicalizes to the empty descriptor annotations.
 */
export const mcpToolDescriptorAnnotationsFromMetadata = (
  metadata: unknown,
): Record<string, unknown> => {
  const annotations = record(metadata)[MCP_TOOL_DESCRIPTOR_ANNOTATIONS_METADATA_KEY]
  return canonicalJson(record(annotations)) as Record<string, unknown>
}

const metadataForMcpToolDescriptor = (
  annotations: unknown,
  requiresExplicitGrant: boolean,
): Record<string, unknown> => ({
  ...(requiresExplicitGrant ? { requiresExplicitGrant: true } : {}),
  [MCP_TOOL_DESCRIPTOR_ANNOTATIONS_METADATA_KEY]: canonicalJson(record(annotations)),
})

/**
 * A descriptor that was only just introduced gets the PA's default allow.
 * Re-projection is intentionally excluded: an existing grant is a person's
 * decision and must not be refreshed after descriptor drift or a revocation.
 */
const grantNewProtectedDescriptorToPersonalAssistant = async (
  tx: ToolRegistryTx,
  input: {
    descriptor: McpToolDescriptor
    organizationId: string
    toolRegistryEntryId: string
  },
): Promise<void> => {
  const personalAssistant = await tx.agent.findFirst({
    where: {
      agentKind: 'personal_assistant',
      organizationId: input.organizationId,
      systemManaged: true,
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (!personalAssistant) return

  await acquireAgentToolPolicyLock(tx as Prisma.TransactionClient, personalAssistant.id)
  const directGrant = await tx.toolGrant.findFirst({
    where: {
      agentId: personalAssistant.id,
      roleId: null,
      toolId: input.toolRegistryEntryId,
    },
    select: { id: true },
  })
  if (directGrant) return

  await tx.toolGrant.create({
    data: {
      agentId: personalAssistant.id,
      config: {
        [MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]: fingerprintMcpToolDescriptor({
          annotations: input.descriptor.annotations ?? {},
          description: input.descriptor.description ?? '',
          inputSchema: input.descriptor.inputSchema ?? {},
          name: input.descriptor.name,
          outputSchema: input.descriptor.outputSchema,
        }),
      } as Prisma.InputJsonValue,
      roleId: null,
      source: 'agent_override' as never,
      state: 'allowed',
      toolId: input.toolRegistryEntryId,
    },
  })
}

const jsonEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b))

/**
 * Decide whether a freshly-probed descriptor materially differs from the
 * existing `ToolRegistryEntry` row. We compare the five user-visible /
 * governance-relevant fields the upsert writes: label, description,
 * inputSchema, outputSchema, and upstream annotations. Other internal fields
 * (transport, source, mcpInstanceId, and Nessie-owned metadata) are derived
 * from the instance and never need a re-review.
 */
export const descriptorDiffersFromEntry = (
  descriptor: McpToolDescriptor,
  entry: {
    label: string
    description: string
    inputSchema: unknown
    metadata?: unknown
    outputSchema: unknown
  },
): boolean => {
  const nextLabel = descriptor.title ?? descriptor.name
  if (nextLabel !== entry.label) return true
  if ((descriptor.description ?? '') !== entry.description) return true
  if (!jsonEqual(descriptor.inputSchema ?? {}, entry.inputSchema)) return true
  if (!jsonEqual(descriptor.outputSchema ?? null, entry.outputSchema)) return true
  if (!jsonEqual(
    canonicalJson(record(descriptor.annotations)),
    mcpToolDescriptorAnnotationsFromMetadata(entry.metadata),
  )) return true
  return false
}

export const projectMcpToolDescriptors = async (
  tx: ToolRegistryTx,
  input: {
    organizationId: string
    instance: ProjectionInstance
    descriptors: McpToolDescriptor[]
  },
): Promise<void> => {
  const { organizationId, instance, descriptors } = input
  const scopeKey = toRegistryScopeKey(
    organizationId,
    instance.scopeType,
    instance.scopeId,
  )
  // User-scoped connectors are self-service: the installer is the only person
  // whose runs can ever see these tools (the worker toolset gates user-scope
  // instances to the installing user's delegated personal-assistant runs), so
  // requiring an org-owner review of each discovered tool would only break the
  // "paste a link, start using it" flow. Shared scopes (org/team/channel/…)
  // keep the pending_review governance gate.
  const projectedStatus =
    instance.scopeType === 'user' ? ('active' as const) : ('pending_review' as const)
  const existingEntries = await tx.toolRegistryEntry.findMany({
    where: { mcpInstanceId: instance.id },
    select: {
      id: true,
      toolId: true,
      label: true,
      description: true,
      inputSchema: true,
      metadata: true,
      outputSchema: true,
    },
  })
  const existingByToolId = new Map(existingEntries.map((e) => [e.toolId, e]))

  const prismaSource = toPrismaToolRegistrySource('mcp-remote') as never
  const seenToolIds = new Set<string>()
  for (const descriptor of descriptors) {
    const toolId = toRegistryToolId(instance.id, descriptor.name)
    seenToolIds.add(toolId)
    const existing = existingByToolId.get(toolId)
    const requiresExplicitGrant = instance.requiresExplicitToolGrant === true
      || (existing ? record(existing.metadata).requiresExplicitGrant === true : false)
    const drifted = existing
      ? descriptorDiffersFromEntry(descriptor, existing)
      : false
    const projectedEntry = await tx.toolRegistryEntry.upsert({
      where: {
        organizationId_scopeKey_toolId: { organizationId, scopeKey, toolId },
      },
      create: {
        organizationId,
        scopeKey,
        toolId,
        label: descriptor.title ?? descriptor.name,
        description: descriptor.description ?? '',
        // Spec section 3.1 requires a non-empty `overview`. Prefer the
        // upstream description; fall back to the human label, then the tool
        // name, and finally a synthesised string keyed off the instance id so
        // we never write empty.
        overview:
          descriptor.description
          ?? descriptor.title
          ?? descriptor.name
          ?? `MCP tool from instance ${instance.id}`,
        safe: false,
        builtin: false,
        enabled: true,
        handlerKind: 'mcp',
        metadata: metadataForMcpToolDescriptor(
          descriptor.annotations,
          requiresExplicitGrant,
        ) as object,
        source: prismaSource,
        transport: 'mcp',
        transportConfig: {
          transport: 'mcp',
          serverId: instance.id,
          toolName: descriptor.name,
        } as object,
        mcpInstanceId: instance.id,
        inputSchema: (descriptor.inputSchema ?? {}) as object,
        outputSchema: descriptor.outputSchema
          ? (descriptor.outputSchema as object)
          : undefined,
        tags: [],
        status: projectedStatus,
        version: '0.0.0',
        createdBy: 'mcp',
      },
      update: {
        label: descriptor.title ?? descriptor.name,
        description: descriptor.description ?? '',
        // Written on every refresh so the persisted descriptor, including its
        // upstream annotations, is the thing a person grants. Preserve the
        // explicit-grant marker from an existing protected projection too.
        metadata: metadataForMcpToolDescriptor(
          descriptor.annotations,
          requiresExplicitGrant,
        ) as object,
        source: prismaSource,
        transport: 'mcp',
        transportConfig: {
          transport: 'mcp',
          serverId: instance.id,
          toolName: descriptor.name,
        } as object,
        mcpInstanceId: instance.id,
        inputSchema: (descriptor.inputSchema ?? {}) as object,
        outputSchema: descriptor.outputSchema
          ? (descriptor.outputSchema as object)
          : Prisma.JsonNull,
        // Only flip status when the new descriptor diverges from what was
        // approved. An identical re-probe leaves an `active` entry active.
        // User-scope drift re-activates: the installer is the reviewer.
        ...(drifted ? { status: projectedStatus } : {}),
      },
    })
    if (!existing && requiresExplicitGrant) {
      await grantNewProtectedDescriptorToPersonalAssistant(tx, {
        descriptor,
        organizationId,
        toolRegistryEntryId: projectedEntry.id,
      })
    }
  }

  // Sweep entries whose upstream tool disappeared. Keep them enabled so
  // dispatch errors stay loud (hard-failing call vs silently passing the wrong
  // arg) -- but flip them to pending_review so the owner sees the drift in the
  // admin UI and can decide whether to delete or archive.
  const removedIds = existingEntries
    .filter((e) => !seenToolIds.has(e.toolId))
    .map((e) => e.id)
  if (removedIds.length > 0) {
    await tx.toolRegistryEntry.updateMany({
      where: { id: { in: removedIds } },
      data: { status: 'pending_review' },
    })
  }
}
