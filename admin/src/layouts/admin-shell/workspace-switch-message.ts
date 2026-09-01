export const workspaceSwitchFailureMessage = (input: {
  code?: string
  currentWorkspace?: string
  state?: 'reauthenticate' | 'retained' | 'unknown'
  targetWorkspace: string
}): string => {
  if (input.state === 'unknown') {
    return `Couldn’t confirm whether the switch to ${input.targetWorkspace} completed. Check your connection and refresh before trying again.`
  }
  if (input.state === 'reauthenticate') {
    return `Couldn’t finish switching to ${input.targetWorkspace}. Sign in again when you’re ready to continue.`
  }

  const current = input.currentWorkspace?.trim() || 'your current workspace'
  const base = `Couldn’t switch to ${input.targetWorkspace}. You’re still in ${current}.`

  if (input.code === 'INTERACTION_REQUIRED') {
    return `${base} This workspace requires another sign-in verification.`
  }
  if (
    input.code === 'INVALID_REFRESH_TOKEN'
    || input.code === 'WORKSPACE_SWITCH_REAUTH_REQUIRED'
  ) {
    return workspaceSwitchFailureMessage({
      state: 'reauthenticate',
      targetWorkspace: input.targetWorkspace,
    })
  }
  if (input.code === 'WORKSPACE_SWITCH_CONFLICT') {
    return `${base} Another session update finished first. Try again.`
  }
  return base
}
