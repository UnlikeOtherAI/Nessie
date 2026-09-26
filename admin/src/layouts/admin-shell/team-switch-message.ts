import enGB from '../../i18n/locales/en-GB/shell.json'

type TeamSwitchCopyKey = keyof typeof enGB.teamSwitch
export type TeamSwitchTranslator = (
  key: `teamSwitch.${TeamSwitchCopyKey}`,
  values?: Record<string, string>,
) => string

const englishCopy: TeamSwitchTranslator = (key, values = {}) => {
  const template = enGB.teamSwitch[key.slice('teamSwitch.'.length) as TeamSwitchCopyKey]
  return Object.entries(values).reduce(
    (message, [name, value]) => message.replaceAll(`{{${name}}}`, value),
    template,
  )
}

export const teamSwitchFailureMessage = (input: {
  code?: string
  currentTeam?: string
  state?: 'reauthenticate' | 'retained' | 'unknown'
  targetTeam: string
  translate?: TeamSwitchTranslator
}): string => {
  const copy = input.translate ?? englishCopy
  if (input.state === 'unknown') {
    return copy('teamSwitch.unknown', { target: input.targetTeam })
  }
  if (input.state === 'reauthenticate') {
    return copy('teamSwitch.reauthenticate', { target: input.targetTeam })
  }

  const current = input.currentTeam?.trim() || copy('teamSwitch.currentTeam')
  const base = copy('teamSwitch.base', { target: input.targetTeam, current })

  if (input.code === 'INTERACTION_REQUIRED') {
    return `${base} ${copy('teamSwitch.verification')}`
  }
  if (
    input.code === 'INVALID_REFRESH_TOKEN'
    || input.code === 'TEAM_SWITCH_REAUTH_REQUIRED'
  ) {
    return teamSwitchFailureMessage({
      state: 'reauthenticate',
      targetTeam: input.targetTeam,
      translate: input.translate,
    })
  }
  if (input.code === 'TEAM_SWITCH_CONFLICT') {
    return `${base} ${copy('teamSwitch.conflict')}`
  }
  if (input.code === 'SSO_TEAM_REAUTH_REQUIRED') {
    return `${base} ${copy('teamSwitch.signInUoa')}`
  }
  if (input.code === 'TEAM_NOT_UOA_LINKED') {
    return `${base} ${copy('teamSwitch.unlinked')}`
  }
  return base
}
