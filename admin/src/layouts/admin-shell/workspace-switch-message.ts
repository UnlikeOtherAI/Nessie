export const workspaceSwitchFailureMessage = (input: {
  code?: string
  currentWorkspace?: string
  targetWorkspace: string
}): string => {
  const current = input.currentWorkspace?.trim() || 'your current workspace'
  const base = `Couldn’t switch to ${input.targetWorkspace}. You’re still in ${current}.`

  if (input.code === 'INTERACTION_REQUIRED') {
    return `${base} This workspace requires another sign-in verification.`
  }
  if (
    input.code === 'INVALID_REFRESH_TOKEN'
    || input.code === 'WORKSPACE_SWITCH_REAUTH_REQUIRED'
  ) {
    return `${base} Sign in again when you’re ready to continue.`
  }
  if (input.code === 'WORKSPACE_SWITCH_CONFLICT') {
    return `${base} Another session update finished first. Try again.`
  }
  return base
}
