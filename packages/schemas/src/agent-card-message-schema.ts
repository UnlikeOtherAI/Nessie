import { z } from 'zod'

import { AgentCardKeySchema } from './agent-card-actions.js'

/**
 * The entire durable payload on the assistant message. The card id is an
 * opaque pointer: the spec, mutable status, who may press, and the resolution
 * are all loaded from the authenticated, viewer-scoped presenter — the same
 * discipline `AppSetupCardSchema` follows, and for the same reason (a press
 * must be claimed by a conditional UPDATE on a row, not a JSON mutation).
 */
export const AgentCardMessageMetadataSchema = z
  .object({
    agentCard: z
      .object({
        cardId: z.string().uuid(),
        schemaVersion: z.literal(1),
      })
      .strict(),
  })
  .strict()
export type AgentCardMessageMetadata = z.infer<typeof AgentCardMessageMetadataSchema>

/**
 * Stamped on the *response* message a press creates. Read structurally by the
 * orchestrator to wake the card's agent — never by matching content.
 */
export const AgentCardResponseMetadataSchema = z
  .object({
    agentCardResponse: z
      .object({
        cardId: z.string().uuid(),
        actionKey: AgentCardKeySchema,
        schemaVersion: z.literal(1),
      })
      .strict(),
  })
  .strict()
export type AgentCardResponseMetadata = z.infer<typeof AgentCardResponseMetadataSchema>

/**
 * Does this message record a card press? The one predicate for that question —
 * the message-edit service refuses these (a "Deny" edited into "Allow" would
 * lie beside a card that says otherwise) and the admin hides the edit
 * affordance on them, and those two must never disagree.
 *
 * Only the key's presence is structural; the metadata around it is not this
 * predicate's business, so a card response is recognised even when a future
 * key sits beside it and the strict schema above would reject the whole
 * object.
 */
export const isAgentCardResponseMessage = (metadata: unknown): boolean =>
  AgentCardResponseMetadataSchema.shape.agentCardResponse.safeParse(
    (metadata as { agentCardResponse?: unknown } | null | undefined)?.agentCardResponse,
  ).success


export const AgentCardRespondBodySchema = z
  .object({
    actionKey: AgentCardKeySchema,
    /** The exact temporary session adopted by a browser-login Done press. */
    handoverSessionId: z.string().uuid().optional(),
    values: z.record(z.union([z.string().max(4000), z.number(), z.boolean()])).optional(),
    secrets: z.record(z.string().min(1).max(8192)).optional(),
  })
  .strict()
export type AgentCardRespondBody = z.infer<typeof AgentCardRespondBodySchema>

/**
 * What a committed press answers, to the presser alone.
 *
 * `executorReview` is present only for a system-authored executor review card:
 * the confirmation token minted for this presser at the press, so the review
 * it opens can confirm. It lives in this response and in the presser's memory
 * — never in the card row, the message, realtime, an address or a model's
 * context.
 */
export const AgentCardRespondResultSchema = z
  .object({
    cardId: z.string().uuid(),
    responseMessageId: z.string().uuid(),
    status: z.literal('resolved'),
    executorReview: z
      .object({
        accessChangeId: z.string().uuid(),
        confirmationToken: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
export type AgentCardRespondResult = z.infer<typeof AgentCardRespondResultSchema>
