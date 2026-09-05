/**
 * Contracts for automatic team access after sign-in
 * (`docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md`).
 *
 * One response shape serves both the organisation and the team surface, so the
 * admin renders one component parameterised by scope. `challenge` is optional
 * in the shape and stripped server-side for every reader who is not an
 * organisation admin of the owning organisation.
 */

import { z } from 'zod'

export const AUTOMATIC_MEMBERSHIP_DOMAIN_STATUSES = [
  'pending', 'verified', 'active', 'suspended', 'revoked',
] as const
export type AutomaticMembershipDomainStatus =
  (typeof AUTOMATIC_MEMBERSHIP_DOMAIN_STATUSES)[number]

export const AUTOMATIC_MEMBERSHIP_RULE_HEALTH = ['ok', 'needs_reauthorization'] as const
export type AutomaticMembershipRuleHealth =
  (typeof AUTOMATIC_MEMBERSHIP_RULE_HEALTH)[number]

export const AUTOMATIC_MEMBERSHIP_RECONCILE_STATUSES = [
  'queued', 'running', 'completed', 'failed', 'superseded', 'cancelled',
] as const
export type AutomaticMembershipReconcileStatus =
  (typeof AUTOMATIC_MEMBERSHIP_RECONCILE_STATUSES)[number]

/** The DNS record an administrator publishes. Built from the stored domain. */
export const DOMAIN_VERIFICATION_RECORD_PREFIX = '_nessie-domain-verification'
export const DOMAIN_VERIFICATION_VALUE_PREFIX = 'nessie-domain-verification='

export const domainVerificationRecordName = (domain: string): string =>
  `${DOMAIN_VERIFICATION_RECORD_PREFIX}.${domain}`

export const domainVerificationRecordValue = (challenge: string): string =>
  `${DOMAIN_VERIFICATION_VALUE_PREFIX}${challenge}`

/** One team a domain grants, as the panel renders it. */
export type AutomaticMembershipRuleRecord = {
  id: string
  teamId: string
  teamName: string
  enabled: boolean
  createdScope: 'organization' | 'team'
  health: AutomaticMembershipRuleHealth
  healthReason?: string
  /** True when the caller may enable, disable or detach this rule. */
  manageable: boolean
  grantedCount: number
}

export type AutomaticMembershipReconcileRecord = {
  id: string
  status: AutomaticMembershipReconcileStatus
  scanned: number
  matched: number
  granted: number
  skipped: number
  failed: number
  lastError?: string
  startedAt?: string
  finishedAt?: string
}

export type AutomaticMembershipDomainRecord = {
  id: string
  domain: string
  status: AutomaticMembershipDomainStatus
  /** Org-admin readers only; stripped for everyone else. */
  challenge?: string
  recordName: string
  recordValue?: string
  challengeExpiresAt: string
  firstSeenAt?: string
  verifiedAt?: string
  lastCheckedAt?: string
  lastCheckOutcome?: string
  lastCheckDetail?: string
  rules: AutomaticMembershipRuleRecord[]
  reconciliation?: AutomaticMembershipReconcileRecord
}

/** A team the organisation surface offers as a checkbox. */
export type AutomaticMembershipTeamOption = {
  id: string
  name: string
}

export type AutomaticMembershipPermissions = {
  /** Claim, verify, rotate, suspend, revoke, and toggle provisioning. */
  manageDomains: boolean
  /** Attach or detach at least one team. */
  manageRules: boolean
  /** Start, stop and re-run reconciliation. */
  manageReconciliation: boolean
}

export type AutomaticMembershipResponse = {
  /** False when the organisation's emergency stop is engaged. */
  provisioningEnabled: boolean
  domains: AutomaticMembershipDomainRecord[]
  /** Populated on the organisation surface only. */
  teamOptions: AutomaticMembershipTeamOption[]
  permissions: AutomaticMembershipPermissions
}

export const CreateAutomaticMembershipDomainSchema = z.object({
  domain: z.string().min(1).max(255),
})
export type CreateAutomaticMembershipDomainRequest =
  z.infer<typeof CreateAutomaticMembershipDomainSchema>

/**
 * The team set for a domain. There is deliberately no role field anywhere in
 * this contract: an automatic grant is always an ordinary member, so there is
 * nothing for a caller to escalate.
 */
export const SetAutomaticMembershipTeamsSchema = z.object({
  teamIds: z.array(z.string().uuid()).max(200),
})
export type SetAutomaticMembershipTeamsRequest =
  z.infer<typeof SetAutomaticMembershipTeamsSchema>

export const SetAutomaticMembershipDomainStatusSchema = z.object({
  status: z.enum(['active', 'suspended']),
})

export const SetAutomaticMembershipEnabledSchema = z.object({
  enabled: z.boolean(),
})

/** The team surface toggles only its own team against a domain. */
export const SetTeamAutomaticMembershipSchema = z.object({
  enabled: z.boolean(),
})

export const AUTOMATIC_MEMBERSHIP_ERROR_CODES = {
  CLAIMED: 'AUTOMATIC_MEMBERSHIP_DOMAIN_CLAIMED',
  DISABLED: 'AUTOMATIC_MEMBERSHIP_DISABLED',
  DOMAIN_REJECTED: 'AUTOMATIC_MEMBERSHIP_DOMAIN_REJECTED',
  NEEDS_REAUTHORIZATION: 'AUTOMATIC_MEMBERSHIP_NEEDS_REAUTHORIZATION',
  NOT_FOUND: 'AUTOMATIC_MEMBERSHIP_NOT_FOUND',
  UNVERIFIED: 'AUTOMATIC_MEMBERSHIP_DNS_UNVERIFIED',
} as const

/** The organisation-scoped emergency stop. Absent means enabled (see §11). */
export const AUTOMATIC_MEMBERSHIP_SETTING_KEY = 'automaticMembership.enabled'
