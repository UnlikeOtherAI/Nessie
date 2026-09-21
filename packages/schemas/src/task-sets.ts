import { z } from 'zod'

const uuid = z.string().uuid()
const timestamp = z.string().datetime({ offset: true })
export const TaskSetStatusSchema = z.enum([
  'draft', 'importing', 'ready', 'running', 'waiting', 'paused', 'blocked', 'completed', 'cancelled',
])
export const TaskSetItemStatusSchema = z.enum([
  'pending', 'running', 'completed', 'failed', 'skipped', 'blocked_dependency',
])

export const TaskSetProcessorSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  modelSubscriptionId: uuid.optional(),
  localInferenceBindingId: uuid.optional(),
}).strict()
export const TaskSetProcessorOptionSchema = TaskSetProcessorSchema.extend({
  id: z.string().min(1),
  label: z.string(),
  source: z.enum(['ledger', 'subscription', 'local']),
  resourceLabel: z.string().nullable(),
  available: z.boolean(),
  reason: z.string().nullable(),
  setupUrl: z.string().nullable(),
  localInferenceHostId: uuid.optional(),
  inferenceResourceId: uuid.optional(),
})

export const TaskSetSourceSchema = z.object({
  kind: z.literal('document'),
  pageId: uuid,
  versionId: uuid,
  format: z.enum(['csv', 'tsv', 'xlsx', 'sqlite', 'json', 'jsonl']),
  selection: z.object({
    sheet: z.string().min(1).optional(),
    table: z.string().min(1).optional(),
    headerRow: z.number().int().positive().optional(),
    firstRow: z.number().int().positive().optional(),
    lastRow: z.number().int().positive().optional(),
    fields: z.record(z.union([z.string().min(1), z.number().int().positive()])).optional(),
    keyField: z.string().min(1).optional(),
    recordPath: z.string().optional(),
  }).strict(),
}).strict()

export const TaskSetOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('journal') }).strict(),
  z.object({
    kind: z.literal('documents'), spaceId: uuid, parentId: uuid.optional(),
    format: z.enum(['text', 'jsonl']),
  }).strict(),
  z.object({
    kind: z.literal('spreadsheet'), spaceId: uuid, parentId: uuid.optional(),
    fields: z.record(z.string().min(1)),
  }).strict(),
])
export const TaskSetReceiverSchema = z.object({
  agentId: uuid, channelId: uuid, instructions: z.string().trim().min(1).max(32000),
}).strict()

export const TaskSetDisclosureSchema = z.object({
  classified: z.literal(true),
  basisScopes: z.array(z.object({ scopeType: z.string().min(1), scopeId: z.string().min(1) })),
  disclosureSources: z.array(z.object({ sourceChannelId: uuid, sourceAuthorUserId: uuid.nullable() })),
}).strict()
export const TaskSetImportedItemSchema = z.object({
  ordinal: z.number().int().positive(),
  key: z.string().min(1),
  input: z.unknown(),
  inputHash: z.string(),
  sourceLocator: z.string(),
  disclosure: TaskSetDisclosureSchema,
})

export const TaskSetItemInputSchema = z.object({
  clientKey: z.string().trim().min(1).max(200),
  prompt: z.string().max(32000),
  input: z.unknown().optional(),
  dependencies: z.array(uuid).max(100).optional(),
}).strict()
export const TaskSetItemUpdateSchema = z.object({
  prompt: z.string().max(32000).optional(),
  input: z.unknown().optional(),
  dependencies: z.array(uuid).max(100).optional(),
}).strict()

export const TaskSetCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(32000),
  instructions: z.string().max(32000),
  processor: TaskSetProcessorSchema,
  source: TaskSetSourceSchema.nullable().optional(),
  output: TaskSetOutputSchema,
  receiver: TaskSetReceiverSchema.nullable().optional(),
  maxParallelRequests: z.number().int().min(1).max(32).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  search: z.enum(['none', 'processor']).optional(),
  originThreadId: uuid.optional(),
  originMessageId: uuid.optional(),
  items: z.array(TaskSetItemInputSchema).max(500).optional(),
}).strict()
export const TaskSetUpdateSchema = TaskSetCreateSchema.omit({
  items: true, originThreadId: true, originMessageId: true,
}).partial()
export const TaskSetActionSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'cancel', 'retry', 'skip']),
  itemId: uuid.optional(),
}).strict()
export const TaskSetListQuerySchema = z.object({
  cursor: z.string().optional(),
  direction: z.enum(['forward', 'backward']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: TaskSetStatusSchema.optional(),
})
export const TaskSetItemQuerySchema = TaskSetListQuerySchema.omit({ status: true }).extend({
  status: TaskSetItemStatusSchema.optional(),
})
export const TaskSetRecordSchema = z.object({
  id: uuid, name: z.string(), objective: z.string(), instructions: z.string(),
  status: TaskSetStatusSchema, createdAt: timestamp, statusChangedAt: timestamp,
  reason: z.string().nullable(), processor: TaskSetProcessorSchema,
  source: TaskSetSourceSchema.nullable(), output: TaskSetOutputSchema,
  receiver: TaskSetReceiverSchema.nullable(),
  maxParallelRequests: z.number().int(), maxAttempts: z.number().int(),
  search: z.enum(['none', 'processor']),
  totalItems: z.number().int(), completedItems: z.number().int(), skippedItems: z.number().int(),
  currentItemId: uuid.nullable(), originThreadId: uuid.nullable(),
  originMessageId: uuid.nullable(), outputPageId: uuid.nullable(),
  deliveryStatus: z.enum(['none', 'pending', 'delivered', 'blocked']),
})
export const TaskSetItemRecordSchema = z.object({
  id: uuid, taskSetId: uuid, sequence: z.number().int(), prompt: z.string(), input: z.unknown(),
  dependencies: z.array(uuid), sourceLocator: z.string().nullable(),
  status: TaskSetItemStatusSchema, createdAt: timestamp, statusChangedAt: timestamp,
  attempts: z.number().int(), reason: z.string().nullable(), result: z.string().nullable(),
  outputPageId: uuid.nullable(),
})
export type TaskSetProcessor = z.infer<typeof TaskSetProcessorSchema>
export type TaskSetProcessorOption = z.infer<typeof TaskSetProcessorOptionSchema>
export type TaskSetSource = z.infer<typeof TaskSetSourceSchema>
export type TaskSetOutput = z.infer<typeof TaskSetOutputSchema>
export type TaskSetDisclosure = z.infer<typeof TaskSetDisclosureSchema>
export type TaskSetImportedItem = z.infer<typeof TaskSetImportedItemSchema>
export type TaskSetCreate = z.infer<typeof TaskSetCreateSchema>
export type TaskSetUpdate = z.infer<typeof TaskSetUpdateSchema>
export type TaskSetAction = z.infer<typeof TaskSetActionSchema>
export type TaskSetItemInput = z.infer<typeof TaskSetItemInputSchema>
export type TaskSetItemUpdate = z.infer<typeof TaskSetItemUpdateSchema>
export type TaskSetRecord = z.infer<typeof TaskSetRecordSchema>
export type TaskSetItemRecord = z.infer<typeof TaskSetItemRecordSchema>
