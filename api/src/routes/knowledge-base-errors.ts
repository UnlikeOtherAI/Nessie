import type { FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { isKnowledgeConflictError } from '@nessie/knowledge'
import { sendApiError } from '../lib/api.js'

type KnowledgeMutationErrorInput = {
  code: string
  message: string
  statusCode: number
}

const isPrismaUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

const isPrismaMutationError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError ||
  error instanceof Prisma.PrismaClientUnknownRequestError ||
  error instanceof Prisma.PrismaClientValidationError

export const sendKnowledgeMutationError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  input: KnowledgeMutationErrorInput,
) => {
  if (isKnowledgeConflictError(error)) {
    request.log.warn({ err: error }, 'Knowledge base mutation conflict')
    return sendApiError(reply, 409, 'KNOWLEDGE_MUTATION_CONFLICT', error.message)
  }
  if (isPrismaUniqueConstraintError(error)) {
    request.log.warn({ err: error }, 'Knowledge base unique constraint conflict')
    return sendApiError(
      reply,
      409,
      'KNOWLEDGE_MUTATION_CONFLICT',
      'Knowledge base mutation conflict',
    )
  }
  if (isPrismaMutationError(error)) {
    request.log.error({ err: error }, 'Knowledge base Prisma mutation failed')
    return sendApiError(reply, input.statusCode, input.code, input.message)
  }
  request.log.warn({ err: error }, 'Knowledge base mutation rejected')
  return sendApiError(reply, input.statusCode, input.code, input.message)
}
