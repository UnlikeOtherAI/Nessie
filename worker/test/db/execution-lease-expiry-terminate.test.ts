import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import {
  loadProvisioningContext,
  loadTerminationContext,
} from '../../src/control/execution/claims.js'
import { terminateGcloud } from '../../src/control/execution/gcloud-provider.js'
import {
  LEASE_EXPIRED_ERROR,
  acknowledgeLease,
  expireExecutionLeases,
} from '../../src/control/execution/leases.js'
import { buildGcloudInstanceName } from '../../src/control/execution/naming.js'
import {
  markProvisionFailure,
  persistDerivedProviderInstanceRef,
} from '../../src/control/execution/persistence.js'
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
    expiresAt?: Date
    instanceStatus?: 'provisioning' | 'ready'
    leaseStatus?: 'acknowledged' | 'issued'
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
      status: input.instanceStatus ?? 'provisioning',
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
      expiresAt: input.expiresAt ?? LONG_EXPIRED,
      instanceId: instance.id,
      leaseToken: randomUUID(),
      runnerId: runner.id,
      status: input.leaseStatus ?? 'acknowledged',
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
// container`, and be persisted as `terminated` — a lie.
//
// The row this seeds is one production cannot produce, and that is deliberate:
// docker derives nothing before provisioning, and `persistProvisionSuccess`
// writes its container id in the same transaction that completes the lease, so
// no live lease ever sits beside a docker reference. The host-independence test
// is a guard for the day a host-local provider does name its resource early,
// and a guard nothing exercises is a guard that quietly stops working — so this
// fabricates the state and pins the refusal. What it must NOT do is pin a
// recovery: an earlier version of this branch wrote a distinct
// `…ABANDONED_HOST_LOCAL…` message claiming the container was named for an
// operator to reap. Nothing automatic reclaims it; the row keeps the ordinary
// expiry message and the container is found by its `nessie.instance-id` label on
// the runner's own host.
runDatabaseTest(
  'a docker instance is never enqueued for termination, even holding a reference',
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
      assert.equal(instance?.errorMessage, LEASE_EXPIRED_ERROR)
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

// ---------------------------------------------------------------------------
// A template plus a local runner, so the tests below can drive the real
// provisioning path (claim, lease, derive) instead of fabricating rows. Several
// instances can be launched from one template, which is the whole point of the
// pinned-name case.
// ---------------------------------------------------------------------------

type Fleet = {
  organizationId: string
  runnerLabelPrefix: string
  templateId: string
}

const seedGcloudFleet = async (
  prisma: PrismaClient,
  launchConfig: Record<string, unknown>,
): Promise<Fleet> => {
  const org = await prisma.organization.create({
    data: { name: `lease-fleet ${randomUUID()}` },
  })
  const template = await prisma.executionEnvironmentTemplate.create({
    data: {
      createdByActorId: 'user-seed',
      createdByActorType: 'user',
      launchConfig: launchConfig as Prisma.InputJsonValue,
      mode: 'vm',
      name: `tpl ${randomUUID()}`,
      organizationId: org.id,
      provider: 'gcloud',
    },
  })
  const runnerLabelPrefix = `lease-fleet-${randomUUID().slice(0, 8)}`
  await prisma.executionRunner.create({
    data: {
      heartbeatAt: new Date(),
      label: `${runnerLabelPrefix}-gcloud`,
      organizationId: org.id,
      provider: 'gcloud',
      status: 'active',
    },
  })

  return { organizationId: org.id, runnerLabelPrefix, templateId: template.id }
}

const launchInstance = async (prisma: PrismaClient, fleet: Fleet): Promise<string> => {
  const instance = await prisma.executionEnvironmentInstance.create({
    data: {
      launchedByActorId: 'user-seed',
      launchedByActorType: 'user',
      organizationId: fleet.organizationId,
      status: 'pending',
      templateId: fleet.templateId,
    },
  })

  return instance.id
}

const cleanupFleet = async (
  prisma: PrismaClient,
  fleet: Fleet,
  instanceIds: string[],
): Promise<void> => {
  for (const instanceId of instanceIds) {
    await prisma
      .$executeRaw(
        Prisma.sql`
          DELETE FROM queue_jobs
          WHERE topic = 'execution.environment.terminate'
            AND payload->>'instanceId' = ${instanceId}
        `,
      )
      .catch(() => undefined)
  }
  await prisma.organization.deleteMany({ where: { id: fleet.organizationId } })
}

// The blocker the pre-provision write introduced, and the reason
// `deriveGcloudProviderInstanceRef` refuses a pinned name.
//
// `instanceName` lives on the TEMPLATE, so every instance launched from it
// resolves the identical `gcloud:vm:<project>:<zone>:builder`. Instance A
// provisions fine and owns that VM. Instance B derives the same string, gcloud
// rejects its create as already-exists, and B is marked failed — with a row
// naming A's live machine. Any later terminate of B, whether a person asks for
// it or a reclaim path enqueues it, would then delete A's VM. Deriving nothing
// for a pinned name is what keeps a failed row from addressing a machine it
// does not own; before this write existed the failed row carried no reference
// and its terminate was inert, which is exactly the behaviour restored here.
runDatabaseTest(
  'a second instance of a pinned-name template can never address the first instance machine',
  async () => {
    const prisma = new PrismaClient()
    const pinnedRef = 'gcloud:vm:nessie-pinned:europe-west4-a:builder'
    const fleet = await seedGcloudFleet(prisma, {
      image: 'debian-12',
      instanceName: 'builder',
      projectId: 'nessie-pinned',
      zone: 'europe-west4-a',
    })
    const liveId = await launchInstance(prisma, fleet)
    const failedId = await launchInstance(prisma, fleet)

    try {
      // Instance A: provisioned, running, owns the VM called `builder`. This is
      // the row `persistProvisionSuccess` leaves behind.
      await prisma.executionEnvironmentInstance.update({
        where: { id: liveId },
        data: {
          providerInstanceRef: pinnedRef,
          readyAt: new Date(),
          status: 'ready',
        },
      })

      // Instance B: the real provisioning prefix, then the failure gcloud
      // returns for a name that is already taken.
      const context = await loadProvisioningContext(prisma, failedId, fleet.runnerLabelPrefix)
      assert.ok(context, 'the second instance should have been claimed and leased')
      assert.equal(await acknowledgeLease(prisma, context.leaseId), true)
      await persistDerivedProviderInstanceRef(prisma, context)
      await markProvisionFailure(
        prisma,
        context,
        new Error("The resource 'projects/nessie-pinned/zones/europe-west4-a/instances/builder' already exists"),
      )

      const failed = await prisma.executionEnvironmentInstance.findUnique({
        where: { id: failedId },
      })
      assert.equal(failed?.status, 'failed')
      assert.equal(
        failed?.providerInstanceRef,
        null,
        'a failed instance must not name a machine another instance row also names',
      )

      // Assert the reference first and terminate second: with the reference
      // absent this call cannot reach any machine, which is the property under
      // test. It returns without running `gcloud … delete` at all.
      const terminationContext = await loadTerminationContext(prisma, failedId)
      assert.ok(terminationContext)
      assert.deepEqual(
        await terminateGcloud(terminationContext),
        {},
        'terminating the failed instance must address nothing',
      )

      // And nothing was enqueued on its behalf either, so no other replica can
      // pick up the same deletion later.
      assert.equal(await countTerminateJobs(prisma, failedId), 0)

      const live = await prisma.executionEnvironmentInstance.findUnique({
        where: { id: liveId },
      })
      assert.equal(live?.status, 'ready')
      assert.equal(live?.providerInstanceRef, pinnedRef)
    } finally {
      await cleanupFleet(prisma, fleet, [liveId, failedId])
      await prisma.$disconnect()
    }
  },
)

// A provider that throws has not necessarily created nothing: `provisionGcloud`
// runs `deploy` and then `execute` for a Cloud Run job, and a VM create can
// report an error after the instance exists. `markProvisionFailure` marks the
// instance failed and finalizes the lease in one transaction, which puts the row
// permanently out of the lease sweep's reach — so a partially created machine
// used to run forever with a terminal row naming it. The failure path has to
// reclaim it itself, through the same terminate the sweep enqueues.
runDatabaseTest(
  'a provider that throws after creating the machine has it reclaimed by the failure path',
  async () => {
    const prisma = new PrismaClient()
    const fleet = await seedGcloudFleet(prisma, {
      image: 'debian-12',
      projectId: 'nessie-partial',
      zone: 'europe-west4-a',
    })
    const instanceId = await launchInstance(prisma, fleet)

    try {
      const context = await loadProvisioningContext(prisma, instanceId, fleet.runnerLabelPrefix)
      assert.ok(context, 'the instance should have been claimed and leased')
      assert.equal(await acknowledgeLease(prisma, context.leaseId), true)
      await persistDerivedProviderInstanceRef(prisma, context)

      // ---- gcloud created the machine, and then the call threw ----
      await markProvisionFailure(prisma, context, new Error('GCLOUD_RUN_JOBS_EXECUTE_FAILED'))

      const expectedRef = `gcloud:vm:nessie-partial:europe-west4-a:${buildGcloudInstanceName(instanceId)}`

      assert.equal(
        await countTerminateJobs(prisma, instanceId),
        1,
        'the machine the failed provision may have created must be enqueued for termination',
      )
      const job = await prisma.$queryRaw<{ idempotency_key: string }[]>(
        Prisma.sql`
          SELECT idempotency_key
          FROM queue_jobs
          WHERE topic = 'execution.environment.terminate'
            AND payload->>'instanceId' = ${instanceId}
        `,
      )
      assert.equal(
        job[0]?.idempotency_key,
        `execution-environment:terminate:provision-failed:${instanceId}`,
      )

      const instance = await prisma.executionEnvironmentInstance.findUnique({
        where: { id: instanceId },
      })
      assert.equal(instance?.status, 'failed')
      assert.equal(instance?.errorMessage, 'GCLOUD_RUN_JOBS_EXECUTE_FAILED')
      // The terminate is only useful if the reference survives to the handler,
      // which reads it off the instance row.
      assert.equal(instance?.providerInstanceRef, expectedRef)

      const lease = await prisma.executionLease.findUnique({ where: { id: context.leaseId } })
      assert.equal(lease?.status, 'completed')

      // Why the failure path has to do this itself: the lease is terminal, so
      // the sweep never sees this instance and adds nothing.
      await expireExecutionLeases(prisma)
      assert.equal(await countTerminateJobs(prisma, instanceId), 1)
    } finally {
      await cleanupFleet(prisma, fleet, [instanceId])
      await prisma.$disconnect()
    }
  },
)

// One instance can carry more than one non-terminal lease:
// `loadProvisioningContext` re-claims an instance that is already
// `provisioning`, so a retried allocate job mints a second lease while the first
// is still live. When the orphaned first lease expires it reaches a row a later
// attempt has since driven to `ready` — and a sweep that enqueued on the lease
// alone would terminate a machine that is running fine.
runDatabaseTest('an orphaned lease on a ready instance terminates nothing', async () => {
  const prisma = new PrismaClient()
  const seed = await seedExpiredLease(prisma, {
    instanceStatus: 'ready',
    leaseStatus: 'issued',
    provider: 'gcloud',
    providerInstanceRef: `gcloud:vm:proj:europe-west4-a:nessie-${randomUUID().slice(0, 8)}`,
  })

  try {
    await expireExecutionLeases(prisma)

    assert.equal(
      await countTerminateJobs(prisma, seed.instanceId),
      0,
      'a running instance must not be reclaimed because an older lease expired',
    )

    const instance = await prisma.executionEnvironmentInstance.findUnique({
      where: { id: seed.instanceId },
    })
    assert.equal(instance?.status, 'ready')

    // The lease itself is still reclaimed — it is genuinely dead — so the
    // runner reaper can collect its runner.
    const lease = await prisma.executionLease.findUnique({ where: { id: seed.leaseId } })
    assert.equal(lease?.status, 'expired')
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

const POISON_ERROR = 'POISONED_LEASE_TRANSACTION'

// A prisma client that shows the sweep only this test's two leases and fails the
// first transaction it opens. Together those make one specific lease poisonous,
// deterministically, without depending on what else a shared database holds.
const poisonFirstLease = (prisma: PrismaClient, leaseIds: string[]): PrismaClient => {
  let poisoned = false

  const leases = new Proxy(prisma.executionLease, {
    get: (target, property) => {
      if (property !== 'findMany') {
        const value = Reflect.get(target, property) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (args: unknown) => {
        const rows = (await (target.findMany as (a: unknown) => Promise<{ id: string }[]>)(
          args,
        )) as { id: string }[]
        return rows.filter((row) => leaseIds.includes(row.id))
      }
    },
  })

  return new Proxy(prisma, {
    get: (target, property) => {
      if (property === 'executionLease') {
        return leases
      }
      if (property === '$transaction') {
        return async (...args: unknown[]) => {
          if (!poisoned) {
            poisoned = true
            throw new Error(POISON_ERROR)
          }
          return (target.$transaction as (...a: unknown[]) => unknown)(...args)
        }
      }
      const value = Reflect.get(target, property) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as PrismaClient
}

// The starvation trap in a bounded, oldest-first sweep. A lease that throws
// deterministically never leaves the predicate, so the next pass reads the same
// batch and meets it first again — forever. Uncaught, that one row holds the
// whole backlog behind it while every abandoned machine keeps billing.
runDatabaseTest('a lease that throws costs one row, not the pass', async () => {
  const prisma = new PrismaClient()
  const poison = await seedExpiredLease(prisma, {
    expiresAt: new Date('2019-01-01T00:00:00.000Z'),
    provider: 'gcloud',
    providerInstanceRef: `gcloud:vm:proj:europe-west4-a:poison-${randomUUID().slice(0, 8)}`,
  })
  const behind = await seedExpiredLease(prisma, {
    expiresAt: new Date('2019-06-01T00:00:00.000Z'),
    provider: 'gcloud',
    providerInstanceRef: `gcloud:vm:proj:europe-west4-a:behind-${randomUUID().slice(0, 8)}`,
  })

  const reported: unknown[][] = []
  const realConsoleError = console.error
  console.error = (...args: unknown[]) => {
    reported.push(args)
  }

  try {
    const expired = await expireExecutionLeases(
      poisonFirstLease(prisma, [poison.leaseId, behind.leaseId]),
    )

    // The lease behind the poisoned one was reclaimed, which is the whole point.
    assert.equal(expired, 1)
    assert.equal(await countTerminateJobs(prisma, behind.instanceId), 1)
    const behindLease = await prisma.executionLease.findUnique({ where: { id: behind.leaseId } })
    assert.equal(behindLease?.status, 'expired')

    // The poisoned one rolled back whole: still claimable, nothing enqueued.
    const poisonLease = await prisma.executionLease.findUnique({ where: { id: poison.leaseId } })
    assert.equal(poisonLease?.status, 'acknowledged')
    assert.equal(await countTerminateJobs(prisma, poison.instanceId), 0)

    // Retried forever, but never in silence: every pass names the row and its
    // error, because nothing here retires it and the machine may still be
    // billing.
    const named = reported.some((args) =>
      args.some(
        (arg) =>
          typeof arg === 'object'
          && arg !== null
          && (arg as { leaseId?: string }).leaseId === poison.leaseId,
      ),
    )
    assert.ok(named, 'the failing lease must be reported with its id')
    assert.ok(
      reported.some((args) =>
        args.some((arg) => typeof arg === 'string' && arg.includes('1 of 2 expired leases')),
      ),
      'the pass must report how many leases it could not reclaim',
    )
  } finally {
    console.error = realConsoleError
    await cleanup(prisma, poison)
    await cleanup(prisma, behind)
    await prisma.$disconnect()
  }
})
