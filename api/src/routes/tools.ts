import type { FastifyInstance } from 'fastify'

import {
  CreateToolRegistryEntryBodySchema,
  ToolDescriptorSchema,
  ToolRegistryEntrySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  listAvailableTools,
  listToolRegistryEntries,
  registerToolRegistryEntry,
} from '../services/tools.js'
import type { RouteDeps } from './types.js'

export const registerToolRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  app.get('/api/tools', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const tools = await listAvailableTools(prisma, actorContext.tenant.organizationId)
    return createApiResponse(ToolDescriptorSchema.array().parse(tools))
  })

  app.get('/api/tools/registry', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const entries = await listToolRegistryEntries(prisma, actorContext.tenant.organizationId)
    return createApiResponse(ToolRegistryEntrySchema.array().parse(entries))
  })

  app.post('/api/tools/registry', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateToolRegistryEntryBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    let entry
    try {
      entry = await registerToolRegistryEntry(
        prisma,
        actorContext.tenant.organizationId,
        body,
      )
    }
    catch (error) {
      if (error instanceof Error && error.message === 'BUILTIN_TOOL_ID_RESERVED') {
        sendApiError(
          reply,
          409,
          'BUILTIN_TOOL_ID_RESERVED',
          'Built-in tool ids are reserved and cannot be overridden by organization-local entries',
        )
        return reply
      }
      throw error
    }
    return reply.code(201).send(createApiResponse(ToolRegistryEntrySchema.parse(entry)))
  })
}
