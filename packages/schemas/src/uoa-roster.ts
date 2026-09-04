/**
 * Team roster and invitation records, as Nessie serves them from the
 * UnlikeOtherAI (UOA) org API. Nothing here is persisted: every field is read
 * per request from UOA, which owns human identity, membership and invitations.
 *
 * Members are identified by their stable UOA subject — never a local user id
 * and never an email row — so a rename or an address change cannot re-point a
 * roster action at somebody else.
 */

export type TeamMemberRecord = {
  /** Stable UOA subject (`userId` in UOA's org payloads). */
  uoaSub: string
  /**
   * The local Nessie principal id **in this organization**, when this person
   * has ever signed in here. Resolved per request from the UOA subject and
   * never stored on the roster; absent for somebody UOA knows but Nessie has
   * not yet materialised.
   *
   * It is the join key that lets a surface line a person up with the Nessie
   * objects they own — the people-and-their-agents tree — without Nessie
   * holding a second copy of the roster. Never an identity claim about the
   * subject: it is scoped to this organization precisely because `User.uoaSub`
   * is globally unique.
   */
  userId?: string
  displayName?: string
  email?: string
  /** Role inside this team (UOA team role). */
  teamRole?: string
  /** Role in the owning UOA organisation. */
  orgRole?: string
  /** UOA membership lifecycle: ACTIVE | DEACTIVATED | REMOVED. */
  status?: string
  avatarImageUrl?: string
}

/** The live UOA verdict for the actions a roster surface may offer. */
export type MemberRosterPermissions = {
  addMember: boolean
  changeMemberRole: boolean
  removeMember: boolean
  deactivateMember?: boolean
  reactivateMember?: boolean
  viewMemberEmail: boolean
  searchMemberCandidates?: boolean
  /** UOA's live, assignable team-role vocabulary (never ownership). */
  teamRoleOptions?: string[]
}

/** A stateless UOA list response, retaining its keyset pagination contract. */
export type MemberRosterPage<T> = {
  items: T[]
  permissions: MemberRosterPermissions
}

/** An eligible, already-active organisation member for a team add. */
export type TeamMemberCandidate = {
  uoaSub: string
  displayName?: string
  email?: string
  avatarImageUrl?: string
  orgRole?: string
}

/** A team the current UOA caller may explicitly choose for an org invitation. */
export type MemberInvitationTarget = {
  id: string
  name: string
  slug?: string
  avatarImageUrl?: string
}

/** An editable team membership at organisation scope; a UOA team is a workspace. */
export type MemberWorkspaceAccess = {
  id: string
  name: string
  slug?: string
  avatarImageUrl?: string
  hasAccess: boolean
}

export type MemberWorkspaceAccessResponse = {
  items: MemberWorkspaceAccess[]
  permissions: { changeWorkspaceAccess: boolean }
}

export type TeamInvitationRecord = {
  inviteId: string
  email?: string
  name?: string
  teamRole?: string
  /** pending | accepted | declined | replaced | expired. */
  status?: string
  /** not_required | pending | approved | denied. */
  approvalStatus?: string
  invitedByName?: string
  lastSentAt?: string
  expiresAt?: string
  team?: MemberInvitationTarget
}

/** Per-email outcome of a bulk invite: invited | resent_existing | already_member | … */
export type TeamInviteResult = {
  email?: string
  status?: string
}

export type TeamMembersResponse = {
  members: TeamMemberRecord[]
}

export type TeamInvitationsResponse = {
  invitations: TeamInvitationRecord[]
}

export type MemberInvitationPage = {
  items: TeamInvitationRecord[]
  permissions: Pick<MemberRosterPermissions, 'addMember'> & {
    viewPendingInvitations: boolean
  }
}

export type MemberInvitationTargetPage = {
  items: MemberInvitationTarget[]
  permissions: { createInvitation: boolean }
}

export type CreateTeamInvitationsRequest = {
  invites: { email: string; name?: string; teamRole?: string }[]
}

export type CreateTeamInvitationsResponse = {
  results: TeamInviteResult[]
}

export type CreateMemberInvitationRequest = {
  email: string
  name?: string
  teamRole?: string
}
