import { z } from 'zod'

/**
 * The one scoped-setting key that permits the owner-host-only local inference
 * lane. This contract is browser-safe because both the control and the server
 * must address exactly the same stored policy decision.
 */
export const LOCAL_INFERENCE_ENABLED_SETTING_KEY = 'inference.localAgents.enabled'

/** The setting never coerces a string or a number into an authorization. */
export const LocalInferenceEnabledSettingValueSchema = z.boolean()
