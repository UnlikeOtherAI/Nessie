import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'

const DEFAULT_LEASE_TTL_MS = 5 * 60_000

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const parseNonNegativeNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

const computeUsageCost = (input: {
  pricingConfig: unknown
  quantity: number
}): { costAmount?: number; currency?: string; unitPrice?: number } => {
  const pricing = asObject(input.pricingConfig)
  const unitPrice = parseNonNegativeNumber(pricing['unitPrice'])
  const currency = typeof pricing['currency'] === 'string' ? pricing['currency'] : undefined

  if (unitPrice === null) {
    return { currency }
  }

  return {
    unitPrice,
    costAmount: Number((unitPrice * input.quantity).toFixed(6)),
    currency,
  }
}

export const registerExecutionRunners = async (
  prisma: PrismaClient,
  input: {
    labelPrefix: string
    organizationId?: string | null
  },
): Promise<void> => {
  const now = new Date()
  for (const provider of ['docker', 'gcloud'] as const) {
    const label = `${input.labelPrefix}-${provider}`
    await prisma.executionRunner.upsert({
      where: {
        provider_label: {
          provider,
          label,
        },
      },
      create: {
        organizationId: input.organizationId ?? null,
        provider,
        label,
        capabilities: {
          mode: provider === 'docker' ? ['container'] : ['vm', 'function'],
          source: 'worker',
        } as Prisma.InputJsonValue,
        status: 'active',
        heartbeatAt: now,
        metadata: {
          managedBy: 'worker',
        } as Prisma.InputJsonValue,
      },
      update: {
        organizationId: input.organizationId ?? null,
        status: 'active',
        heartbeatAt: now,
        metadata: {
          managedBy: 'worker',
        } as Prisma.InputJsonValue,
      },
    })
  }
}

export const allocateExecutionEnvironmentInstance = async (
  prisma: PrismaClient,
  instanceId: string,
): Promise<boolean> => {
  const now = new Date()

  const allocated = await prisma.$transaction(async (tx) => {
    const instance = await tx.executionEnvironmentInstance.findUnique({
      where: { id: instanceId },
      include: {
        template: {
          select: {
            id: true,
            mode: true,
            pricingConfig: true,
            provider: true,
          },
        },
      },
    })
    if (!instance) {
      return false
    }
    if (!['pending', 'provisioning'].includes(instance.status)) {
      return instance.status === 'ready'
    }

    const runner = await tx.executionRunner.findFirst({
      where: {
        provider: instance.template.provider,
        status: 'active',
        OR: [{ organizationId: instance.organizationId }, { organizationId: null }],
      },
      orderBy: [{ organizationId: 'desc' }, { updatedAt: 'desc' }],
    })
    if (!runner) {
      await tx.executionEnvironmentInstance.update({
        where: { id: instance.id },
        data: {
          status: 'failed',
          errorMessage: `NO_${instance.template.provider.toUpperCase()}_RUNNER`,
          startedAt: now,
        },
      })
      return false
    }

    await tx.executionEnvironmentInstance.update({
      where: { id: instance.id },
      data: {
        status: 'provisioning',
        startedAt: instance.startedAt ?? now,
      },
    })

    const lease = await tx.executionLease.create({
      data: {
        instanceId: instance.id,
        runnerId: runner.id,
        status: 'issued',
        leaseToken: randomUUID(),
        expiresAt: new Date(now.getTime() + DEFAULT_LEASE_TTL_MS),
      },
    })

    await tx.executionEnvironmentInstance.update({
      where: { id: instance.id },
      data: {
        status: 'ready',
        readyAt: now,
        lastHeartbeatAt: now,
        providerInstanceRef: `${instance.template.provider}:${instance.template.mode}:${instance.id}`,
        metadata: {
          leaseId: lease.id,
          runnerId: runner.id,
        } as Prisma.InputJsonValue,
      },
    })

    const pricing = computeUsageCost({
      pricingConfig: instance.template.pricingConfig,
      quantity: 1,
    })

    await tx.executionUsageLedger.create({
      data: {
        instanceId: instance.id,
        templateId: instance.template.id,
        organizationId: instance.organizationId,
        projectId: instance.projectId,
        teamId: instance.teamId,
        channelId: instance.channelId,
        workflowRunId: instance.workflowRunId,
        workflowStepRunId: instance.workflowStepRunId,
        runId: instance.runId,
        agentId: instance.agentId,
        actorType: instance.launchedByActorType,
        actorId: instance.launchedByActorId,
        meterType: 'allocation',
        quantity: 1,
        unitPrice: pricing.unitPrice,
        costAmount: pricing.costAmount,
        currency: pricing.currency,
        metadata: {
          provider: instance.template.provider,
          runnerId: runner.id,
        } as Prisma.InputJsonValue,
      },
    })

    return true
  })

  return allocated
}
