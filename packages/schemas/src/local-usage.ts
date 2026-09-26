import { z } from 'zod'

/**
 * Admin › Usage and limits: the organisation's own record of what its agents
 * and people used, in tokens and an estimated cost. This is local operational
 * data — never the billing service's credits, which live on Credits and
 * billing and must not render beside it (docs/standards/customer-billing.md).
 *
 * Lives in `@nessie/schemas` so the API parses what it sends and the admin
 * reads the same shape, rather than a hand-copied type drifting from it.
 */

/** What the usage is broken down by. */
export const LocalUsageBySchema = z.enum(['team', 'agent', 'person'])
export type LocalUsageBy = z.infer<typeof LocalUsageBySchema>

/**
 * The window: the current calendar week, month or year in UTC — the same
 * periods, starting at the same instants, as a budget's, so a row reads
 * against a cap.
 */
export const LocalUsagePeriodSchema = z.enum(['week', 'month', 'year'])
export type LocalUsagePeriod = z.infer<typeof LocalUsagePeriodSchema>

/**
 * Why a row carries no single named team, agent or person:
 * - `unattributed` — usage recorded with none (system work, or no person
 *   behind an automation);
 * - `private_agents` — every other person's private agents, folded into one
 *   row with no names: an organisation owner never sees another person's
 *   private agent (docs/standards/agent-ownership.md);
 * - `removed` — a team, agent or person no longer in this organisation.
 */
export const LocalUsageRowKindSchema = z.enum(['named', 'unattributed', 'private_agents', 'removed'])
export type LocalUsageRowKind = z.infer<typeof LocalUsageRowKindSchema>

export const LocalUsageRowSchema = z.object({
  /** The team, agent or person; null for every kind but `named`. */
  id: z.string().nullable(),
  kind: LocalUsageRowKindSchema,
  /** Present only for `named` rows. */
  name: z.string().nullable(),
  /** For `private_agents`, how many agents the row folds together. */
  count: z.number().int().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** US dollars, estimated at the active prices. */
  estimatedCost: z.number().nonnegative(),
  /**
   * Tokens in this row the organisation paid for but no price is known for, so
   * the estimate above leaves them out.
   */
  unpricedTokens: z.number().int().nonnegative(),
})
export type LocalUsageRow = z.infer<typeof LocalUsageRowSchema>

export const LocalUsageResponseSchema = z.object({
  by: LocalUsageBySchema,
  period: LocalUsagePeriodSchema,
  from: z.string().datetime(),
  to: z.string().datetime(),
  currency: z.literal('USD'),
  totalTokens: z.number().int().nonnegative(),
  estimatedCost: z.number().nonnegative(),
  unpricedTokens: z.number().int().nonnegative(),
  rows: z.array(LocalUsageRowSchema),
})
export type LocalUsageResponse = z.infer<typeof LocalUsageResponseSchema>
