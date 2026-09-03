// The UOA team-roster seam lives in `@nessie/team-admin` so the
// personal assistant's `people_search` (worker) reads the same roster the
// Members page routes serve — the worker cannot import `api/src/services/*`.
// The routes keep importing it from here.
export {
  acceptTeamInvitation,
  createUoaOrganisation,
  createUoaTeamTeam,
  createTeamInvitations,
  listTeamInvitations,
  listTeamMembers,
  removeTeamMember,
  resendTeamInvitation,
  resolveLocalUserIdsByUoaSub,
  resolveUoaRosterTeam,
  revokeTeamInvitation,
  reviewTeamInvitation,
  setTeamMemberActivation,
  updateTeamMemberRole,
  UoaInvitationOrgConflictError,
  UoaInvitationAlreadyAcceptedError,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
  type UoaProvisionedTeam,
  type UoaRosterDeps,
  type UoaRosterPrisma,
  type UoaRosterTeam,
  type TeamInvitationReview,
  type TeamMemberActivation,
} from '@nessie/team-admin'

// The organisation object itself is UOA-owned too: a rename is relayed, never
// stored locally as an independent value. Same seam, same package, same reason
// the roster lives there.
export { renameUoaOrganization } from '@nessie/team-admin'
