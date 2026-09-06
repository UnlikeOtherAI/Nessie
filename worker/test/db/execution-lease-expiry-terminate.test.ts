import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import {
  ABANDONED_HOST_LOCAL_INSTANCE_ERROR,
  LEASE_EXPIRED_ERROR,
  expireExecutionLeases,
} from '../../src/control/execution/leases.js'
import { runDatabaseTest } from './support.js'

// Plan row 5.2 / audit 5.8: an expired lease used to flip the instance row to
// `failed` and stop, leaving the machine the dead worker provisioned running
// and billing with nothing pointing at it. `expireExecutionLeases` is a global
// sweep — it expires every overdue lease in the database, not just this file's
// — so every assertion below counts only rows keyed to its own seed.

type Seed = {
  instanceId: string
  leaseId: string
  organizationId: string
  runnerId: string
}

const seedExpiredLease = async (
  prisma: PrismaClient,
  input: {
    provider: 'docker' | 'gcloud'
    providerInstanceRef: string | null
  },
): Promise<Seed> => {
  const org = await prisma.organization.create({
    data: { name: `lease-expiry ${randomUUID()}` },
  })
  const template = await prisma.executionEnvironmentTemplate.create({
    data: {
      createdByActorId: 'user-seed',
      createdByActorType: 'user',
      mode: input.provider === 'docker' ? 'container' : 'vm',
      name: `tpl ${randomUUID()}`,
      organizationId: org.id,
      provider: input.provider,
    },
  })
  const instance = await prisma.executionEnvironmentInstance.create({
    data: {
      launchedByActorId: 'user-seed',
      launchedByActorType: 'user',
      organizationId: org.id,
      providerInstanceRef: input.providerInstanceRef,
      startedAt: new Date(),
      status: 'provisioning',
      templateId: template.id,
    },
  })
  const runner = await prisma.executionRunner.create({
    data: {
      heartbeatAt: new Date(Date.now() - 10 * 60_000),
      label: `lease-expiry-${randomUUID()}`,
      organizationId: org.id,
      provider: input.provider,
      status: 'active',
    },
  })
  const lease = await prisma.executionLease.create({
    data: {
      expiresAt: new Date(Date.now() - 60_000),
      instanceId: instance.id,
      leaseToken: randomUUID(),
      runnerId: runner.id,
      status: 'acknowledged',
    },
  })

  return {
    instanceId: instance.id,
    leaseId: lease.id,
    organizationId: org.id,
    runnerId: runner.id,
  }
}

// Scoped by this seed's instance id, never by the topic alone: a topic-wide
// delete would take another suite's terminate job with it.
const countTerminateJobs = async (prisma: PrismaClient, instanceId: string): Promise<number> => {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count
    FROM queue_jobs
    WHERE topic = 'execution.environment.terminate'
      AND payload->>'instanceId' = ${instanceId}
  `)
  return Number(rows[0]?.count ?? 0)
}

const cleanup = async (prisma: PrismaClient, seed: Seed): Promise<void> => {
  await prisma
    .$executeRaw(
      Prisma.sql`
        DELETE FROM queue_jobs
        WHERE topic = 'execution.environment.terminate'
          AND payload->>'instanceId' = ${seed.instanceId}
      `,
    )
    .catch(() => undefined)
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

runDatabaseTest(
  'an expiring lease on a gcloud instance with a provider ref enqueues exactly one termination job',
  async () => {
    const prisma = new PrismaClient()
    const seed = await seedExpiredLease(prisma, {
      provider: 'gcloud',
      providerInstanceRef: `gcloud:vm:proj:europe-west4-a:nessie-${randomUUID().slice(0, 8)}`,
    })

    try {
      await expireExecutionLeases(prisma)

      assert.equal(await countTerminateJobs(prisma, seed.instanceId), 1)

      const job = await prisma.$queryRaw<{ idempotency_key: string; payload: unknown }[]>(
        Prisma.sql`
          SELECT idempotency_key, payload
          FROM queue_jobs
          WHERE topic = 'execution.environment.terminate'
            AND payload->>'instanceId' = ${seed.instanceId}
        `,
      )
      assert.equal(
        job[0]?.idempotency_key,
        `execution-environment:terminate:lease-expired:${seed.instanceId}`,
      )

      const lease = await prisma.executionLease.findUnique({ where: { id: seed.leaseId } })
      assert.equal(lease?.status, 'expired')

      const instance = await prisma.executionEnvironmentInstance.findUnique({
        where: { id: seed.instanceId },
      })
      assert.equal(instance?.status, 'failed')
      assert.equal(instance?.errorMessage, LEASE_EXPIRED_ERROR)
    } finally {
      await cleanup(prisma, seed)
      await prisma.$disconnect()
    }
  },
)

runDatabaseTest('two sweepers racing the same expired lease enqueue one job between them', async () => {
  const prisma = new PrismaClient()
  const other = new PrismaClient()
  const seed = await seedExpiredLease(prisma, {
    provider: 'gcloud',
    providerInstanceRef: `gcloud:function:proj:europe-west4:job-${randomUUID().slice(0, 8)}`,
  })

  try {
    await Promise.all([expireExecutionLeases(prisma), expireExecutionLeases(other)])

    assert.equal(await countTerminateJobs(prisma, seed.instanceId), 1)
  } finally {
    await cleanup(prisma, seed)
    await other.$disconnect()
    await prisma.$disconnect()
  }
})

runDatabaseTest('an expiring lease on an instance with no provider ref enqueues nothing', async () => {
  const prisma = new PrismaClient()
  const seed = await seedExpiredLease(prisma, {
    provider: 'gcloud',
    providerInstanceRef: null,
  })

  try {
    await expireExecutionLeases(prisma)

    assert.equal(await countTerminateJobs(prisma, seed.instanceId), 0)

    const instance = await prisma.executionEnvironmentInstance.findUnique({
      where: { id: seed.instanceId },
    })
    assert.equal(instance?.status, 'failed')
    assert.equal(instance?.errorMessage, LEASE_EXPIRED_ERROR)
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

// The host-affinity decision (audit 8.2). A docker ref names a container on the
// dead runner's own daemon, and queue jobs are not host-routed, so a terminate
// enqueued here would be claimed by some other replica, hit `No such
// container`, and be persisted as `terminated` — a lie. The sweep enqueues
// nothing and records the abandonment instead.
runDatabaseTest(
  'an orphaned docker instance enqueues no termination and is recorded abandoned, never terminated',
  async () => {
    const prisma = new PrismaClient()
    const containerId = `container-${randomUUID().slice(0, 12)}`
    const seed = await seedExpiredLease(prisma, {
      provider: 'docker',
      providerInstanceRef: containerId,
    })

    try {
      await expireExecutionLeases(prisma)

      assert.equal(await countTerminateJobs(prisma, seed.instanceId), 0)

      const instance = await prisma.executionEnvironmentInstance.findUnique({
        where: { id: seed.instanceId },
      })
      assert.notEqual(instance?.status, 'terminated')
      assert.equal(instance?.status, 'failed')
      assert.equal(
        instance?.errorMessage,
        `${ABANDONED_HOST_LOCAL_INSTANCE_ERROR}:docker:${containerId}`,
      )
      assert.equal(instance?.terminatedAt, null)
      assert.equal(instance?.providerInstanceRef, containerId)
    } finally {
      await cleanup(prisma, seed)
      await prisma.$disconnect()
    }
  },
)
