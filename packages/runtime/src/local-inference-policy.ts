/** The only scoped-setting key which permits the owner-host-only local lane. */
export const LOCAL_INFERENCE_ENABLED_SETTING_KEY = 'inference.localAgents.enabled'

/**
 * Protected settings are authored by a live organisation administrator even
 * when the storage scope is `user`.  Keeping this registry small and explicit
 * prevents an arbitrary dotted key from acquiring an administrative bypass.
 */
export const ADMIN_AUTHORED_SCOPED_SETTING_KEYS = new Set([
  LOCAL_INFERENCE_ENABLED_SETTING_KEY,
])

export const isAdminAuthoredScopedSettingKey = (key: string): boolean =>
  ADMIN_AUTHORED_SCOPED_SETTING_KEYS.has(key)

export const isLocalInferenceEnabledValue = (value: unknown): value is boolean =>
  typeof value === 'boolean'
