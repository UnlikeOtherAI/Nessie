const SERVER_OWNED_TRIGGER_CONFIG_KEYS = new Set([
  'createdByUserId',
  'createdViaTool',
  'launchOrigin',
])

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

/**
 * Launch identity is written only by authenticated server-side creation paths
 * such as schedule_task. Generic trigger APIs may edit schedule behavior but
 * cannot mint or replace user/team billing provenance.
 */
export const stripServerOwnedTriggerConfig = (
  config: Record<string, unknown> | undefined,
): Record<string, unknown> => Object.fromEntries(
  Object.entries(config ?? {}).filter(
    ([key]) => !SERVER_OWNED_TRIGGER_CONFIG_KEYS.has(key),
  ),
)

export const mergeTriggerConfigPreservingIdentity = (
  existing: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> => ({
  ...asRecord(existing),
  ...stripServerOwnedTriggerConfig(patch),
})
