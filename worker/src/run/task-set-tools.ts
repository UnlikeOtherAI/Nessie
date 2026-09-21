import { loadConfig } from '@nessie/config'
import {
  addTaskSetItemsForActor, controlTaskSetForActor, createTaskSetForActor, getTaskSetForActor,
  getTaskSetItemForActor, listTaskSetItemsForActor, listTaskSetProcessors, listTaskSetsForActor,
  taskSetRecord, updateTaskSetForActor, updateTaskSetItemForActor,
} from '@nessie/team-admin'
import {
  TaskSetActionSchema, TaskSetCreateSchema, TaskSetItemInputSchema, TaskSetItemQuerySchema,
  TaskSetItemUpdateSchema, TaskSetListQuerySchema, TaskSetUpdateSchema, type TaskSetDisclosure, type TaskSetRecord,
} from '@nessie/schemas'
import { z } from 'zod'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from './tool-types.js'

const SetId = z.object({ taskSetId: z.string().uuid() })
const ItemId = SetId.extend({ itemId: z.string().uuid() })
const Create = TaskSetCreateSchema.omit({ originThreadId: true, originMessageId: true })
const href = (id: string) => `/agents/task-sets/${encodeURIComponent(id)}`

/** The observer runs before a content-bearing return can enter the agent's context. */
export const taskSetDisclosureObserver = (context: BuiltinToolRuntimeContext) => {
  const sink = context.consumedSources
  if (!sink) throw new Error('Task-set tools require a disclosure-aware run context.')
  return (disclosure: TaskSetDisclosure): void => {
    sink.addAll(disclosure.basisScopes)
    for (const source of disclosure.disclosureSources) sink.addPrivateConversationSource(source)
  }
}

export const inheritedTaskSetDisclosure = (context: BuiltinToolRuntimeContext): TaskSetDisclosure => {
  const sink = context.consumedSources
  if (!sink) throw new Error('Task-set tools require a disclosure-aware run context.')
  return { classified: true, basisScopes: sink.list(), disclosureSources: sink.privateConversationSources() }
}

type TaskSetRunner = (context: BuiltinToolRuntimeContext, input: Record<string, unknown>) => Promise<unknown>
const modelDeps = (context: BuiltinToolRuntimeContext) => ({
  prisma: context.prisma, ledgerIdentity: context.ledgerIdentity, modelConfig: loadConfig().model,
})
const setSummary = (set: TaskSetRecord) => ({
  id: set.id, name: set.name, status: set.status, reason: set.reason?.slice(0, 512) ?? null,
  totalItems: set.totalItems, completedItems: set.completedItems, skippedItems: set.skippedItems,
  currentItemId: set.currentItemId, deliveryStatus: set.deliveryStatus, outputPageId: set.outputPageId,
})
const readRecord = async (context: BuiltinToolRuntimeContext, id: string) => taskSetRecord(await getTaskSetForActor(
  context.prisma, context.actorContext, id, taskSetDisclosureObserver(context),
))
const readSet = async (context: BuiltinToolRuntimeContext, id: string) => ({
  taskSet: setSummary(await readRecord(context, id)), url: href(id),
})
const contentPage = (text: string, offset: number, limit: number) => {
  let end = Math.min(text.length, offset + limit)
  // JSON escaping can multiply control characters sixfold; retain a resumable page below the tool cap.
  while (JSON.stringify(text.slice(offset, end)).length > 24000) end = offset + Math.floor((end - offset) / 2)
  return { text: text.slice(offset, end), page: {
    offset, nextOffset: end < text.length ? end : null, totalChars: text.length,
  } }
}
const boundedListPage = async <T>(load: (limit: number) => Promise<T>, limit: number): Promise<T> => {
  const page = await load(limit)
  return JSON.stringify(page).length > 28000 && limit > 1
    ? boundedListPage(load, Math.max(1, Math.floor(limit / 2))) : page
}
const TextPage = z.object({
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(24000).default(12000),
})

export const TASK_SET_TOOL_RUNNERS: Record<string, TaskSetRunner> = {
  task_set_processors: async (context, input) => {
    const args = z.object({ offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(20).default(20) }).parse(input)
    // The catalog is account/host metadata: retain the requesting person's boundary.
    const sink = taskSetDisclosureObserver(context)
    const processors = await listTaskSetProcessors(modelDeps(context), context.actorContext)
    const userId = context.actorContext.actionContext.effectiveUserId
      ?? (context.actorContext.actor.actorType === 'user' ? context.actorContext.actor.actorId : null)
    if (userId) sink({ classified: true, basisScopes: [{ scopeType: 'user', scopeId: userId }], disclosureSources: [] })
    return boundedListPage(async (limit) => ({ processors: processors.slice(args.offset, args.offset + limit),
      nextOffset: args.offset + limit < processors.length ? args.offset + limit : null }), args.limit)
  },
  task_set_list: async (context, input) => {
    const options = TaskSetListQuerySchema.parse(input)
    return boundedListPage(async (limit) => {
      const page = await listTaskSetsForActor(context.prisma, context.actorContext,
        { ...options, limit }, taskSetDisclosureObserver(context))
      return { ...page, data: page.data.map((set) => ({ ...setSummary(set), url: href(set.id) })) }
    }, Math.min(options.limit ?? 20, 20))
  },
  task_set_read: async (context, input) => {
    const args = SetId.merge(TextPage).parse(input)
    const set = await readRecord(context, args.taskSetId)
    return { taskSet: setSummary(set), url: href(set.id),
      configuration: contentPage(JSON.stringify(set), args.offset, args.limit) }
  },
  task_set_items: async (context, input) => {
    const { taskSetId, ...options } = SetId.merge(TaskSetItemQuerySchema).parse(input)
    return boundedListPage(async (limit) => {
      const page = await listTaskSetItemsForActor(context.prisma, context.actorContext, taskSetId,
        { ...options, limit }, taskSetDisclosureObserver(context))
      return { ...page, data: page.data.map((item) => ({
      id: item.id, sequence: item.sequence, status: item.status, attempts: item.attempts,
      sourceLocator: item.sourceLocator?.slice(0, 240) ?? null, statusChangedAt: item.statusChangedAt,
      reason: item.reason?.slice(0, 512) ?? null, dependencyCount: item.dependencies.length,
      promptPreview: item.prompt.slice(0, 240), hasResult: item.result !== null,
      url: `${href(taskSetId)}?item=${item.id}`,
      })) }
    }, Math.min(options.limit ?? 20, 20))
  },
  task_set_item_read: async (context, input) => {
    const args = ItemId.merge(TextPage).extend({
      content: z.enum(['result', 'input', 'prompt', 'metadata']).default('result'),
    }).parse(input)
    const item = await getTaskSetItemForActor(context.prisma, context.actorContext,
      args.taskSetId, args.itemId, taskSetDisclosureObserver(context))
    const text = args.content === 'metadata' ? JSON.stringify({
      sourceLocator: item.sourceLocator, dependencies: item.dependencies, attempts: item.attempts, reason: item.reason,
      status: item.status, createdAt: item.createdAt, statusChangedAt: item.statusChangedAt,
      outputPageId: item.outputPageId,
    }) : args.content === 'result' ? item.result ?? '' : args.content === 'prompt' ? item.prompt
      : typeof item.input === 'string' ? item.input : JSON.stringify(item.input ?? null)
    return { itemId: item.id, sequence: item.sequence, status: item.status, reason: item.reason?.slice(0, 512) ?? null,
      sourceLocator: item.sourceLocator?.slice(0, 240) ?? null,
      dependencies: item.dependencies, attempts: item.attempts,
      statusChangedAt: item.statusChangedAt, outputPageId: item.outputPageId,
      url: `${href(args.taskSetId)}?item=${item.id}`, content: args.content,
      ...contentPage(text, args.offset, args.limit) }
  },
  task_set_create: async (context, input) => {
    const created = await createTaskSetForActor(modelDeps(context), context.actorContext, {
      ...Create.parse(input), originThreadId: context.run.threadId, originMessageId: context.run.messageId,
    }, inheritedTaskSetDisclosure(context))
    return readSet(context, created.id)
  },
  task_set_update: async (context, input) => {
    const args = SetId.extend({ patch: TaskSetUpdateSchema }).parse(input)
    await updateTaskSetForActor(modelDeps(context), context.actorContext, args.taskSetId,
      args.patch, inheritedTaskSetDisclosure(context))
    return readSet(context, args.taskSetId)
  },
  task_set_add_items: async (context, input) => {
    const args = SetId.extend({ items: z.array(TaskSetItemInputSchema).max(500) }).parse(input)
    const added = await addTaskSetItemsForActor(context.prisma, context.actorContext, args.taskSetId,
      args.items, inheritedTaskSetDisclosure(context))
    await readSet(context, args.taskSetId)
    return { addedCount: added.length,
      items: added.slice(0, 20).map((item) => ({ id: item.id, sequence: item.sequence, status: item.status })),
      hasMoreItems: added.length > 20, readItemsWith: 'task_set_items', url: href(args.taskSetId) }
  },
  task_set_update_item: async (context, input) => {
    const args = ItemId.extend({ patch: TaskSetItemUpdateSchema }).parse(input)
    await updateTaskSetItemForActor(context.prisma, context.actorContext, args.taskSetId,
      args.itemId, args.patch, inheritedTaskSetDisclosure(context))
    return TASK_SET_TOOL_RUNNERS.task_set_item_read!(context, { ...args, content: 'prompt' })
  },
  task_set_control: async (context, input) => {
    const { taskSetId, ...action } = SetId.merge(TaskSetActionSchema).parse(input)
    await controlTaskSetForActor(modelDeps(context), context.actorContext, taskSetId, action)
    return readSet(context, taskSetId)
  },
}

export const runTaskSetTool = async (
  toolName: string, context: BuiltinToolRuntimeContext, input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const runner = TASK_SET_TOOL_RUNNERS[toolName]
  if (!runner) throw new Error('Unknown task-set tool.')
  // Fail closed even on a mutation whose read-back would otherwise discover a missing sink too late.
  taskSetDisclosureObserver(context)
  const output = await runner(context, input)
  return { toolName, inputSummary: toolName, outputPreview: JSON.stringify(output) }
}
