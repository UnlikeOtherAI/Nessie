import { z } from 'zod'

import { NonEmptyStringSchema } from './schema-primitives.js'

const UuidSchema = z.string().uuid()
const JsonRecordSchema = z.record(z.string(), z.unknown())

export const KnowledgeVisibilitySchema = z.enum([
  'private',
  'channel',
  'team',
  'project',
  'organization',
])

export const KnowledgeSensitivityTierSchema = z.enum([
  'normal',
  'sensitive',
  'restricted',
])

/**
 * The knowledge-space shape returned to browser clients. Keeping this in the
 * shared contract package makes a server/client field mismatch a type error
 * instead of a silently undefined UI capability.
 */
export const KnowledgeSpaceResponseSchema = z.object({
  id: UuidSchema,
  ownerAgentId: UuidSchema.nullable(),
  name: NonEmptyStringSchema,
  description: z.string().nullable(),
  metadata: JsonRecordSchema.nullable(),
  writeRestricted: z.boolean(),
  memberUserIds: z.array(UuidSchema),
  memberAgentIds: z.array(UuidSchema),
  // Effective verdicts for the requesting actor. Writing content and
  // administering the space's access list are deliberately separate powers.
  canWrite: z.boolean(),
  canManageAccess: z.boolean(),
  organizationId: UuidSchema,
  projectId: UuidSchema,
  teamId: UuidSchema.nullable().optional(),
  channelId: UuidSchema.nullable().optional(),
  threadId: UuidSchema.nullable().optional(),
  userId: UuidSchema.nullable().optional(),
  visibility: KnowledgeVisibilitySchema,
  sensitivityTier: KnowledgeSensitivityTierSchema,
  privateToAgentId: UuidSchema.nullable().optional(),
  createdBy: NonEmptyStringSchema,
  deletedAt: z.string().nullable(),
  sourceRef: NonEmptyStringSchema,
  visibilityReason: NonEmptyStringSchema,
  policyChainTrace: z.array(z.string()),
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
})
export type KnowledgeSpaceResponse = z.infer<typeof KnowledgeSpaceResponseSchema>
