export const teamSwitchFailureMessage = (input: {
  code?: string
  currentTeam?: string
  state?: 'reauthenticate' | 'retained' | 'unknown'
  targetTeam: string
}): string => {
  if (input.state === 'unknown') {
    return `Couldn’t confirm whether the switch to ${input.targetTeam} completed. Check your connection and refresh before trying again.`
  }
  if (input.state === 'reauthenticate') {
    return `Couldn’t finish switching to ${input.targetTeam}. Sign in again when you’re ready to continue.`
  }

  const current = input.currentTeam?.trim() || 'your current team'
  const base = `Couldn’t switch to ${input.targetTeam}. You’re still in ${current}.`

  if (input.code === 'INTERACTION_REQUIRED') {
    return `${base} This team requires another sign-in verification.`
  }
  if (
    input.code === 'INVALID_REFRESH_TOKEN'
    || input.code === 'TEAM_SWITCH_REAUTH_REQUIRED'
  ) {
    return teamSwitchFailureMessage({
      state: 'reauthenticate',
      targetTeam: input.targetTeam,
    })
  }
  if (input.code === 'TEAM_SWITCH_CONFLICT') {
    return `${base} Another session update finished first. Try again.`
  }
  return base
}
