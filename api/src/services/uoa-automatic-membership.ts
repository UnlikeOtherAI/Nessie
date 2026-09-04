/* eslint-disable max-len -- UOA contract signatures are kept together for review. */
/**
 * The only authority capable of adding a person to a UOA team. This interface
 * intentionally has no local-member fallback: production is disabled until an
 * adapter for these upstream operations is deployed.
 */
export type UoaVerifiedDomainAttestation = {
  uoaSub: string
  domain: string
  assertedAt: Date
  expiresAt: Date
}

export type UoaAutomaticMembershipTeam = { externalTeamId: string; name: string }

export type UoaDomainSnapshotPage = {
  snapshotId: string
  subjects: readonly string[]
  cursor: string | null
}

export type UoaAutomaticMembershipOperation = {
  operationId: string
  status: 'accepted' | 'completed' | 'already_member' | 'failed'
}

export interface UoaAutomaticMembershipAdapter {
  /** Fresh, subject-bound proof; email confirmation alone is not accepted. */
  attestVerifiedDomain(input: { uoaSub: string; domain: string }): Promise<UoaVerifiedDomainAttestation | null>
  /** UOA-owned, service-authorized directory for org-rule target selection. */
  listTeams(input: { externalOrgId: string }): Promise<readonly UoaAutomaticMembershipTeam[]>
  /** Re-check the administrator who requested a durable batch. */
  assertRuleAdministrator(input: { externalOrgId: string; externalTeamIds: readonly string[]; uoaSub: string }): Promise<boolean>
  setRuleFence(input: { externalOrgId: string; ruleId: string; generation: number; fenceToken: string; active: boolean }): Promise<void>
  /** Stable snapshot pagination, returning subjects only — never copied email. */
  listVerifiedDomainSubjects(input: { externalOrgId: string; domain: string; cursor?: string; snapshotId?: string; limit: number }): Promise<UoaDomainSnapshotPage>
  /** Service-scoped, member-only idempotent grant. No role parameter exists. */
  grantMember(input: { externalOrgId: string; externalTeamId: string; uoaSub: string; idempotencyKey: string; ruleId: string; ruleGeneration: number; fenceToken: string }): Promise<UoaAutomaticMembershipOperation>
  getOperation(input: { operationId: string }): Promise<UoaAutomaticMembershipOperation>
}

/** Fail closed, including when somebody accidentally enables the flag first. */
export const unavailableUoaAutomaticMembershipAdapter: UoaAutomaticMembershipAdapter = {
  async attestVerifiedDomain() { return null },
  async listTeams() { throw new Error('UOA automatic-membership adapter is not configured') },
  async assertRuleAdministrator() { return false },
  async setRuleFence() { throw new Error('UOA automatic-membership adapter is not configured') },
  async listVerifiedDomainSubjects() { throw new Error('UOA automatic-membership adapter is not configured') },
  async grantMember() { throw new Error('UOA automatic-membership adapter is not configured') },
  async getOperation() { throw new Error('UOA automatic-membership adapter is not configured') },
}
