import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  CreateUserStatusBodySchema,
  CreateUserStatusRuleBodySchema,
  CreateUserStatusScheduleBodySchema,
  UpdateUserStatusBodySchema,
  UpdateUserStatusRuleBodySchema,
  UpdateUserStatusScheduleBodySchema,
  UserStatusRecordSchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  clearActiveUserStatus,
  createUserStatus,
  createUserStatusRule,
  createUserStatusSchedule,
  deleteUserStatus,
  deleteUserStatusRule,
  deleteUserStatusSchedule,
  getUserStatus,
  listUserStatuses,
  setActiveUserStatus,
  updateUserStatus,
  updateUserStatusRule,
  updateUserStatusSchedule,
  UserStatusServiceError,
} from '../services/user-statuses.js'
import type { RouteDeps } from './types.js'

type StatusParams = { statusId: string }
type RuleParams = StatusParams & { ruleId: string }
type ScheduleParams = StatusParams & { scheduleId: string }

const sendStatusError = (reply: FastifyReply, error: unknown): boolean => {
  if (error instanceof UserStatusServiceError) {
    sendApiError(reply, error.httpStatus, error.code, error.message)
    return true
  }
  return false
}

export const registerStatusRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  const ownerFromRequest = (request: FastifyRequest, reply: FastifyReply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return null
    if (!requireUserActor(actorContext, reply)) return null
    return {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    }
  }

  app.get('/api/statuses', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const statuses = await listUserStatuses(prisma, owner)
    return createApiResponse(UserStatusRecordSchema.array().parse(statuses))
  })

  app.post('/api/statuses', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const body = parseInput(CreateUserStatusBodySchema, request.body, reply)
    if (!body) return reply

    const status = await createUserStatus(prisma, owner, body)
    return reply.code(201).send(createApiResponse(UserStatusRecordSchema.parse(status)))
  })

  app.delete('/api/statuses/active', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    await clearActiveUserStatus(prisma, owner)
    return createApiResponse({ ok: true })
  })

  app.get('/api/statuses/:statusId', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const { statusId } = request.params as StatusParams
    try {
      const status = await getUserStatus(prisma, owner, statusId)
      return createApiResponse(UserStatusRecordSchema.parse(status))
    } catch (error) {
      if (sendStatusError(reply, error)) return reply
      throw error
    }
  })

  app.patch('/api/statuses/:statusId', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const body = parseInput(UpdateUserStatusBodySchema, request.body, reply)
    if (!body) return reply

    const { statusId } = request.params as StatusParams
    try {
      const status = await updateUserStatus(prisma, owner, statusId, body)
      return createApiResponse(UserStatusRecordSchema.parse(status))
    } catch (error) {
      if (sendStatusError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/statuses/:statusId', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const { statusId } = request.params as StatusParams
    try {
      await deleteUserStatus(prisma, owner, statusId)
      return createApiResponse({ ok: true })
    } catch (error) {
      if (sendStatusError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/statuses/:statusId/activate', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const { statusId } = request.params as StatusParams
    try {
      const status = await setActiveUserStatus(prisma, owner, statusId)
      return createApiResponse(UserStatusRecordSchema.parse(status))
    } catch (error) {
      if (sendStatusError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/statuses/:statusId/schedules', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const body = parseInput(CreateUserStatusScheduleBodySchema, request.body, reply)
    if (!body) return reply

    const { statusId } = request.params as StatusParams
    try {
      const status = await createUserStatusSchedule(prisma, owner, statusId, body)
      return reply.code(201).send(createApiResponse(UserStatusRecordSchema.parse(status)))
    } catch (error) {
      if (sendStatusError(reply, error)) return reply
      throw error
    }
  })

  app.patch('/api/statuses/:statusId/schedules/:scheduleId', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const body = parseInput(UpdateUserStatusScheduleBodySchema, request.body, reply)
    if (!body) return reply

    const { scheduleId, statusId } = request.params as ScheduleParams
    try {
      const status = await updateUserStatusSchedule(prisma, owner, statusId, scheduleId, body)
      return createApiResponse(UserStatusRecordSchema.parse(status))
    } catch (error) {
      if (sendStatusError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/statuses/:statusId/schedules/:scheduleId', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const { scheduleId, statusId } = request.params as ScheduleParams
    try {
      const status = await deleteUserStatusSchedule(prisma, owner, statusId, scheduleId)
      return createApiResponse(UserStatusRecordSchema.parse(status))
    } catch (error) {
      if (sendStatusError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/statuses/:statusId/rules', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const body = parseInput(CreateUserStatusRuleBodySchema, request.body, reply)
    if (!body) return reply

    const { statusId } = request.params as StatusParams
    try {
      const status = await createUserStatusRule(prisma, owner, statusId, body)
      return reply.code(201).send(createApiResponse(UserStatusRecordSchema.parse(status)))
    } catch (error) {
      if (sendStatusError(reply, error)) return reply
      throw error
    }
  })

  app.patch('/api/statuses/:statusId/rules/:ruleId', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const body = parseInput(UpdateUserStatusRuleBodySchema, request.body, reply)
    if (!body) return reply

    const { ruleId, statusId } = request.params as RuleParams
    try {
      const status = await updateUserStatusRule(prisma, owner, statusId, ruleId, body)
      return createApiResponse(UserStatusRecordSchema.parse(status))
    } catch (error) {
      if (sendStatusError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/statuses/:statusId/rules/:ruleId', async (request, reply) => {
    const owner = ownerFromRequest(request, reply)
    if (!owner) return reply

    const { ruleId, statusId } = request.params as RuleParams
    try {
      const status = await deleteUserStatusRule(prisma, owner, statusId, ruleId)
      return createApiResponse(UserStatusRecordSchema.parse(status))
    } catch (error) {
      if (sendStatusError(reply, error)) return reply
      throw error
    }
  })
}
