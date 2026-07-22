export type ExternalAuthWorkspace = {
  activeOrgId?: string
  activeTeamId?: string
  orgId?: string
  orgRole?: string
  teamIds: string[]
  teamRoles: Record<string, string>
}

export type ExternalAuthIdentity = {
  avatarUrl?: string
  displayName: string
  email: string
  externalSubject?: string
  uoaTokenVersion?: number
  workspace?: ExternalAuthWorkspace
}

export type ExternalWorkspaceSelection = {
  organizationId: string | null
  teamId: string | null
}

/**
 * Resolve the workspace selected by UOA.
 *
 * UOA can omit `active` when its `workspace_selection: "auto"` flow skips the
 * chooser for a user with exactly one active team. That sole team is still the
 * selected workspace and must be projected consistently into the Nessie
 * session, team binding, and every product account link.
 */
export const resolveExternalWorkspaceSelection = (
  workspace?: ExternalAuthWorkspace,
): ExternalWorkspaceSelection => ({
  organizationId: workspace?.activeOrgId ?? workspace?.orgId ?? null,
  teamId:
    workspace?.activeTeamId
    ?? (workspace?.teamIds.length === 1 ? workspace.teamIds[0] ?? null : null),
})

const EMAIL_LIKE_DISPLAY_NAME = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Derive a human-friendly display name from an email's local part, e.g.
// "ondrej.rafaj@gmail.com" -> "Ondrej Rafaj".
export const humanizeEmailLocalPart = (email: string): string => {
  const localPart = email.split('@')[0] ?? email
  const words = localPart
    .split(/[._+-]+/)
    .map((part) => part.replace(/\d+/g, '').trim())
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  return words.join(' ') || email
}

export const isEmailLikeDisplayName = (displayName: string): boolean =>
  EMAIL_LIKE_DISPLAY_NAME.test(displayName.trim())

export const resolveStoredDisplayName = (
  email: string,
  displayName: string,
): string =>
  isEmailLikeDisplayName(displayName)
    ? humanizeEmailLocalPart(email.trim().toLowerCase())
    : displayName

export const resolveIdentityDisplayName = (
  email: string,
  candidates: Array<string | undefined>,
): string => {
  const normalizedEmail = email.trim().toLowerCase()
  const providerName = candidates
    .map((candidate) => candidate?.trim() ?? '')
    .find(
      (candidate) =>
        candidate.length > 0 &&
        candidate.toLowerCase() !== normalizedEmail &&
        !isEmailLikeDisplayName(candidate),
    )

  return providerName ?? humanizeEmailLocalPart(normalizedEmail)
}
