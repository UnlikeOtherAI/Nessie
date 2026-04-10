import { Prisma, type PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  ExecutionEnvironmentTerminateJobPayload,
} from '@nessie/schemas'
import type { ExecutionEnvironmentInstanceRecord } from '../contracts.js'
import { enqueueQueueJob } from '../queue/pgqueue.js'
import { mapExecutionEnvironmentInstance } from './execution-environments.js'

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export const requestExecutionEnvironmentTermination = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    instanceId: string
  },
): Promise<ExecutionEnvironmentInstanceRecord | null> => {
  const instance = await prisma.$transaction(async (tx) => {
    const existing = await tx.executionEnvironmentInstance.findFirst({
      where: {
        id: input.instanceId,
        organizationId: actorContext.tenant.organizationId,
      },
    })
    if (!existing) {
      return null
    }

    if (existing.status === 'terminated') {
      return existing
    }

    const updated = await tx.executionEnvironmentInstance.update({
      where: { id: existing.id },
      data: {
        metadata: {
          ...asObject(existing.metadata),
          terminationRequestedAt: new Date().toISOString(),
          terminationRequestedBy: {
            actorId: actorContext.actor.actorId,
            actorType: actorContext.actor.actorType,
          },
        } as Prisma.InputJsonValue,
      },
    })

    const payload: ExecutionEnvironmentTerminateJobPayload = {
      actorContext,
      instanceId: existing.id,
    }
    await enqueueQueueJob(tx, {
      idempotencyKey: `execution-environment:terminate:${existing.id}`,
      payload,
      topic: 'execution.environment.terminate',
    })

    return updated
  })

  return instance ? mapExecutionEnvironmentInstance(instance) : null
}
