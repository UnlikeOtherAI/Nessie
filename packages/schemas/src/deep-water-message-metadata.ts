import { z } from 'zod'

/**
 * The two server-written message pointers the DeepWater brief flow stamps.
 * Both are strict, both carry only ids, and neither is ever accepted from a
 * client or a model: the research card renders its run through the viewer's
 * own authorised read, and the wake kickoff is a hidden trigger.
 */

/**
 * The research card: a message that points at one DeepWater product run. Its
 * text is plain content for models and search; the card itself is rendered
 * from `GET …/research-runs/:runId` for the viewer (docs/standards/agent-cards.md).
 */
export const ResearchRunRefMessageMetadataSchema = z
  .object({
    researchRunRef: z
      .object({
        schemaVersion: z.literal(1),
        runId: z.string().uuid(),
      })
      .strict(),
  })
  .strict()
export type ResearchRunRefMessageMetadata = z.infer<typeof ResearchRunRefMessageMetadataSchema>

/**
 * Does this message carry a research card pointer? The one predicate for the
 * question, shared by the edit refusal (`MESSAGE_IMMUTABLE_RESEARCH_CARD`) and
 * the admin, so the two never disagree. Only the key's presence is structural.
 */
export const isResearchRunRefMessage = (metadata: unknown): boolean =>
  ResearchRunRefMessageMetadataSchema.shape.researchRunRef.safeParse(
    (metadata as { researchRunRef?: unknown } | null | undefined)?.researchRunRef,
  ).success

/**
 * The action-context purpose of a run woken by a DeepWater delivery. Such a
 * wake drains alone from the per-(agent, thread) pending queue, like a peer
 * delegation, so it keeps its own requester's identity and lineage, and its
 * failure is announced in the thread, because the person who asked is
 * waiting for the answer.
 */
export const DEEP_WATER_DELIVERY_PURPOSE = 'deep_water.delivery'

export const DeepWaterDeliveryKindSchema = z.enum([
  'turn',
  'completed',
  'failed',
  'start_unconfirmed',
])
export type DeepWaterDeliveryKind = z.infer<typeof DeepWaterDeliveryKindSchema>

/**
 * The hidden `role: 'system'` kickoff that wakes the agent that asked for a
 * research, one run per wake. `turnId` names the planner turn for a `turn`
 * wake and is null for terminal wakes.
 */
export const DeepWaterDeliveryMessageMetadataSchema = z
  .object({
    deepWaterDelivery: z
      .object({
        schemaVersion: z.literal(1),
        runId: z.string().uuid(),
        kind: DeepWaterDeliveryKindSchema,
        turnId: z.string().uuid().nullable(),
      })
      .strict()
      .refine((delivery) => (delivery.kind === 'turn') === (delivery.turnId !== null), {
        message: 'turnId is set exactly for turn wakes',
        path: ['turnId'],
      }),
  })
  .strict()
export type DeepWaterDeliveryMessageMetadata = z.infer<typeof DeepWaterDeliveryMessageMetadataSchema>

export const DeepWaterNoticeKindSchema = z.enum([
  /** A finished research, addressed to the person who asked. */
  'result',
  /** The research did not finish. */
  'failed',
  /** The finished research could not be delivered; the notice names the remedy. */
  'blocked',
  /** DeepWater never confirmed the brief. */
  'start_unconfirmed',
  /** The agent that asked could not be woken, so the person is told instead. */
  'wake_unreachable',
  /** The agent working on the brief has been woken as often as a brief allows. */
  'wake_cap',
])
export type DeepWaterNoticeKind = z.infer<typeof DeepWaterNoticeKindSchema>

/**
 * A visible message DeepWater posts into the thread a research belongs to —
 * a result, or a notice naming what happened and what to do. Server-written
 * only; it points at the run so the thread can show the run's actions beside
 * it, and it is never a card or an agent's words.
 */
export const DeepWaterNoticeMessageMetadataSchema = z
  .object({
    deepWaterNotice: z
      .object({
        schemaVersion: z.literal(1),
        runId: z.string().uuid(),
        kind: DeepWaterNoticeKindSchema,
      })
      .strict(),
  })
  .strict()
export type DeepWaterNoticeMessageMetadata = z.infer<typeof DeepWaterNoticeMessageMetadataSchema>
