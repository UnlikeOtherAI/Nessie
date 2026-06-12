import { randomUUID } from 'node:crypto'
import { type PrismaClient } from '@prisma/client'
import { DEFAULT_LEASE_TTL_MS, DEFAULT_RUNNER_STALE_MS, selectRunner } from './leases.js'
import { mergeMetadata } from './metadata.js'
import type { ProvisioningContext, TerminationContext } from './types.js'

export const loadProvisioningContext = async (
  prisma: PrismaClient,
  instanceId: string,
  runnerLabelPrefix: string,
): Promise<ProvisioningContext | null> => {
  const now = new Date()

  return prisma.$transaction(async (tx) => {
    // Serialize concurrent provisioners of the same instance. Mirrors the
    // advisory-lock idiom in api/src/services/resource-locks.ts: the lock is
    // held for the duration of the transaction, so the read-check-claim below
    // is atomic — a second worker blocks here, then sees `status` already off
    // `pending`/`provisioning` and bails (returns null) without issuing a
    // duplicate lease.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext('execution_environment_instance'),
        hashtext(${instanceId})
      )
    `

    const instance = await tx.executionEnvironmentInstance.findUnique({
      where: { id: instanceId },
      include: {
        template: {
          select: {
            id: true,
            image: true,
            launchConfig: true,
            mode: true,
            pricingConfig: true,
            provider: true,
          },
        },
      },
    })
    if (!instance) {
      return null
    }
    if (!['pending', 'provisioning'].includes(instance.status)) {
      return null
    }

    const runner = await selectRunner(tx, {
      organizationId: instance.organizationId,
      provider: instance.template.provider,
      runnerLabelPrefix,
    })
    if (!runner) {
      const remoteRunner = await tx.executionRunner.findFirst({
        where: {
          provider: instance.template.provider,
          status: 'active',
          heartbeatAt: {
            gt: new Date(Date.now() - DEFAULT_RUNNER_STALE_MS),
          },
          OR: [{ organizationId: instance.organizationId }, { organizationId: null }],
        },
        select: { id: true },
      })

      if (remoteRunner) {
        throw new Error('EXECUTION_RUNNER_NOT_LOCAL')
      }

      await tx.executionEnvironmentInstance.update({
        where: { id: instance.id },
        data: {
          status: 'failed',
          errorMessage: `NO_${instance.template.provider.toUpperCase()}_RUNNER`,
          startedAt: instance.startedAt ?? now,
          lastHeartbeatAt: now,
        },
      })
      return null
    }

    await tx.executionEnvironmentInstance.update({
      where: { id: instance.id },
      data: {
        status: 'provisioning',
        startedAt: instance.startedAt ?? now,
        lastHeartbeatAt: now,
        metadata: mergeMetadata(instance.metadata, {
          runnerId: runner.id,
          runnerLabel: runner.label,
        }),
      },
    })

    const lease = await tx.executionLease.create({
      data: {
        expiresAt: new Date(now.getTime() + DEFAULT_LEASE_TTL_MS),
        instanceId: instance.id,
        leaseToken: randomUUID(),
        runnerId: runner.id,
        status: 'issued',
      },
    })

    return {
      instance,
      leaseId: lease.id,
      runnerId: runner.id,
    }
  })
}

export const loadTerminationContext = async (
  prisma: PrismaClient,
  instanceId: string,
): Promise<TerminationContext | null> =>
  prisma.executionEnvironmentInstance
    .findUnique({
      where: { id: instanceId },
      include: {
        template: {
          select: {
            id: true,
            image: true,
            launchConfig: true,
            mode: true,
            pricingConfig: true,
            provider: true,
          },
        },
      },
    })
    .then((instance) => (instance ? { instance } : null))
