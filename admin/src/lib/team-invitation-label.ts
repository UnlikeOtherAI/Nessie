/**
 * How one pending team invitation names itself in the switcher, the bell and
 * the `/alerts` page.
 *
 * An invitation can come from an organisation the recipient does not belong to
 * yet, and two organisations on one domain routinely both own a team called
 * "General" — so a row that names only the team is ambiguous at best and
 * unidentifiable at worst. `orgName` is optional on the wire (older UOA builds
 * omit it), and a missing one degrades to the team name alone rather than
 * hiding the row or printing a dangling separator.
 */
export const teamInvitationLabel = (invite: {
  orgName?: string
  teamName: string
}): string => {
  const organizationName = invite.orgName?.trim()
  return organizationName ? `${invite.teamName} · ${organizationName}` : invite.teamName
}
