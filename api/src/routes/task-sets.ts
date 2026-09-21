import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  TaskSetActionSchema, TaskSetCreateSchema, TaskSetItemInputSchema,
  TaskSetItemQuerySchema, TaskSetItemUpdateSchema, TaskSetListQuerySchema, TaskSetUpdateSchema,
} from '@nessie/schemas'
import {
  addTaskSetItemsForActor, controlTaskSetForActor, createTaskSetForActor,
  getTaskSetForActor, listTaskSetItemsForActor, listTaskSetProcessors, listTaskSetsForActor,
  taskSetRecord, taskSetItemRecord, TaskSetError, updateTaskSetForActor, updateTaskSetItemForActor,
  assertTaskSetDisclosure,
} from '@nessie/team-admin'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

const Params = z.object({ id: z.string().uuid() })
const ItemParams = Params.extend({ itemId: z.string().uuid() })

export const registerTaskSetRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const service = { prisma: deps.prisma, modelConfig: deps.config.model, ledgerIdentity: deps.ledgerIdentity }
  const route = (
    method: 'GET' | 'POST' | 'PATCH', url: string,
    handler: Parameters<FastifyInstance['route']>[0]['handler'],
  ): void => { app.route({ method, url, handler, errorHandler: (error, _request, reply) => {
    if (error instanceof TaskSetError) return sendApiError(reply, error.statusCode, error.code, error.message)
    throw error
  } }) }

  route('GET', '/api/task-sets/processors', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor) return reply
    return createApiResponse(await listTaskSetProcessors(service, actor))
  })
  route('GET', '/api/task-sets', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    const query = parseInput(TaskSetListQuerySchema, request.query, reply)
    if (!actor || !query) return reply
    const page = await listTaskSetsForActor(deps.prisma, actor, query)
    return createApiResponse(page.data, page.meta)
  })
  route('POST', '/api/task-sets', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    const input = parseInput(TaskSetCreateSchema, request.body, reply)
    if (!actor || !input) return reply
    return createApiResponse(await createTaskSetForActor(service, actor, input))
  })
  route('GET', '/api/task-sets/:id', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    const params = parseInput(Params, request.params, reply)
    if (!actor || !params) return reply
    return createApiResponse(taskSetRecord(await getTaskSetForActor(deps.prisma, actor, params.id)))
  })
  route('PATCH', '/api/task-sets/:id', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    const params = parseInput(Params, request.params, reply)
    const input = parseInput(TaskSetUpdateSchema, request.body, reply)
    if (!actor || !params || !input) return reply
    return createApiResponse(await updateTaskSetForActor(service, actor, params.id, input))
  })
  route('POST', '/api/task-sets/:id/actions', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    const params = parseInput(Params, request.params, reply)
    const input = parseInput(TaskSetActionSchema, request.body, reply)
    if (!actor || !params || !input) return reply
    return createApiResponse(await controlTaskSetForActor(service, actor, params.id, input))
  })
  route('GET', '/api/task-sets/:id/items', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    const params = parseInput(Params, request.params, reply)
    const input = parseInput(TaskSetItemQuerySchema, request.query, reply)
    if (!actor || !params || !input) return reply
    const page = await listTaskSetItemsForActor(deps.prisma, actor, params.id, input)
    return createApiResponse(page.data, page.meta)
  })
  route('POST', '/api/task-sets/:id/items', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    const params = parseInput(Params, request.params, reply)
    const input = parseInput(z.object({ items: z.array(TaskSetItemInputSchema).max(500) }), request.body, reply)
    if (!actor || !params || !input) return reply
    return createApiResponse(await addTaskSetItemsForActor(deps.prisma, actor, params.id, input.items))
  })
  route('GET', '/api/task-sets/:id/items/:itemId', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    const params = parseInput(ItemParams, request.params, reply)
    if (!actor || !params) return reply
    await getTaskSetForActor(deps.prisma, actor, params.id)
    const item = await deps.prisma.taskSetItem.findFirst({ where: { id: params.itemId, taskSetId: params.id } })
    if (!item) throw new TaskSetError('TASK_SET_ITEM_NOT_FOUND', 'Task item not found.', 404)
    await assertTaskSetDisclosure(deps.prisma, actor, item.resultDisclosure ?? item.disclosure)
    return createApiResponse(taskSetItemRecord(item))
  })
  route('PATCH', '/api/task-sets/:id/items/:itemId', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    const params = parseInput(ItemParams, request.params, reply)
    const input = parseInput(TaskSetItemUpdateSchema, request.body, reply)
    if (!actor || !params || !input) return reply
    return createApiResponse(await updateTaskSetItemForActor(deps.prisma, actor, params.id, params.itemId, input))
  })
}
