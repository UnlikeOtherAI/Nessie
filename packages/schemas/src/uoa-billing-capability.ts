import { z } from 'zod'

/** UOA-derived authority for one exact active billing subject. */
export const UoaBillingCapabilitySchema = z.object({
  canManageBilling: z.boolean(),
  canReadStatement: z.boolean(),
  scope: z.object({
    organisationId: z.string().min(1),
    teamId: z.string().min(1),
    tokenVersion: z.number().int().nonnegative(),
    userId: z.string().min(1),
  }).strict(),
}).strict()

export type UoaBillingCapability = z.infer<typeof UoaBillingCapabilitySchema>
