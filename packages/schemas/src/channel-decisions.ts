import { z } from 'zod'
import { parseAcknowledgeEmoji } from './agent-reaction.js'

export const MAX_CHANNEL_DECISION_POLICY_BYTES = 16_000

const DecisionIdSchema = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/)

const FollowUpSchema = z.object({
  agentId: z.string().uuid(),
  principalUserId: z.string().uuid().optional(),
  instructions: z.string().trim().min(1).max(4000),
}).strict()

const OptionSchema = z.object({
  id: DecisionIdSchema,
  description: z.string().trim().min(1).max(1000),
  followUp: FollowUpSchema.optional(),
}).strict()

const QuestionSchema = z.object({
  id: DecisionIdSchema,
  instructions: z.string().trim().min(1).max(4000),
  options: z.array(OptionSchema).min(2).max(16),
}).strict().superRefine((question, context) => {
  const ids = new Set<string>()
  question.options.forEach((option, index) => {
    if (ids.has(option.id)) {
      context.addIssue({ code: 'custom', path: ['options', index, 'id'], message: 'Option IDs must be unique' })
    }
    ids.add(option.id)
  })
  if (question.options.every((option) => option.followUp)) {
    context.addIssue({ code: 'custom', path: ['options'], message: 'Include an option with no follow-up' })
  }
})

/** Stored channel policy and the shared REST/assistant write contract. */
export const ChannelDecisionPolicySchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  instructions: z.string().trim().min(1).max(4000),
  minimumProbability: z.number().min(0).max(1),
  reactions: z.array(z.object({
    emoji: z.string().trim().min(1).max(32)
      .refine((value) => parseAcknowledgeEmoji(value) !== null, 'Use an emoji for the reaction')
      .refine((value) => value !== '👀', 'The eyes reaction is reserved for work in progress'),
    description: z.string().trim().min(1).max(500),
  }).strict()).max(16),
  questions: z.array(QuestionSchema).max(8),
}).strict().superRefine((policy, context) => {
  if (new TextEncoder().encode(JSON.stringify(policy)).byteLength > MAX_CHANNEL_DECISION_POLICY_BYTES) {
    context.addIssue({
      code: 'custom',
      message: 'The decision policy is too large (maximum 16,000 UTF-8 bytes). Shorten its guidance or options.',
    })
  }
  const ids = new Set<string>()
  policy.questions.forEach((question, index) => {
    if (ids.has(question.id)) {
      context.addIssue({ code: 'custom', path: ['questions', index, 'id'], message: 'Question IDs must be unique' })
    }
    ids.add(question.id)
  })
  const emojis = new Set<string>()
  policy.reactions.forEach((reaction, index) => {
    if (emojis.has(reaction.emoji)) {
      context.addIssue({ code: 'custom', path: ['reactions', index, 'emoji'], message: 'Reactions must be unique' })
    }
    emojis.add(reaction.emoji)
  })
})

export type ChannelDecisionPolicy = z.infer<typeof ChannelDecisionPolicySchema>

export const DEFAULT_CHANNEL_DECISION_POLICY: ChannelDecisionPolicy = {
  version: 1,
  enabled: false,
  instructions: 'Help the channel make progress. Reply only when useful; acknowledge updates with an appropriate reaction.',
  minimumProbability: 0.8,
  reactions: [
    { emoji: '👍', description: 'Acknowledge an update or confirm understanding.' },
    { emoji: '✅', description: 'Acknowledge completed work or a settled decision.' },
    { emoji: '🙏', description: 'Thank someone for their help.' },
    { emoji: '🎉', description: 'Celebrate a milestone or good news.' },
  ],
  questions: [],
}
