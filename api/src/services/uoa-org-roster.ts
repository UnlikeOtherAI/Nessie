// The UOA workspace-roster seam lives in `@nessie/workspace-admin` so the
// personal assistant's `people_search` (worker) reads the same roster the
// Members page routes serve — the worker cannot import `api/src/services/*`.
// The routes keep importing it from here.
export {
  acceptWorkspaceInvitation,
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
  type UoaRosterDeps,
  type UoaRosterPrisma,
  type UoaRosterWorkspace,
  type WorkspaceInvitationReview,
  type WorkspaceMemberActivation,
} from '@nessie/workspace-admin'
