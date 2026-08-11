import type { PrismaClient } from '@prisma/client'

import {
  MCP_INSTANCE_ERROR_CODES,
  McpInstanceError,
} from './mcp-instance-errors.js'
import { isManagedIntegrationInstance } from './managed-products.js'

/**
 * Owner review of discovered MCP tools (`ToolRegistryEntry.status`).
 *
 * A connector installed at a shared scope (organization/project/team/channel)
 * projects its tools at `pending_review` (`mcp-tool-registry-projection.ts`),
 * and the worker only ever exposes `active` ones
 * (`worker/src/run/mcp-toolset.ts`). This is the surface that closes that
 * loop: without it the governance gate has no key and every shared-scope
 * connector is permanently inert.
 *
 * The same gate doubles as the post-approval supply-chain boundary — a
 * re-probe flips a tool whose schema drifted back to `pending_review` — so
 * review is a recurring act, not one-time install ceremony.
 *
 * Review is bulk by construction (one connector routinely projects dozens of
 * tools) but always over explicit ids, never "everything matching a filter",
 * so an approval cannot silently cover a destructive tool the reviewer never
 * saw listed.
 */

export const TOOL_REVIEW_ERROR_CODES = {
  NOT_REVIEWABLE: 'MCP_TOOL_REVIEW_NOT_REVIEWABLE',
} as const

export class McpToolReviewError extends Error {
  override readonly name = 'McpToolReviewError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

export type SetToolRegistryEntriesStatusInput = {
  organizationId: string
  status: 'active' | 'disabled'
  toolRegistryEntryIds: string[]
}

/**
 * Move a set of MCP-backed registry entries to `active` or `disabled`.
 *
 * Every id must resolve to an MCP tool in the caller's organization. Ids that
 * do not are rejected as a set rather than skipped: a partial success would
 * leave the reviewer believing they approved rows that never changed.
 */
export const setToolRegistryEntriesStatus = async (
  prisma: PrismaClient,
  input: SetToolRegistryEntriesStatusInput,
): Promise<{ status: 'active' | 'disabled'; updatedIds: string[] }> => {
  const requestedIds = Array.from(new Set(input.toolRegistryEntryIds))

  const entries = await prisma.toolRegistryEntry.findMany({
    select: { id: true, mcpInstanceId: true },
    where: {
      handlerKind: 'mcp',
      id: { in: requestedIds },
      organizationId: input.organizationId,
    },
  })

  if (entries.length !== requestedIds.length) {
    throw new McpToolReviewError(
      TOOL_REVIEW_ERROR_CODES.NOT_REVIEWABLE,
      'Every id must reference an MCP tool in this organization',
    )
  }

  // First-party products (DeepWater, DeepSignal) own their projections through
  // Integrations and the explicit-grant bundle, which reads the registry row's
  // enabled+active state as its readiness signal. Letting the generic review
  // route flip those rows would let an owner silently break a bundle the
  // integration still counts as complete — the same reason generic instance
  // test/refresh/delete already refuse them.
  const instanceIds = Array.from(
    new Set(
      entries
        .map((entry) => entry.mcpInstanceId)
        .filter((id): id is string => id !== null),
    ),
  )
  const managed = await Promise.all(
    instanceIds.map((instanceId) =>
      isManagedIntegrationInstance(prisma, input.organizationId, instanceId),
    ),
  )
  if (managed.some(Boolean)) {
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.MANAGED_BY_INTEGRATION,
      'These tools belong to a first-party integration and are managed from Integrations.',
    )
  }

  await prisma.toolRegistryEntry.updateMany({
    data: { status: input.status },
    where: {
      handlerKind: 'mcp',
      id: { in: requestedIds },
      organizationId: input.organizationId,
    },
  })

  return { status: input.status, updatedIds: requestedIds }
}
