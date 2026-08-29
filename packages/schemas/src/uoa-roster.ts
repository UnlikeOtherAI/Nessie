/**
 * Workspace roster and invitation records, as Nessie serves them from the
 * UnlikeOtherAI (UOA) org API. Nothing here is persisted: every field is read
 * per request from UOA, which owns human identity, membership and invitations.
 *
 * Members are identified by their stable UOA subject — never a local user id
 * and never an email row — so a rename or an address change cannot re-point a
 * roster action at somebody else.
 */

export type WorkspaceMemberRecord = {
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
  /** Role inside this workspace (UOA team role). */
  teamRole?: string
  /** Role in the owning UOA organisation. */
  orgRole?: string
  /** UOA membership lifecycle: ACTIVE | DEACTIVATED | REMOVED. */
  status?: string
}

export type WorkspaceInvitationRecord = {
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
}

/** Per-email outcome of a bulk invite: invited | resent_existing | already_member | … */
export type WorkspaceInviteResult = {
  email?: string
  status?: string
}

export type WorkspaceMembersResponse = {
  members: WorkspaceMemberRecord[]
}

export type WorkspaceInvitationsResponse = {
  invitations: WorkspaceInvitationRecord[]
}

export type CreateWorkspaceInvitationsRequest = {
  invites: { email: string; name?: string; teamRole?: string }[]
}

export type CreateWorkspaceInvitationsResponse = {
  results: WorkspaceInviteResult[]
}
