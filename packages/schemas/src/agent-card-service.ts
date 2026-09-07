import { z } from 'zod'

/** Server-resolved service mark displayed on a universal card. */
export const AgentCardServiceSchema = z
  .object({
    key: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(40),
  })
  .strict()
export type AgentCardService = z.infer<typeof AgentCardServiceSchema>
