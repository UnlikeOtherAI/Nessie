import {
  DeepWaterResearchLauncherPresetSchema,
  type DeepWaterResearchLauncherPreset,
} from '@nessie/schemas'

const launcherStateKey = 'deepWaterResearchLauncher'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const deepWaterResearchLauncherNavigationState = (
  preset?: DeepWaterResearchLauncherPreset,
): Record<string, unknown> => ({
  [launcherStateKey]: { preset },
})

export const readDeepWaterResearchLauncherPreset = (
  state: unknown,
): DeepWaterResearchLauncherPreset | null => {
  if (!isRecord(state) || !isRecord(state[launcherStateKey])) {
    return null
  }
  const parsed = DeepWaterResearchLauncherPresetSchema.safeParse(
    state[launcherStateKey].preset ?? {},
  )
  return parsed.success ? parsed.data : null
}
