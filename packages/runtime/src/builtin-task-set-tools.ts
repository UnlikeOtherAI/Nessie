import {
  TaskSetActionSchema, TaskSetCreateSchema, TaskSetItemInputSchema, TaskSetItemQuerySchema,
  TaskSetItemUpdateSchema, TaskSetListQuerySchema, TaskSetUpdateSchema,
} from '@nessie/schemas'
import { z } from 'zod'
import type { BuiltinToolDefinition } from './builtin-tools-types.js'

const id = { type: 'string', description: 'An exact UUID returned by the resolving read tool.' }
const text = { type: 'string' }
const page = { cursor: text, direction: { type: 'string', enum: ['forward', 'backward'] },
  limit: { type: 'integer', minimum: 1, maximum: 20 } }
const item = { type: 'object', properties: {
  clientKey: { type: 'string', description: 'Stable per-set idempotency key; reuse only with the identical item.' },
  prompt: text, input: {}, dependencies: { type: 'array', items: id, maxItems: 100 },
}, required: ['clientKey', 'prompt'] }
const configuration = {
  name: text, objective: text, instructions: text,
  processor: { type: 'object', properties: { provider: text, model: text,
    modelSubscriptionId: id, localInferenceBindingId: id }, required: ['provider', 'model'] },
  source: { type: ['object', 'null'], properties: {
    kind: { type: 'string', enum: ['document'] }, pageId: id, versionId: id,
    format: { type: 'string', enum: ['csv', 'tsv', 'xlsx', 'sqlite', 'json', 'jsonl'] },
    selection: { type: 'object', properties: {
      sheet: text, table: text, recordPath: text, keyField: text,
      headerRow: { type: 'integer', minimum: 1 }, firstRow: { type: 'integer', minimum: 1 },
      lastRow: { type: 'integer', minimum: 1 }, fields: { type: 'object', additionalProperties: {
        anyOf: [{ type: 'string' }, { type: 'integer', minimum: 1 }],
      } },
    } },
  }, required: ['kind', 'pageId', 'versionId', 'format', 'selection'] },
  output: { type: 'object', properties: {
    kind: { type: 'string', enum: ['journal', 'documents', 'spreadsheet'] }, spaceId: id, parentId: id,
    format: { type: 'string', enum: ['text', 'jsonl'] },
    fields: { type: 'object', additionalProperties: { type: 'string' },
      description: 'For a NEW spreadsheet, maps output column name to structured result field.' },
  }, required: ['kind'] },
  receiver: { type: ['object', 'null'], properties: { agentId: id, channelId: id, instructions: text },
    required: ['agentId', 'channelId', 'instructions'] },
  maxParallelRequests: { type: 'integer', minimum: 1, maximum: 32,
    description: 'Resource admission ceiling. Every set still runs strictly one item at a time.' },
  maxAttempts: { type: 'integer', minimum: 1, maximum: 10 },
  search: { type: 'string', enum: ['none', 'processor'] },
}
const setId = z.object({ taskSetId: z.string().uuid() })

/** Native tools use the requesting human's live authority, never a model-supplied identity. */
export const TASK_SET_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'task_set_processors', category: 'workflows', label: 'List Task Set Processors', safe: true,
    summary: 'List authorized models for durable sequential work.',
    description: 'Read available processor models before creating a task set. A local processor requires the exact '
      + 'pre-authorized binding returned here. Follow nextOffset until null for more options. '
      + 'Setup links grant no access. Never substitute a cloud model for local.',
    parameters: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 20 } } },
    inputSchema: z.object({ offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(20).optional() }).strict(),
  },
  {
    id: 'task_set_list', category: 'workflows', label: 'List Task Sets', safe: true,
    summary: 'Find the requesting person’s persistent task sets.',
    description: 'List accessible task sets and their durable progress. Follow the returned pagination cursor. '
      + 'Return the workload link when the person needs to inspect it.',
    parameters: { type: 'object', properties: { ...page, status: text } }, inputSchema: TaskSetListQuerySchema,
  },
  {
    id: 'task_set_read', category: 'workflows', label: 'Read Task Set', safe: true,
    summary: 'Read a task set’s configuration, progress and exact waiting or failure reason.',
    description: 'Read a task set resolved by task_set_list or task_set_create. Results are paged separately '
      + 'by task_set_items. Configuration is JSON text in bounded chunks; follow configuration.page.nextOffset '
      + 'until null. Do not repeatedly poll a workload in a model loop.',
    parameters: { type: 'object', properties: { taskSetId: id, offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 24000 } }, required: ['taskSetId'] },
    inputSchema: setId.extend({ offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(24000).optional() }),
  },
  {
    id: 'task_set_items', category: 'workflows', label: 'Read Task Set Items', safe: true,
    summary: 'Read ordered item progress and source locators one page at a time.',
    description: 'Read bounded item metadata with prompt previews. Use task_set_item_read for complete prompt, '
      + 'input or result content. Sequence is one-based. Pass the returned cursor unchanged. Never expand a large '
      + 'input file into thousands of model-authored calls.',
    parameters: { type: 'object', properties: { taskSetId: id, ...page, status: text }, required: ['taskSetId'] },
    inputSchema: setId.merge(TaskSetItemQuerySchema),
  },
  {
    id: 'task_set_item_read', category: 'workflows', label: 'Read Task Set Item', safe: true,
    summary: 'Read one exact item and its stored result.',
    description: 'Read an item id returned by task_set_items or currentItemId from task_set_read. Choose result, '
      + 'input, prompt or metadata (complete reason and source locator). Text is chunked; '
      + 'follow page.nextOffset until null to read the complete content.',
    parameters: { type: 'object', properties: { taskSetId: id, itemId: id,
      content: { type: 'string', enum: ['result', 'input', 'prompt', 'metadata'] }, offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 24000 } }, required: ['taskSetId', 'itemId'] },
    inputSchema: setId.extend({ itemId: z.string().uuid(), content: z.enum(['result', 'input', 'prompt', 'metadata']).optional(),
      offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(24000).optional() }),
  },
  {
    id: 'task_set_create', category: 'workflows', label: 'Create Task Set', safe: false,
    summary: 'Create sequential work with a processor and optional receiving agent.',
    description: 'Create a DRAFT; task_set_control starts it. Choose a processor from task_set_processors. '
      + 'For large data, upload the file to Documents and pin source page/version plus row selection. '
      + 'Use items only for small manual batches, at most 500. Dependencies name earlier item ids and do not '
      + 'change strict sequential execution. Output journal keeps results here; documents requires spaceId and '
      + 'format; spreadsheet requires spaceId and fields and creates a NEW Excel file. Receiver is optional; '
      + 'if present, resolve an agent and its authorized conversation and state the follow-on instructions. '
      + 'Source/output/receiver access is rechecked by the same service as the UI. Show the returned task-set link.',
    parameters: { type: 'object', properties: { ...configuration, items: { type: 'array', items: item, maxItems: 500 } },
      required: ['name', 'objective', 'instructions', 'processor', 'output'] },
    inputSchema: TaskSetCreateSchema.omit({ originThreadId: true, originMessageId: true }),
  },
  {
    id: 'task_set_update', category: 'workflows', label: 'Update Task Set', safe: false,
    summary: 'Edit the configuration of a stopped task set.',
    description: 'Patch only changed fields in a draft, paused or blocked set after its current item stops. '
      + 'The source version and selection are immutable once items exist. Receiver remains optional.',
    parameters: { type: 'object', properties: { taskSetId: id, patch: { type: 'object', properties: configuration } },
      required: ['taskSetId', 'patch'] }, inputSchema: setId.extend({ patch: TaskSetUpdateSchema }),
  },
  {
    id: 'task_set_add_items', category: 'workflows', label: 'Add Task Set Items', safe: false,
    summary: 'Append an idempotent manual batch while a task set is a draft.',
    description: 'Add at most 500 items to a manual draft. Use stable clientKey values for safe retries. '
      + 'Dependencies must name earlier items returned by task_set_items or this tool’s previous call. '
      + 'For a large file use a pinned source instead of enumerating records in conversation.',
    parameters: { type: 'object', properties: { taskSetId: id, items: { type: 'array', items: item, maxItems: 500 } },
      required: ['taskSetId', 'items'] }, inputSchema: setId.extend({ items: z.array(TaskSetItemInputSchema).max(500) }),
  },
  {
    id: 'task_set_update_item', category: 'workflows', label: 'Edit Task Set Item', safe: false,
    summary: 'Correct an unfinished item’s prompt, input or prerequisites while stopped.',
    description: 'Edit an unfinished item only after the task set has stopped. Completed and skipped items are retained. '
      + 'Use this to correct oversized input or an unavailable dependency before resuming.',
    parameters: { type: 'object', properties: { taskSetId: id, itemId: id,
      patch: { type: 'object', properties: { prompt: text, input: {}, dependencies: { type: 'array', items: id } } } },
    required: ['taskSetId', 'itemId', 'patch'] },
    inputSchema: setId.extend({ itemId: z.string().uuid(), patch: TaskSetItemUpdateSchema }),
  },
  {
    id: 'task_set_control', category: 'workflows', label: 'Control Task Set', safe: false,
    summary: 'Start, pause, resume, cancel, retry or explicitly skip ordered work.',
    description: 'Start a prepared draft; pause/cancel stops admissions and requests termination of the active item. '
      + 'Wait for currentItemId to clear before editing or resuming. Retry/skip names the next unfinished item. '
      + 'A completed set with blocked delivery can retry delivery only, without an itemId or rerunning completed work. '
      + 'Never infer completion from a tool returning: read its actual durable status.',
    parameters: { type: 'object', properties: { taskSetId: id, itemId: id,
      action: { type: 'string', enum: ['start', 'pause', 'resume', 'cancel', 'retry', 'skip'] } },
    required: ['taskSetId', 'action'] }, inputSchema: setId.merge(TaskSetActionSchema),
  },
]
