import { z } from 'zod'

/** Machine keys for card inputs and actions: stable, lowercase, model-authored. */
export const AgentCardKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, 'Keys are lowercase, start with a letter, max 32 characters')
export type AgentCardKey = z.infer<typeof AgentCardKeySchema>

export const AgentCardActionStyleSchema = z.enum(['primary', 'secondary', 'danger'])
export type AgentCardActionStyle = z.infer<typeof AgentCardActionStyleSchema>

const AgentCardActionHrefSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!value.startsWith('/') || value.includes('\\') || /%2f|%5c|[\u0000-\u001F\u007F]/iu.test(value)) return false
    try {
      const base = 'https://nessie.invalid'
      return new URL(value, base).origin === base
    } catch {
      return false
    }
  }, 'Card action links must be app paths.')

/**
 * Card-footer actions. A same-app continuation may preserve partial non-secret
 * form values, but only after claiming the card, so stale choices cannot race.
 */
export const AgentCardActionSchema = z
  .object({
    key: AgentCardKeySchema,
    label: z.string().trim().min(1).max(24),
    style: AgentCardActionStyleSchema,
    submits: z.boolean(),
    collectsValues: z.boolean().optional(),
    href: AgentCardActionHrefSchema.optional(),
  })
  .strict()
  .superRefine((action, ctx) => {
    if (action.submits && action.collectsValues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An action either submits or preserves form values, not both.',
        path: ['collectsValues'],
      })
    }
    if (action.href && !action.submits && !action.collectsValues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A card action link must claim the card by submitting or preserving its inputs.',
        path: ['href'],
      })
    }
    if (action.collectsValues && !action.href) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Preserving form values requires a same-app doorway.',
        path: ['collectsValues'],
      })
    }
  })
export type AgentCardAction = z.infer<typeof AgentCardActionSchema>
