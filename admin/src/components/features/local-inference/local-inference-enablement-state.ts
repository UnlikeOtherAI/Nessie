import type { ResolvedSetting, SettingScope } from '../../../facades/settings/hooks'

const SCOPE_LABEL: Record<SettingScope, string> = {
  organization: 'organisation',
  team: 'team',
  user: 'personal',
}

/**
 * The policy is deliberately false unless a scoped row says true.  This is
 * the same fail-closed interpretation the API and worker use; the UI must not
 * turn an absent setting into a reassuring green switch.
 */
export const localInferenceEnablementState = (setting: ResolvedSetting | undefined) => {
  const enabled = setting?.value === true
  const setAtScope = setting?.setAtScope ?? null
  return {
    canEdit: setting?.canEdit === true,
    enabled,
    lockedHere: setting?.lockedHere === true,
    summary: setAtScope
      ? `${enabled ? 'Enabled' : 'Disabled'} at the ${SCOPE_LABEL[setAtScope]} level.`
      : 'Disabled until an organisation administrator enables it.',
  }
}
