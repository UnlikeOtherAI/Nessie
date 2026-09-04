/* eslint-disable max-len -- typed Prisma transaction payloads remain more legible unwrapped. */
import { createHash } from 'node:crypto'
import { resolveTxt } from 'node:dns/promises'
import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import { createAutomaticMembershipChallenge, decryptAutomaticMembershipChallenge, encryptAutomaticMembershipChallenge } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  assertAutomaticMembershipDomainAllowed,
  automaticMembershipTxtName,
  DOMAIN_CLASSIFIER_VERSION,
  DomainPolicyError,
} from './automatic-membership-domain-policy.js'
import { createProductionUoaAutomaticMembershipAdapter } from './uoa-automatic-membership-production.js'

const verificationLifetimeMs = 14 * 24 * 60 * 60 * 1000

export const automaticMembershipEnabled = (): boolean =>
  process.env.NESSIE_AUTOMATIC_MEMBERSHIP_ENABLED === 'true'
  && createProductionUoaAutomaticMembershipAdapter() !== null

export const automaticMembershipKillSwitchEnabled = (): boolean =>
  process.env.NESSIE_AUTOMATIC_MEMBERSHIP_KILL_SWITCH === 'true'

type RuleScope = 'organization' | 'team'
type CreateRuleInput = { domain: string; notificationEmail?: string; targetTeamIds?: string[] }
type UpdateRuleInput = { notificationEmail?: string | null; targetTeamIds?: string[] }

const subjectFor = (context: AuthorizedActionContext): string => {
  const subject = context.actionContext.uoaIdentity?.subject
  if (!subject) throw new AutomaticMembershipError('UOA_SESSION_REQUIRED', 'A current UnlikeOtherAI session is required.')
  return subject
}

export class AutomaticMembershipError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message)
  }
}


const audit = async (
  tx: Prisma.TransactionClient,
  context: AuthorizedActionContext,
  action: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
  teamId: string | null = null,
) => writeAuditEntryInTransaction(tx, {
  organizationId: context.tenant.organizationId,
  teamId,
  actorType: 'user',
  actorId: context.actor.actorId,
  action,
  resourceType: 'automatic_membership_rule',
  resourceId,
  outcome: 'success',
  metadata: metadata as Prisma.InputJsonValue,
  requestId: context.actionContext.requestId,
})

const targetTeams = async (prisma: PrismaClient, externalOrgId: string, input: string[], scope: RuleScope, currentTeamId?: string | null): Promise<string[]> => {
  if (scope === 'organization') {
    // Nessie cannot currently enumerate a live UOA team directory with a
    // subject assertion. Do not turn the local Team mirror into authority.
    throw new AutomaticMembershipError('UOA_TEAM_DIRECTORY_REQUIRED', 'Automatic organisation rules require UOA’s live team-directory contract.', 503)
  }
  const expected = [currentTeamId].filter((id): id is string => Boolean(id))
  if (expected.length === 0) throw new AutomaticMembershipError('TEAM_TARGET_REQUIRED', 'Choose at least one team.', 400)
  const teams = await prisma.team.findMany({
    where: { id: { in: expected }, externalOrgId, externalTeamId: { not: null } }, select: { id: true },
  })
  if (teams.length !== new Set(expected).size) throw new AutomaticMembershipError('INVALID_TEAM_TARGET', 'One or more selected teams are not in this organisation.', 403)
  return teams.map((team) => team.id)
}

const presentRule = (rule: {
  id: string; scope: RuleScope; state: string; generation: number; suspensionReason: string | null
  claim: { domain: string; state: string; notificationEmail: string | null; verifiedAt: Date | null; verificationExpiresAt: Date | null; lastDnsCheckAt: Date | null }
  targets: Array<{ teamId: string }>
}) => ({
  id: rule.id, domain: rule.claim.domain, claimState: rule.claim.state, state: rule.state,
  scope: rule.scope, generation: rule.generation, notificationEmail: rule.claim.notificationEmail,
  lastDnsCheckAt: rule.claim.lastDnsCheckAt?.toISOString() ?? null,
  verifiedAt: rule.claim.verifiedAt?.toISOString() ?? null,
  verificationExpiresAt: rule.claim.verificationExpiresAt?.toISOString() ?? null,
  suspensionReason: rule.suspensionReason, targetTeamIds: rule.targets.map((target) => target.teamId),
})

export const listAutomaticMembershipRules = async (prisma: PrismaClient, organizationId: string, scope: RuleScope, teamId?: string | null) => {
  if (scope === 'team' && !teamId) {
    throw new AutomaticMembershipError('TEAM_NOT_LINKED', 'This team is not linked to UnlikeOtherAI.', 404)
  }
  const rules = await prisma.automaticMembershipRule.findMany({
    where: {
      organizationId,
      scope,
      ...(scope === 'team' ? { targets: { some: { teamId: teamId! } } } : {}),
    },
    include: { claim: true, targets: true }, orderBy: { createdAt: 'desc' },
  })
  return { featureEnabled: automaticMembershipEnabled(), killSwitchEnabled: automaticMembershipKillSwitchEnabled(), rules: rules.map(presentRule) }
}

export const createAutomaticMembershipRule = async (
  prisma: PrismaClient, context: AuthorizedActionContext, scope: RuleScope, input: CreateRuleInput,
  options: { authSecret: string; teamId?: string | null; externalOrgId?: string | null },
) => {
  if (!options.authSecret) throw new AutomaticMembershipError('AUTOMATIC_MEMBERSHIP_NOT_CONFIGURED', 'Automatic membership is not configured on this deployment.', 503)
  const domain = assertAutomaticMembershipDomainAllowed(input.domain)
  if (!options.externalOrgId) throw new AutomaticMembershipError('ORGANIZATION_NOT_LINKED', 'Automatic logins require an UnlikeOtherAI organisation.', 404)
  const targets = await targetTeams(prisma, options.externalOrgId, input.targetTeamIds ?? [], scope, options.teamId)
  const challenge = createAutomaticMembershipChallenge()
  const challengeDigest = createHash('sha256').update(challenge).digest('hex')
  const subject = subjectFor(context)
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.automaticMembershipDomainClaim.updateMany({
        where: { organizationId: context.tenant.organizationId, domain, state: 'pending', createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }, releasedAt: null },
        data: { releasedAt: new Date(), state: 'revoked' },
      })
      const existing = await tx.automaticMembershipDomainClaim.findFirst({ where: { organizationId: context.tenant.organizationId, domain, releasedAt: null } })
      const createdClaim = !existing
      const claim = existing ?? await tx.automaticMembershipDomainClaim.create({ data: {
        organizationId: context.tenant.organizationId, domain, challengeDigest,
        challengeEncrypted: encryptAutomaticMembershipChallenge(challenge, options.authSecret), classifierVersion: DOMAIN_CLASSIFIER_VERSION,
        notificationEmail: input.notificationEmail ?? null,
      } })
      if (scope === 'organization' && await tx.automaticMembershipRule.count({ where: { claimId: claim.id, scope: 'organization', state: { not: 'revoked' } } })) {
        throw new AutomaticMembershipError('RULE_EXISTS', 'This domain already has an organisation rule.', 409)
      }
      const rule = await tx.automaticMembershipRule.create({ data: {
        organizationId: context.tenant.organizationId, claimId: claim.id, scope, createdByUoaSub: subject,
        targets: { createMany: { data: targets.map((teamId) => ({ teamId })) } },
      }, include: { claim: true, targets: true } })
      await audit(tx, context, 'automatic_membership.claim_created', rule.id, { domain, scope }, scope === 'team' ? options.teamId ?? null : null)
      return { rule: presentRule(rule), ...(createdClaim ? { dns: { name: automaticMembershipTxtName(domain), value: challenge } } : {}) }
    })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      throw new AutomaticMembershipError('DOMAIN_CLAIMED', 'This domain is already claimed by another organisation.', 409)
    }
    throw error
  }
}

export const verifyAutomaticMembershipClaim = async (
  prisma: PrismaClient, context: AuthorizedActionContext, ruleId: string, authSecret: string,
  dnsLookup: (name: string) => Promise<readonly string[][]> = resolveTxt,
) => {
  const rule = await prisma.automaticMembershipRule.findFirst({ where: { id: ruleId, organizationId: context.tenant.organizationId }, include: { claim: true, targets: true } })
  if (!rule) throw new AutomaticMembershipError('RULE_NOT_FOUND', 'Automatic login rule not found.', 404)
  if (rule.state === 'revoked' || rule.claim.releasedAt) throw new AutomaticMembershipError('RULE_REVOKED', 'This rule has been revoked.', 409)
  let challenge: string
  try { challenge = decryptAutomaticMembershipChallenge(rule.claim.challengeEncrypted, authSecret) } catch { throw new AutomaticMembershipError('CHALLENGE_UNAVAILABLE', 'The DNS challenge must be rotated.', 409) }
  let records: readonly string[][]
  try { records = await dnsLookup(automaticMembershipTxtName(rule.claim.domain)) } catch { records = [] }
  const matched = records.some((chunks) => chunks.join('') === challenge)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + verificationLifetimeMs)
  const updated = await prisma.$transaction(async (tx) => {
    const claim = await tx.automaticMembershipDomainClaim.update({ where: { id: rule.claimId }, data: matched
      ? { state: 'verified', verifiedAt: now, verificationExpiresAt: expiresAt, lastDnsCheckAt: now, lastDnsFailure: null }
      : { state: 'pending', lastDnsCheckAt: now, lastDnsFailure: 'TXT record was missing or did not match' }, })
    await audit(tx, context, matched ? 'automatic_membership.verified' : 'automatic_membership.dns_checked', rule.id, { matched })
    return claim
  })
  return { verified: matched, rule: presentRule({ ...rule, claim: updated }) }
}

export const rotateAutomaticMembershipClaim = async (prisma: PrismaClient, context: AuthorizedActionContext, ruleId: string, authSecret: string) => {
  const rule = await prisma.automaticMembershipRule.findFirst({ where: { id: ruleId, organizationId: context.tenant.organizationId }, include: { claim: true, targets: true } })
  if (!rule) throw new AutomaticMembershipError('RULE_NOT_FOUND', 'Automatic login rule not found.', 404)
  const challenge = createAutomaticMembershipChallenge()
  const claim = await prisma.$transaction(async (tx) => {
    const next = await tx.automaticMembershipDomainClaim.update({ where: { id: rule.claimId }, data: {
      state: 'challenge_rotation', challengeGeneration: { increment: 1 }, challengeDigest: createHash('sha256').update(challenge).digest('hex'),
      challengeEncrypted: encryptAutomaticMembershipChallenge(challenge, authSecret), verifiedAt: null, verificationExpiresAt: null, lastDnsFailure: null,
    } })
    // Rotation is an immediate provisioning stop even before the next DNS check.
    await tx.automaticMembershipRule.update({ where: { id: rule.id }, data: { state: 'suspended', suspensionReason: 'DNS challenge rotated; verify the new TXT record before resuming.' } })
    await audit(tx, context, 'automatic_membership.rotated', rule.id)
    return next
  })
  return { dns: { name: automaticMembershipTxtName(claim.domain), value: challenge }, rule: presentRule({ ...rule, state: 'suspended', suspensionReason: 'DNS challenge rotated; verify the new TXT record before resuming.', claim }) }
}

export const updateAutomaticMembershipRule = async (prisma: PrismaClient, context: AuthorizedActionContext, ruleId: string, scope: RuleScope, input: UpdateRuleInput, teamId?: string | null) => {
  const existing = await prisma.automaticMembershipRule.findFirst({ where: { id: ruleId, organizationId: context.tenant.organizationId, scope }, include: { claim: true, targets: true } })
  if (!existing) throw new AutomaticMembershipError('RULE_NOT_FOUND', 'Automatic login rule not found.', 404)
  const organization = await prisma.organization.findUnique({ where: { id: context.tenant.organizationId }, select: { externalOrgId: true } })
  if (!organization?.externalOrgId) throw new AutomaticMembershipError('ORGANIZATION_NOT_LINKED', 'Automatic logins require an UnlikeOtherAI organisation.', 404)
  const targets = input.targetTeamIds === undefined ? existing.targets.map((target) => target.teamId) : await targetTeams(prisma, organization.externalOrgId, input.targetTeamIds, scope, teamId)
  const rule = await prisma.$transaction(async (tx) => {
    await tx.automaticMembershipBackfillRun.updateMany({ where: { ruleId, generation: existing.generation, status: { in: ['queued', 'running', 'paused'] } }, data: { status: 'superseded' } })
    if (input.notificationEmail !== undefined) await tx.automaticMembershipDomainClaim.update({ where: { id: existing.claimId }, data: { notificationEmail: input.notificationEmail } })
    await tx.automaticMembershipRuleTarget.deleteMany({ where: { ruleId } })
    await tx.automaticMembershipRuleTarget.createMany({ data: targets.map((targetTeamId) => ({ ruleId, teamId: targetTeamId })) })
    const updated = await tx.automaticMembershipRule.update({ where: { id: ruleId }, data: { generation: { increment: 1 } }, include: { claim: true, targets: true } })
    if (updated.state === 'active' && updated.claim.state === 'verified' && updated.claim.verificationExpiresAt && updated.claim.verificationExpiresAt > new Date()) {
      await tx.automaticMembershipBackfillRun.create({ data: {
        organizationId: context.tenant.organizationId, ruleId, generation: updated.generation,
        requestedByUoaSub: subjectFor(context),
      } })
    }
    await audit(tx, context, input.targetTeamIds ? 'automatic_membership.backfill_updated' : 'automatic_membership.contact_changed', ruleId, { generation: updated.generation })
    return updated
  })
  return presentRule(rule)
}

export const activateAutomaticMembershipRule = async (prisma: PrismaClient, context: AuthorizedActionContext, ruleId: string) => {
  if (!automaticMembershipEnabled()) throw new AutomaticMembershipError('AUTOMATIC_MEMBERSHIP_DISABLED', 'Automatic membership is not enabled for this deployment.', 503)
  if (automaticMembershipKillSwitchEnabled()) throw new AutomaticMembershipError('AUTOMATIC_MEMBERSHIP_KILL_SWITCH', 'Automatic provisioning is paused by the emergency kill switch.', 503)
  const rule = await prisma.automaticMembershipRule.findFirst({ where: { id: ruleId, organizationId: context.tenant.organizationId }, include: { claim: true, targets: true } })
  if (!rule) throw new AutomaticMembershipError('RULE_NOT_FOUND', 'Automatic login rule not found.', 404)
  if (rule.claim.state !== 'verified' || !rule.claim.verificationExpiresAt || rule.claim.verificationExpiresAt <= new Date()) throw new AutomaticMembershipError('DOMAIN_NOT_VERIFIED', 'Verify the DNS TXT record before activating this rule.', 409)
  const subject = subjectFor(context)
  const next = await prisma.$transaction(async (tx) => {
    const updated = await tx.automaticMembershipRule.update({ where: { id: ruleId }, data: { state: 'active', suspensionReason: null }, include: { claim: true, targets: true } })
    await tx.automaticMembershipBackfillRun.upsert({ where: { ruleId_generation: { ruleId, generation: updated.generation } }, update: { status: 'queued', cursor: null, snapshotId: null, nextAttemptAt: null }, create: { organizationId: context.tenant.organizationId, ruleId, generation: updated.generation, requestedByUoaSub: subject } })
    await audit(tx, context, 'automatic_membership.activated', ruleId, { generation: updated.generation })
    return updated
  })
  return presentRule(next)
}

export const revokeAutomaticMembershipRule = async (prisma: PrismaClient, context: AuthorizedActionContext, ruleId: string) => {
  const rule = await prisma.automaticMembershipRule.findFirst({ where: { id: ruleId, organizationId: context.tenant.organizationId }, include: { claim: true, targets: true } })
  if (!rule) throw new AutomaticMembershipError('RULE_NOT_FOUND', 'Automatic login rule not found.', 404)
  const updated = await prisma.$transaction(async (tx) => {
    await tx.automaticMembershipBackfillRun.updateMany({ where: { ruleId, status: { in: ['queued', 'running', 'paused'] } }, data: { status: 'cancelled' } })
    const next = await tx.automaticMembershipRule.update({ where: { id: ruleId }, data: { state: 'revoked', suspensionReason: 'Revoked by an administrator.' }, include: { claim: true, targets: true } })
    await audit(tx, context, 'automatic_membership.revoked', ruleId)
    return next
  })
  return presentRule(updated)
}

/** Suspend is reversible operational stop; revoke is the terminal rule action. */
export const suspendAutomaticMembershipRule = async (prisma: PrismaClient, context: AuthorizedActionContext, ruleId: string) => {
  const rule = await prisma.automaticMembershipRule.findFirst({ where: { id: ruleId, organizationId: context.tenant.organizationId }, include: { claim: true, targets: true } })
  if (!rule) throw new AutomaticMembershipError('RULE_NOT_FOUND', 'Automatic login rule not found.', 404)
  const updated = await prisma.$transaction(async (tx) => {
    await tx.automaticMembershipBackfillRun.updateMany({ where: { ruleId, status: { in: ['queued', 'running', 'paused'] } }, data: { status: 'paused' } })
    const next = await tx.automaticMembershipRule.update({ where: { id: ruleId }, data: { state: 'suspended', suspensionReason: 'Suspended by an administrator.' }, include: { claim: true, targets: true } })
    await audit(tx, context, 'automatic_membership.suspended', ruleId)
    return next
  })
  return presentRule(updated)
}

/** Domain ownership release is separate from disabling/revoking access rules. */
export const releaseAutomaticMembershipClaim = async (prisma: PrismaClient, context: AuthorizedActionContext, claimId: string) => {
  const claim = await prisma.automaticMembershipDomainClaim.findFirst({ where: { id: claimId, organizationId: context.tenant.organizationId }, include: { rules: { where: { state: { not: 'revoked' } }, select: { id: true } } } })
  if (!claim) throw new AutomaticMembershipError('CLAIM_NOT_FOUND', 'Domain claim not found.', 404)
  if (claim.rules.length > 0) throw new AutomaticMembershipError('ACTIVE_RULES_REMAIN', 'Revoke every access rule before releasing this domain.', 409)
  await prisma.$transaction(async (tx) => {
    await tx.automaticMembershipDomainClaim.update({ where: { id: claimId }, data: { state: 'revoked', releasedAt: new Date() } })
    await audit(tx, context, 'automatic_membership.revoked', claimId, { released: true })
  })
}

export { DomainPolicyError }
