import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import { loadProvisioningContext } from '../../src/control/execution/claims.js'
import {
  ABANDONED_HOST_LOCAL_INSTANCE_ERROR,
  LEASE_EXPIRED_ERROR,
  acknowledgeLease,
  expireExecutionLeases,
} from '../../src/control/execution/leases.js'
import { buildGcloudInstanceName } from '../../src/control/execution/naming.js'
import { persistDerivedProviderInstanceRef } from '../../src/control/execution/persistence.js'
import { runDatabaseTest } from './support.js'

// Plan row 5.2 / audit 5.8: an expired lease used to flip the instance row to
// `failed` and stop, leaving the machine the dead worker provisioned running
// and billing with nothing pointing at it. `expireExecutionLeases` is a global
// sweep — it expires every overdue lease in the database, not just this file's
// — so every assertion below counts only rows keyed to its own seed.

// The sweep takes a bounded batch of the *oldest* expired leases per pass, so
// every lease this file seeds is expired far enough in the past to sort ahead
// of anything another suite leaves lying around in a shared database. A date
// this old is not a fiction the sweep can see: it reads `expiresAt < now` and
// nothing else.
const LONG_EXPIRED = new Date('2020-01-01T00:00:00.000Z')

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
      expiresAt: LONG_EXPIRED,
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

// The crash the whole mechanism exists to catch, driven through the real
// provisioning path instead of a fabricated row.
//
// Every seed above creates its instance already carrying a
// `provider_instance_ref` — a state no production path used to produce, because
// `persistProvisionSuccess` was the only writer of that column and it commits in
// the same transaction that moves the lease to `completed`. So the sweep's
// enqueue could not fire for the one crash it was written for: a worker killed
// after `gcloud compute instances create` returned and before that transaction
// landed left the column NULL, the sweep skipped the enqueue, and the VM billed
// forever.
//
// The three calls below are literally the prefix of
// `allocateExecutionEnvironmentInstance`: claim the instance and issue a lease,
// acknowledge it, record the reference the provider is about to create. The
// worker dying is the *absence* of everything after — no
// `persistProvisionSuccess`, no `markProvisionFailure` — which leaves exactly
// the row a SIGKILL leaves: lease `acknowledged`, instance `provisioning`.
runDatabaseTest(
  'a worker killed between provisioning and persistProvisionSuccess still has its VM reclaimed',
  async () => {
    const prisma = new PrismaClient()
    const projectId = 'nessie-lease-crash'
    const zone = 'europe-west4-a'

    const org = await prisma.organization.create({
      data: { name: `lease-crash ${randomUUID()}` },
    })
    const template = await prisma.executionEnvironmentTemplate.create({
      data: {
        createdByActorId: 'user-seed',
        createdByActorType: 'user',
        launchConfig: { image: 'debian-12', projectId, zone },
        mode: 'vm',
        name: `tpl ${randomUUID()}`,
        organizationId: org.id,
        provider: 'gcloud',
      },
    })
    const instance = await prisma.executionEnvironmentInstance.create({
      data: {
        launchedByActorId: 'user-seed',
        launchedByActorType: 'user',
        organizationId: org.id,
        status: 'pending',
        templateId: template.id,
      },
    })
    const runnerLabelPrefix = `lease-crash-${randomUUID().slice(0, 8)}`
    await prisma.executionRunner.create({
      data: {
        heartbeatAt: new Date(),
        label: `${runnerLabelPrefix}-gcloud`,
        organizationId: org.id,
        provider: 'gcloud',
        status: 'active',
      },
    })

    const seed: Seed = {
      instanceId: instance.id,
      leaseId: '',
      organizationId: org.id,
      runnerId: '',
    }

    try {
      const context = await loadProvisioningContext(prisma, instance.id, runnerLabelPrefix)
      assert.ok(context, 'the instance should have been claimed and leased')
      seed.leaseId = context.leaseId
      seed.runnerId = context.runnerId

      assert.equal(await acknowledgeLease(prisma, context.leaseId), true)
      await persistDerivedProviderInstanceRef(prisma, context)

      // The name is `buildGcloudInstanceName(instance.id)` because the launch
      // config sets no explicit `instanceName` — the same branch
      // `resolveGcloudVmTarget` takes when it builds the `gcloud compute
      // instances create` arguments, which is why the two cannot disagree.
      const expectedRef = `gcloud:vm:${projectId}:${zone}:${buildGcloudInstanceName(instance.id)}`

      // Read, do not assert yet: the enqueue below is the behaviour under test,
      // and asserting the reference here first would fail the test one step
      // early and hide whether the sweep can actually reclaim the machine.
      const beforeCrash = await prisma.executionEnvironmentInstance.findUnique({
        where: { id: instance.id },
      })
      assert.equal(beforeCrash?.status, 'provisioning')

      // ---- the worker is killed here; nothing below ever ran on it ----

      // The 5 min lease TTL elapses with nobody renewing it.
      await prisma.executionLease.update({
        where: { id: context.leaseId },
        data: { expiresAt: LONG_EXPIRED },
      })

      await expireExecutionLeases(prisma)

      assert.equal(
        await countTerminateJobs(prisma, instance.id),
        1,
        'the abandoned VM must be enqueued for termination',
      )
      assert.equal(
        beforeCrash?.providerInstanceRef,
        expectedRef,
        'the row must name the machine before the provider is called',
      )

      const lease = await prisma.executionLease.findUnique({ where: { id: context.leaseId } })
      assert.equal(lease?.status, 'expired')

      const afterSweep = await prisma.executionEnvironmentInstance.findUnique({
        where: { id: instance.id },
      })
      assert.equal(afterSweep?.status, 'failed')
      assert.equal(afterSweep?.errorMessage, LEASE_EXPIRED_ERROR)
      // The terminate job is only useful if the reference survives to the
      // handler, which reads it off the instance row.
      assert.equal(afterSweep?.providerInstanceRef, expectedRef)
    } finally {
      await cleanup(prisma, seed)
      await prisma.$disconnect()
    }
  },
)
