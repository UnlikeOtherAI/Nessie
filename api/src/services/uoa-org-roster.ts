// The UOA team-roster seam lives in `@nessie/team-admin` so the
// personal assistant's `people_search` (worker) reads the same roster the
// Members page routes serve — the worker cannot import `api/src/services/*`.
// The routes keep importing it from here.
export {
  acceptTeamInvitation,
  checkUoaSlugAvailability,
  createUoaOrganisation,
  createUoaTeamTeam,
  createTeamInvitation,
  createTeamInvitations,
  addTeamMember,
  findTeamMemberCandidates,
  listTeamInvitations,
  listTeamMembers,
  removeTeamMember,
  resendTeamInvitation,
  resolveLocalUserIdsByUoaSub,
  resolveUoaTeamHost,
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
  type UoaRosterListQuery,
  type UoaRosterPage,
} from '@nessie/team-admin'

// The organisation and the team are UOA-owned objects too, not just the
// people in them: a rename of either is relayed, never stored locally as an
// independent value. Same seam, same package, same reason the roster lives
// there.
export { renameUoaOrganization, renameUoaTeam } from '@nessie/team-admin'

// The organisation-wide roster (every member, no team join) — distinct from
// `listTeamMembers` above, which is correctly team-scoped. An
// "Organization Members" surface must read these, never the team-scoped
// ones.
export {
  listMemberInvitationTargets,
  listOrganisationMemberInvitations,
  listOrganisationMembers,
  listOrganisationMemberWorkspaceAccess,
  updateOrganisationMemberRole,
  withUoaOrgRosterSubjectAssertion,
} from '@nessie/team-admin'
