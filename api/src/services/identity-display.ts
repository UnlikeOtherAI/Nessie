export type ExternalAuthTeam = {
  activeOrgId?: string
  activeTeamId?: string
  orgId?: string
  orgRole?: string
  teamIds: string[]
  teamRoles: Record<string, string>
}

/**
 * What the identity provider asserted about a person in this exchange.
 *
 * `displayName` and `avatarUrl` are OPTIONAL and mean "the provider asserted
 * this", never "here is something to show". Nessie no longer manufactures a
 * name when the provider supplies none: the profile is the provider's to own,
 * so an absent claim leaves the local mirror alone (see `uoa-profile-mirror.ts`)
 * and a brand-new row falls back to the email address until the provider says
 * otherwise.
 */
export type ExternalAuthIdentity = {
  avatarUrl?: string
  displayName?: string
  email: string
  externalSubject?: string
  uoaTokenVersion?: number
  team?: ExternalAuthTeam
}

export type ExternalTeamSelection = {
  organizationId: string | null
  teamId: string | null
}

/**
 * Resolve the team selected by UOA.
 *
 * UOA can omit `active` when its `team_selection: "auto"` flow skips the
 * chooser for a user with exactly one active team. That sole team is still the
 * selected team and must be projected consistently into the Nessie
 * session, team binding, and every product account link.
 */
export const resolveExternalTeamSelection = (
  team?: ExternalAuthTeam,
): ExternalTeamSelection => ({
  organizationId: team?.activeOrgId ?? team?.orgId ?? null,
  teamId:
    team?.activeTeamId
    ?? (team?.teamIds.length === 1 ? team.teamIds[0] ?? null : null),
})

/**
 * The name the provider actually asserted, or undefined when it asserted none.
 *
 * A candidate that merely echoes the email address is not an assertion about
 * the person's name, so it is dropped — otherwise a provider that fills
 * `preferred_username` with the address would overwrite a real name on the next
 * profile sync. Nothing is synthesized from the address here: manufacturing a
 * name is what made Nessie a second profile authority.
 */
export const resolveIdentityDisplayName = (
  email: string,
  candidates: Array<string | undefined>,
): string | undefined => {
  const normalizedEmail = email.trim().toLowerCase()
  return candidates
    .map((candidate) => candidate?.trim() ?? '')
    .find(
      (candidate) =>
        candidate.length > 0
        && candidate.toLowerCase() !== normalizedEmail,
    )
}
