import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  AgentTodoAgentParamsSchema,
  AgentTodoParamsSchema,
  AgentTodoRecordSchema,
  AgentTodoStepParamsSchema,
  AgentTodoTemplateParamsSchema,
  AgentTodoTemplateRecordSchema,
  CreateAgentTodoBodySchema,
  CreateAgentTodoTemplateBodySchema,
  EmptyAgentTodoBodySchema,
  ListAgentTodosQuerySchema,
  ListAgentTodoTemplatesQuerySchema,
  UpdateAgentTodoStepBodySchema,
  UpdateAgentTodoTemplateBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  AGENT_TODO_ERROR_CODES,
  AgentTodoError,
  archiveAgentTodoTemplate,
  cancelAgentTodo,
  createAgentTodoFromTemplate,
  createAgentTodoTemplate,
  createStandaloneAgentTodo,
  getAgentTodo,
  listAgentTodoTemplates,
  listAgentTodos,
  updateAgentTodoStep,
  updateAgentTodoTemplate,
} from '../services/agent-todos.js'
import type { RouteDeps } from './types.js'

type AvailableAgent = {
  agentId: string
  organizationId: string
  ownerUserId: string | null
}

const loadAvailableAgent = async (
  deps: RouteDeps,
  actorContext: AuthorizedActionContext,
  agentId: string,
  reply: FastifyReply,
): Promise<AvailableAgent | null> => {
  // To-dos deliberately inherit the one agent entitlement predicate. When the
  // visibility proposal changes that predicate, every route here changes with
  // it and no parallel to-do visibility rule can drift (plan §4).
  if (!(await deps.isAgentAccessibleToActor(actorContext, agentId))) {
    sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
    return null
  }

  const agent = await deps.prisma.agent.findFirst({
    select: { id: true, organizationId: true, ownerUserId: true, todosEnabled: true },
    where: {
      id: agentId,
      organizationId: actorContext.tenant.organizationId,
    },
  })
  if (!agent) {
    sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
    return null
  }
  if (!agent.todosEnabled) {
    sendApiError(
      reply,
      409,
      'AGENT_TODOS_DISABLED',
      'To-dos are disabled for this agent.',
    )
    return null
  }
  return {
    agentId: agent.id,
    organizationId: actorContext.tenant.organizationId,
    ownerUserId: agent.ownerUserId,
  }
}

const sendAgentTodoError = (reply: FastifyReply, error: unknown): boolean => {
  if (!(error instanceof AgentTodoError)) return false
  const status = error.code === AGENT_TODO_ERROR_CODES.NOT_FOUND
    || error.code === AGENT_TODO_ERROR_CODES.STEP_NOT_FOUND
    || error.code === AGENT_TODO_ERROR_CODES.TEMPLATE_NOT_FOUND
    ? 404
    : 409
  sendApiError(reply, status, error.code, error.message)
  return true
}

const requireInstanceActor = async (
  deps: RouteDeps,
  actorContext: AuthorizedActionContext,
  agent: AvailableAgent,
  todoId: string,
  reply: FastifyReply,
): Promise<boolean> => {
  const todo = await deps.prisma.agentTodo.findFirst({
    select: { createdByUserId: true },
    where: {
      agentId: agent.agentId,
      id: todoId,
      organizationId: agent.organizationId,
    },
  })
  if (!todo) {
    sendApiError(reply, 404, AGENT_TODO_ERROR_CODES.NOT_FOUND, 'To-do not found.')
    return false
  }

  const actorId = actorContext.actor.actorId
  const allowed = actorContext.actor.roles?.includes('owner') === true
    || todo.createdByUserId === actorId
    || agent.ownerUserId === actorId
  if (!allowed) {
    sendApiError(
      reply,
      403,
      'AGENT_TODO_ACTION_FORBIDDEN',
      'Only the to-do creator, an organization owner, or the agent steward can change it.',
    )
    return false
  }
  return true
}

export const registerAgentTodoRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  app.get('/api/agents/:agentId/todo-templates', async (request, reply) => {
    const actorContext = deps.requireActorContext(request, reply)
    if (!actorContext) return reply
    const params = parseInput(
      AgentTodoAgentParamsSchema,
      request.params,
      reply,
      'params',
    )
    if (!params) return reply
    const agent = await loadAvailableAgent(deps, actorContext, params.agentId, reply)
    if (!agent) return reply
    const query = parseInput(
      ListAgentTodoTemplatesQuerySchema,
      request.query ?? {},
      reply,
      'query',
    )
    if (!query) return reply

    const templates = await listAgentTodoTemplates(deps.prisma, {
      ...agent,
      includeArchived: query.includeArchived === 'true',
    })
    return createApiResponse(AgentTodoTemplateRecordSchema.array().parse(templates))
  })

  app.post('/api/agents/:agentId/todo-templates', async (request, reply) => {
    const actorContext = deps.requireActorContext(request, reply)
    if (!actorContext) return reply
    const params = parseInput(AgentTodoAgentParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const agent = await loadAvailableAgent(deps, actorContext, params.agentId, reply)
    if (!agent || !deps.requireOwner(actorContext, reply)) return reply
    const body = parseInput(CreateAgentTodoTemplateBodySchema, request.body, reply)
    if (!body) return reply

    const template = await createAgentTodoTemplate(deps.prisma, {
      ...agent,
      ...body,
      authorType: 'user',
      createdByUserId: actorContext.actor.actorId,
      proposedByRunId: null,
      status: body.status ?? 'draft',
    })
    return reply.code(201).send(
      createApiResponse(AgentTodoTemplateRecordSchema.parse(template)),
    )
  })

  app.put(
    '/api/agents/:agentId/todo-templates/:templateId',
    async (request, reply) => {
      const actorContext = deps.requireActorContext(request, reply)
      if (!actorContext) return reply
      const params = parseInput(
        AgentTodoTemplateParamsSchema,
        request.params,
        reply,
        'params',
      )
      if (!params) return reply
      const agent = await loadAvailableAgent(deps, actorContext, params.agentId, reply)
      if (!agent || !deps.requireOwner(actorContext, reply)) return reply
      const body = parseInput(UpdateAgentTodoTemplateBodySchema, request.body, reply)
      if (!body) return reply

      let template
      try {
        template = await updateAgentTodoTemplate(deps.prisma, {
          ...agent,
          ...body,
          createdByUserId: actorContext.actor.actorId,
          templateId: params.templateId,
        })
      } catch (error) {
        if (sendAgentTodoError(reply, error)) return reply
        throw error
      }
      if (!template) {
        sendApiError(
          reply,
          404,
          AGENT_TODO_ERROR_CODES.TEMPLATE_NOT_FOUND,
          'To-do template not found.',
        )
        return reply
      }
      return createApiResponse(AgentTodoTemplateRecordSchema.parse(template))
    },
  )

  app.post(
    '/api/agents/:agentId/todo-templates/:templateId/archive',
    async (request, reply) => {
      const actorContext = deps.requireActorContext(request, reply)
      if (!actorContext) return reply
      const params = parseInput(
        AgentTodoTemplateParamsSchema,
        request.params,
        reply,
        'params',
      )
      if (!params) return reply
      const agent = await loadAvailableAgent(deps, actorContext, params.agentId, reply)
      if (!agent || !deps.requireOwner(actorContext, reply)) return reply
      if (!parseInput(EmptyAgentTodoBodySchema, request.body ?? {}, reply)) return reply

      const template = await archiveAgentTodoTemplate(deps.prisma, {
        ...agent,
        templateId: params.templateId,
      })
      if (!template) {
        sendApiError(
          reply,
          404,
          AGENT_TODO_ERROR_CODES.TEMPLATE_NOT_FOUND,
          'To-do template not found.',
        )
        return reply
      }
      return createApiResponse(AgentTodoTemplateRecordSchema.parse(template))
    },
  )

  app.get('/api/agents/:agentId/todos', async (request, reply) => {
    const actorContext = deps.requireActorContext(request, reply)
    if (!actorContext) return reply
    const params = parseInput(AgentTodoAgentParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const agent = await loadAvailableAgent(deps, actorContext, params.agentId, reply)
    if (!agent) return reply
    const query = parseInput(
      ListAgentTodosQuerySchema,
      request.query ?? {},
      reply,
      'query',
    )
    if (!query) return reply

    const todos = await listAgentTodos(deps.prisma, {
      ...agent,
      status: query.status,
      visibility: deps.createAgentVisibilityScope(actorContext),
    })
    return createApiResponse(AgentTodoRecordSchema.array().parse(todos))
  })

  app.post('/api/agents/:agentId/todos', async (request, reply) => {
    const actorContext = deps.requireActorContext(request, reply)
    if (!actorContext) return reply
    const params = parseInput(AgentTodoAgentParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const agent = await loadAvailableAgent(deps, actorContext, params.agentId, reply)
    if (!agent) return reply
    const body = parseInput(CreateAgentTodoBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const todo = 'templateId' in body
        ? await createAgentTodoFromTemplate(deps.prisma, {
            ...agent,
            createdByUserId: actorContext.actor.actorId,
            templateId: body.templateId,
          })
        : await createStandaloneAgentTodo(deps.prisma, {
            ...agent,
            createdByUserId: actorContext.actor.actorId,
            steps: body.steps,
            title: body.title,
          })
      return reply.code(201).send(createApiResponse(AgentTodoRecordSchema.parse(todo)))
    } catch (error) {
      if (sendAgentTodoError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/agents/:agentId/todos/:todoId', async (request, reply) => {
    const actorContext = deps.requireActorContext(request, reply)
    if (!actorContext) return reply
    const params = parseInput(AgentTodoParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const agent = await loadAvailableAgent(deps, actorContext, params.agentId, reply)
    if (!agent) return reply

    const todo = await getAgentTodo(deps.prisma, {
      ...agent,
      todoId: params.todoId,
      visibility: deps.createAgentVisibilityScope(actorContext),
    })
    if (!todo) {
      sendApiError(reply, 404, AGENT_TODO_ERROR_CODES.NOT_FOUND, 'To-do not found.')
      return reply
    }
    return createApiResponse(AgentTodoRecordSchema.parse(todo))
  })

  app.post(
    '/api/agents/:agentId/todos/:todoId/steps/:stepKey',
    async (request, reply) => {
      const actorContext = deps.requireActorContext(request, reply)
      if (!actorContext) return reply
      const params = parseInput(AgentTodoStepParamsSchema, request.params, reply, 'params')
      if (!params) return reply
      const agent = await loadAvailableAgent(deps, actorContext, params.agentId, reply)
      if (!agent) return reply
      if (!(await requireInstanceActor(
        deps,
        actorContext,
        agent,
        params.todoId,
        reply,
      ))) return reply
      const body = parseInput(UpdateAgentTodoStepBodySchema, request.body, reply)
      if (!body) return reply

      try {
        const todo = await updateAgentTodoStep(deps.prisma, {
          ...agent,
          ...body,
          actor: { id: actorContext.actor.actorId, type: 'user' },
          key: params.stepKey,
          todoId: params.todoId,
          visibility: deps.createAgentVisibilityScope(actorContext),
        })
        return createApiResponse(AgentTodoRecordSchema.parse(todo))
      } catch (error) {
        if (sendAgentTodoError(reply, error)) return reply
        throw error
      }
    },
  )

  app.post('/api/agents/:agentId/todos/:todoId/cancel', async (request, reply) => {
    const actorContext = deps.requireActorContext(request, reply)
    if (!actorContext) return reply
    const params = parseInput(AgentTodoParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const agent = await loadAvailableAgent(deps, actorContext, params.agentId, reply)
    if (!agent) return reply
    if (!(await requireInstanceActor(
      deps,
      actorContext,
      agent,
      params.todoId,
      reply,
    ))) return reply
    if (!parseInput(EmptyAgentTodoBodySchema, request.body ?? {}, reply)) return reply

    try {
      const todo = await cancelAgentTodo(deps.prisma, {
        ...agent,
        todoId: params.todoId,
        visibility: deps.createAgentVisibilityScope(actorContext),
      })
      return createApiResponse(AgentTodoRecordSchema.parse(todo))
    } catch (error) {
      if (sendAgentTodoError(reply, error)) return reply
      throw error
    }
  })
}
