import { z } from 'zod'

/**
 * These records deliberately contain domain configuration and UOA subject
 * references only. An email address is never a Nessie identity key.
 */
export const AutomaticMembershipClaimStateSchema = z.enum([
  'pending', 'verified', 'suspended', 'revoked', 'challenge_rotation',
])
export const AutomaticMembershipRuleStateSchema = z.enum([
  'inactive', 'active', 'suspended', 'revoked',
])
export const AutomaticMembershipScopeSchema = z.enum(['organization', 'team'])
export const AutomaticMembershipBackfillStatusSchema = z.enum([
  'queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'superseded',
])

export const AutomaticMembershipRuleSchema = z.object({
  id: z.string().uuid(),
  domain: z.string(),
  claimState: AutomaticMembershipClaimStateSchema,
  state: AutomaticMembershipRuleStateSchema,
  scope: AutomaticMembershipScopeSchema,
  generation: z.number().int().positive(),
  notificationEmail: z.string().email().nullable(),
  lastDnsCheckAt: z.string().datetime().nullable(),
  verifiedAt: z.string().datetime().nullable(),
  verificationExpiresAt: z.string().datetime().nullable(),
  suspensionReason: z.string().nullable(),
  targetTeamIds: z.array(z.string().uuid()),
})
export type AutomaticMembershipRule = z.infer<typeof AutomaticMembershipRuleSchema>

export const AutomaticMembershipRulesResponseSchema = z.object({
  featureEnabled: z.boolean(),
  killSwitchEnabled: z.boolean(),
  rules: z.array(AutomaticMembershipRuleSchema),
})
export type AutomaticMembershipRulesResponse = z.infer<typeof AutomaticMembershipRulesResponseSchema>

export const CreateAutomaticMembershipRuleSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  notificationEmail: z.string().trim().email().max(320).optional(),
  targetTeamIds: z.array(z.string().uuid()).min(1).max(100).optional(),
})
export const UpdateAutomaticMembershipRuleSchema = z.object({
  targetTeamIds: z.array(z.string().uuid()).min(1).max(100).optional(),
  notificationEmail: z.string().trim().email().max(320).nullable().optional(),
})
