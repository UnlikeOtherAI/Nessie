// The UOA workspace-roster seam lives in `@nessie/workspace-admin` so the
// personal assistant's `people_search` (worker) reads the same roster the
// Members page routes serve — the worker cannot import `api/src/services/*`.
// The routes keep importing it from here.
export {
  acceptWorkspaceInvitation,
  createUoaOrganisation,
  createUoaWorkspaceTeam,
  createWorkspaceInvitations,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  removeWorkspaceMember,
  resendWorkspaceInvitation,
  resolveLocalUserIdsByUoaSub,
  resolveUoaRosterWorkspace,
  revokeTeamInvitation,
  reviewWorkspaceInvitation,
  setWorkspaceMemberActivation,
  updateWorkspaceMemberRole,
  UoaInvitationOrgConflictError,
  UoaInvitationAlreadyAcceptedError,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
  type UoaProvisionedWorkspace,
  type UoaRosterDeps,
  type UoaRosterPrisma,
  type UoaRosterWorkspace,
  type WorkspaceInvitationReview,
  type WorkspaceMemberActivation,
} from '@nessie/workspace-admin'

// The organisation and the workspace are UOA-owned objects too, not just the
// people in them: a rename of either is relayed, never stored locally as an
// independent value. Same seam, same package, same reason the roster lives
// there.
export { renameUoaOrganization, renameUoaWorkspace } from '@nessie/workspace-admin'

// The organisation-wide roster (every member, no team join) — distinct from
// `listWorkspaceMembers` above, which is correctly team-scoped. An
// "Organization Members" surface must read these, never the team-scoped
// ones.
export {
  listOrganisationMembers,
  updateOrganisationMemberRole,
  withUoaOrgRosterSubjectAssertion,
} from '@nessie/workspace-admin'
