import type { Prisma, PrismaClient } from '@prisma/client'

import { DEEP_WATER_RUN_UPDATE_TOOL_ID } from './builtin-integration-tools.js'
import { SYSTEM_TOOL_DEFINITIONS } from './builtin-tools.js'

export const DEEP_WATER_BUNDLE_MARKER_PREFIX =
  '__nessie_deep_water_bundle__:'
export const DEEP_WATER_MANUAL_UPDATER_MARKER =
  '__nessie_deep_water_manual_updater__'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EXPLICIT_BUILTIN_IDS = new Set(
  SYSTEM_TOOL_DEFINITIONS
    .filter((tool) => tool.requiresExplicitGrant)
    .map((tool) => tool.id),
)

const jsonRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const normalizePolicy = (value: unknown): Record<string, boolean> =>
  Object.fromEntries(
    Object.entries(jsonRecord(value)).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
    ),
  )

export const isExplicitToolPolicyProvenanceKey = (key: string): boolean =>
  key === DEEP_WATER_MANUAL_UPDATER_MARKER
  || key.startsWith(DEEP_WATER_BUNDLE_MARKER_PREFIX)

export const deepWaterBundleMarkerKey = (teamId: string): string =>
  `${DEEP_WATER_BUNDLE_MARKER_PREFIX}${teamId}`

export const hasDeepWaterBundleMarker = (
  policy: Record<string, boolean>,
  except?: string,
): boolean =>
  Object.entries(policy).some(
    ([key, enabled]) =>
      enabled
      && key !== except
      && key.startsWith(DEEP_WATER_BUNDLE_MARKER_PREFIX),
  )

export const findProtectedExplicitToolPolicyKeys = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  value: unknown,
): Promise<Set<string>> => {
  const policy = normalizePolicy(value)
  const keys = Object.keys(policy)
  const protectedKeys = new Set(
    keys.filter(
      (key) =>
        EXPLICIT_BUILTIN_IDS.has(key)
        || isExplicitToolPolicyProvenanceKey(key),
    ),
  )
  const registryIds = keys.filter((key) => UUID_PATTERN.test(key))
  if (registryIds.length === 0) return protectedKeys

  const entries = await prisma.toolRegistryEntry.findMany({
    where: { id: { in: registryIds } },
    select: { id: true, metadata: true, toolId: true },
  })
  for (const entry of entries) {
    if (
      EXPLICIT_BUILTIN_IDS.has(entry.toolId)
      || jsonRecord(entry.metadata).requiresExplicitGrant === true
    ) {
      protectedKeys.add(entry.id)
    }
  }
  return protectedKeys
}

export const stripProtectedExplicitToolPolicy = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  value: unknown,
): Promise<Record<string, boolean>> => {
  const policy = normalizePolicy(value)
  const protectedKeys = await findProtectedExplicitToolPolicyKeys(prisma, policy)
  for (const key of protectedKeys) delete policy[key]
  return policy
}

export const redactExplicitToolPolicyProvenance = (
  value: unknown,
): Record<string, boolean> => {
  const policy = normalizePolicy(value)
  for (const key of Object.keys(policy)) {
    if (isExplicitToolPolicyProvenanceKey(key)) delete policy[key]
  }
  return policy
}

export { DEEP_WATER_RUN_UPDATE_TOOL_ID }
