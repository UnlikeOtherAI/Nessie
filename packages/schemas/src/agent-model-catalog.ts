import { z } from 'zod'

/**
 * A chat-completions model that the deployment's Ledger bearer is currently
 * permitted to invoke. `provider` is Ledger's service id, not a credential or
 * browser-callable endpoint.
 */
export const AgentModelOptionSchema = z.object({
  provider: z.string().min(1),
  providerDisplayName: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1).optional(),
})
export type AgentModelOption = z.infer<typeof AgentModelOptionSchema>
