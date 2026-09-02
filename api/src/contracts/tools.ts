import {
  AgentIdSchema,
  OrganizationIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  ToolCategoryIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

export const ToolDescriptorSchema = z.object({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  safe: z.boolean(),
  builtin: z.boolean().optional(),
  enabled: z.boolean().optional(),
  handlerKind: z.string().optional(),
  // When true this builtin is OFF for every agent by default and requires an
  // explicit per-agent tool-policy allow to be exposed (mirrors the worker's
  // `requiresExplicitGrant` resolution — e.g. `deep_water_run_update`).
  requiresExplicitGrant: z.boolean().optional(),
  // Where the tool belongs in every surface that lists tools, declared by the
  // tool itself. Optional on the wire only because an organization-local
  // registry entry (a custom or executor-projected tool) is not a
  // `BuiltinToolDefinition` and has none; every builtin carries one, enforced
  // by the required field on that type.
  category: ToolCategoryIdSchema.optional(),
})
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>

export const ToolRegistryEntrySchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema.nullish(),
  toolId: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  safe: z.boolean(),
  builtin: z.boolean(),
  enabled: z.boolean(),
  handlerKind: NonEmptyStringSchema,
  metadata: z.record(z.unknown()).default({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ToolRegistryEntry = z.infer<typeof ToolRegistryEntrySchema>

export const CreateToolRegistryEntryBodySchema = z.object({
  toolId: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  safe: z.boolean().optional(),
  builtin: z.boolean().optional(),
  enabled: z.boolean().optional(),
  handlerKind: NonEmptyStringSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
})

export const TemporaryContextSessionSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  agentId: AgentIdSchema.nullish(),
  runId: RunIdSchema.nullish(),
  threadId: ThreadIdSchema.nullish(),
  title: z.string().nullish(),
  toolIds: z.array(NonEmptyStringSchema),
  createdByActorType: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  droppedAt: TimestampSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type TemporaryContextSession = z.infer<typeof TemporaryContextSessionSchema>

export const CreateTemporaryContextSessionBodySchema = z.object({
  agentId: AgentIdSchema.optional(),
  runId: RunIdSchema.optional(),
  threadId: ThreadIdSchema.optional(),
  title: z.string().optional(),
  toolIds: z.array(NonEmptyStringSchema).min(1),
})
