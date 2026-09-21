import { z } from 'zod'
import { AuthorizedActionContextSchema } from './access-context.js'

const IdentityShape = { agentId: z.string().uuid(), principalUserId: z.string().uuid().optional() }

/** Retains an abstention without producing a noisy chat notice. */
export const ChannelDecisionChoiceSchema = z.object({
  questionId: z.string(), choice: z.string(), probability: z.number().min(0).max(1),
  meetsThreshold: z.boolean(),
})
export type ChannelDecisionChoice = z.infer<typeof ChannelDecisionChoiceSchema>

/** Server-owned outcome, authority and source lineage pinned to one trigger message. */
export const ChannelDecisionSnapshotSchema = z.object({
  policyFingerprint: z.string(),
  authorizer: AuthorizedActionContextSchema.nullable(),
  choices: z.array(ChannelDecisionChoiceSchema).optional(),
  basisScopes: z.array(z.object({ scopeId: z.string().min(1), scopeType: z.string().min(1) })),
  disclosureSources: z.array(z.object({
    sourceAuthorUserId: z.string().min(1).nullable(), sourceChannelId: z.string().min(1),
  })),
  decisions: z.array(z.discriminatedUnion('action', [
    z.object({ action: z.literal('none') }),
    z.object({ action: z.literal('acknowledge'), ...IdentityShape, emoji: z.string() }),
    z.object({
      action: z.literal('reply'), ...IdentityShape,
      replyPlacement: z.enum(['thread', 'channel']).optional(),
      promptOverride: z.string().optional(), background: z.boolean().optional(),
      policyWork: z.boolean().optional(),
    }),
  ])),
})

export type ChannelDecisionSnapshot = z.infer<typeof ChannelDecisionSnapshotSchema>
