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
  /**
   * Which purse this option spends. Optional rather than defaulted so the
   * schema's input and output types stay identical — a `.default()` here makes
   * every consumer that passes a parsed value onward fight the divergence.
   * Absent means `ledger`.
   */
  source: z.enum(['ledger', 'subscription']).optional(),
  /**
   * Set only on a `subscription` option: WHICH linked account it spends. A
   * person may link two accounts at one provider, and the pair
   * (provider, model) cannot tell them apart — so the pointer travels with the
   * option and is what the agent stores.
   */
  modelSubscriptionId: z.string().uuid().optional(),
  /** Set only on a `subscription` option, for the account picker. */
  accountLabel: z.string().min(1).optional(),
})
export type AgentModelOption = z.infer<typeof AgentModelOptionSchema>
