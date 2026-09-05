import {
  PolicyActionSchema,
  PolicyEffectSchema,
  PolicyResourceTypeSchema,
  PolicyScopeSchema,
} from '@nessie/schemas'
import { z } from 'zod'

// ─── Policy (governance rules and bindings) ───────────────────────────────

export const PolicyCheckBodySchema = z.object({
  resourceType: PolicyResourceTypeSchema,
  action: PolicyActionSchema,
}).strict()
export type PolicyCheckBody = z.infer<typeof PolicyCheckBodySchema>

const PolicyRuleBindingInputSchema = z.object({
  actorType: z.string().trim().min(1).max(64),
  actorId: z.string().trim().min(1).max(255),
}).strict()

export const CreatePolicyRuleBodySchema = z.object({
  scope: PolicyScopeSchema,
  scopeId: z.string().uuid(),
  resourceType: PolicyResourceTypeSchema,
  action: PolicyActionSchema,
  effect: PolicyEffectSchema,
  priority: z.number().int().optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  bindings: z.array(PolicyRuleBindingInputSchema).optional(),
}).strict()
export type CreatePolicyRuleBody = z.infer<typeof CreatePolicyRuleBodySchema>

export const UpdatePolicyRuleBodySchema = z.object({
  effect: PolicyEffectSchema.optional(),
  priority: z.number().int().optional(),
  conditions: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict()
export type UpdatePolicyRuleBody = z.infer<typeof UpdatePolicyRuleBodySchema>

export const AddPolicyBindingBodySchema = PolicyRuleBindingInputSchema
export type AddPolicyBindingBody = z.infer<typeof AddPolicyBindingBodySchema>
