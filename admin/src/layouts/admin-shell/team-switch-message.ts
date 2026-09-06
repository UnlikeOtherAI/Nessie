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
  // Two different refusals, and the difference is whether signing in can help.
  //
  // A team that exists in UnlikeOtherAI but was not the one this credential was
  // issued for is a re-authentication away. A team with no UnlikeOtherAI
  // identity at all is not: sending somebody through SSO for it returns them
  // to this same message, because there is nothing on the other side to
  // authenticate them into. Saying so is the difference between a person
  // fixing it and a person retrying forever.
  if (input.code === 'SSO_TEAM_REAUTH_REQUIRED') {
    return `${base} Sign in with UnlikeOtherAI to open it.`
  }
  if (input.code === 'TEAM_NOT_UOA_LINKED') {
    return `${base} It is not linked to UnlikeOtherAI, so it cannot be opened —`
      + ' signing in again will not help. An administrator has to recreate it'
      + ' through UnlikeOtherAI.'
  }
  return base
}
