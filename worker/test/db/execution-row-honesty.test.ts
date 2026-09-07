import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import type { CommandRunner } from '../../src/control/execution/command-runner.js'
import { runDatabaseTest } from './support.js'

// Two rows this file refuses to let the worker write: an instance moved to
// `ready` by a provision that was never persisted (plan row 5.13), and an
// instance marked `terminated` by a worker that never reached the container
// (plan row 5.12). Both are database claims about a machine, so both are
// asserted on the row rather than on a return value.

// The gate resolves the mode once per process, and these cases are about a
// deployment running more than one worker — `local` is the single-daemon
// deployment where a `No such container` really is proof. Set before the
// dynamic imports below, exactly as `providers.test.ts` does; a non-local mode
// must also name an object store, because `loadConfig` refuses `filesystem`
// storage outside `local`.
process.env['NESSIE_MODE'] = 'selfHosted'
process.env['NESSIE_STORAGE_PROVIDER'] = 's3'
process.env['NESSIE_STORAGE_BUCKET'] = 'nessie'

// This test fakes the command runner itself. A PATH shim cannot safely replace
// `docker` on Windows because `execFile` cannot execute a .cmd fake and may
// choose a real docker.exe instead.
const ABSENT_CONTAINER = 'container-on-another-host'
const commandRunner: CommandRunner = async (command, args) => {
  assert.equal(command, 'docker')
  if (args.includes(ABSENT_CONTAINER)) {
    throw new Error(`No such container: ${ABSENT_CONTAINER}`)
  }
  return { stderr: '', stdout: '' }
}
const { terminateExecutionEnvironmentInstance } = await import('../../src/control/execution.js')
const { persistProvisionSuccess } = await import('../../src/control/execution/persistence.js')

type Seed = {
  instanceId: string
  leaseId: string
  organizationId: string
  runnerId: string
}

const seedInstance = async (
  prisma: PrismaClient,
  input: {
    instanceStatus: 'provisioning' | 'ready'
    leaseStatus: 'acknowledged' | 'issued' | 'revoked'
    metadata?: Record<string, unknown>
    provider: 'docker' | 'gcloud'
    providerInstanceRef: string | null
    startedAt?: Date
  },
): Promise<Seed> => {
  const org = await prisma.organization.create({
    data: { name: `row-honesty ${randomUUID()}` },
  })
  const template = await prisma.executionEnvironmentTemplate.create({
    data: {
      createdByActorId: 'user-seed',
      createdByActorType: 'user',
      image: input.provider === 'docker' ? 'alpine:3' : 'debian-12',
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
      metadata: input.metadata ?? {},
      organizationId: org.id,
      providerInstanceRef: input.providerInstanceRef,
      startedAt: input.startedAt ?? new Date(),
      status: input.instanceStatus,
      templateId: template.id,
    },
  })
  const runner = await prisma.executionRunner.create({
    data: {
      heartbeatAt: new Date(),
      label: `row-honesty-${randomUUID()}`,
      organizationId: org.id,
      provider: input.provider,
      status: 'active',
    },
  })
  const lease = await prisma.executionLease.create({
    data: {
      expiresAt: new Date(Date.now() + 5 * 60_000),
      instanceId: instance.id,
      leaseToken: randomUUID(),
      runnerId: runner.id,
      status: input.leaseStatus,
    },
  })

  return {
    instanceId: instance.id,
    leaseId: lease.id,
    organizationId: org.id,
    runnerId: runner.id,
  }
}

const provisioningContextFor = async (prisma: PrismaClient, seed: Seed) => {
  const instance = await prisma.executionEnvironmentInstance.findUniqueOrThrow({
    where: { id: seed.instanceId },
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

  return { instance, leaseId: seed.leaseId, runnerId: seed.runnerId }
}

const cleanup = async (prisma: PrismaClient, seed: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

// Plan row 5.13. A Prisma interactive transaction commits unless its callback
// throws, so `persistProvisionSuccess` returning `false` from inside one used to
// commit whatever its two conditional writes had already done. The dangerous
// half is the instance write landing while the lease write matches nothing —
// a concurrent terminate has revoked the lease — because the row is then
// committed `ready`, naming the container the caller is about to destroy in
// `cleanupProvisionedInstance`, with no allocation usage recorded and nothing
// left to move it off `ready`. Persisting nothing is the only honest outcome for
// a provision that could not be recorded.
runDatabaseTest('a provision that cannot be persisted commits neither of its writes', async () => {
  const prisma = new PrismaClient()
  const seed = await seedInstance(prisma, {
    instanceStatus: 'provisioning',
    leaseStatus: 'revoked',
    provider: 'gcloud',
    providerInstanceRef: null,
  })

  try {
    const context = await provisioningContextFor(prisma, seed)
    const persisted = await persistProvisionSuccess(prisma, context, {
      metadata: { zone: 'europe-west4-a' },
      providerInstanceRef: 'gcloud:vm:proj:europe-west4-a:nessie-ee-abc',
      status: 'ready',
    })

    assert.equal(persisted, false)

    const instance = await prisma.executionEnvironmentInstance.findUniqueOrThrow({
      where: { id: seed.instanceId },
    })
    assert.equal(instance.status, 'provisioning')
    assert.equal(instance.providerInstanceRef, null)
    assert.equal(instance.readyAt, null)

    const lease = await prisma.executionLease.findUniqueOrThrow({ where: { id: seed.leaseId } })
    assert.equal(lease.status, 'revoked')
    assert.equal(lease.completedAt, null)

    assert.equal(
      await prisma.executionUsageLedger.count({ where: { instanceId: seed.instanceId } }),
      0,
    )
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

// Plan row 5.12 / audit 6.3. A container id belongs to one host's daemon and
// queue jobs are not host-routed, so a terminate can be claimed by a worker that
// never had the container. `docker rm -f` answers `No such container`, which was
// swallowed as already-gone and written as `terminated` — a row claiming a
// container is gone while it runs on and bills the dead host's CPU. The row now
// says what an operator can act on: `failed`, with the container id, the runner
// that provisioned it, and the label to find it by.
runDatabaseTest(
  'a docker terminate that cannot reach the container records failed, not terminated',
  async () => {
    const prisma = new PrismaClient()
    const seed = await seedInstance(prisma, {
      instanceStatus: 'ready',
      leaseStatus: 'acknowledged',
      metadata: { runnerLabel: 'worker-9f21ab34-docker' },
      provider: 'docker',
      providerInstanceRef: ABSENT_CONTAINER,
      startedAt: new Date(Date.now() - 10 * 60_000),
    })

    try {
      const verified = await terminateExecutionEnvironmentInstance(prisma, seed.instanceId, { commandRunner })

      // The row first: this defect is a database claim, not a return value.
      const instance = await prisma.executionEnvironmentInstance.findUniqueOrThrow({
        where: { id: seed.instanceId },
      })
      assert.equal(instance.status, 'failed')
      assert.equal(instance.terminatedAt, null)
      // Kept: the id and the label built from it are how the container is found
      // on the host that started it.
      assert.equal(instance.providerInstanceRef, ABSENT_CONTAINER)
      assert.match(String(instance.errorMessage), /^EXECUTION_TERMINATE_UNVERIFIED/)
      assert.match(String(instance.errorMessage), /worker-9f21ab34-docker/)
      assert.match(String(instance.errorMessage), new RegExp(`nessie.instance-id=${seed.instanceId}`))

      const metadata = instance.metadata as Record<string, unknown>
      assert.equal(typeof metadata['terminationUnverifiedAt'], 'string')
      assert.equal(metadata['terminateUnverifiedReason'], 'DOCKER_NO_SUCH_CONTAINER')

      // The lease is still finished: nothing is renewing it, whatever the
      // container is doing.
      const lease = await prisma.executionLease.findUniqueOrThrow({ where: { id: seed.leaseId } })
      assert.equal(lease.status, 'revoked')

      // And the caller is told the terminate did not complete, so a workflow
      // step waiting on it is not told the environment is gone either.
      assert.equal(verified, false)
    } finally {
      await cleanup(prisma, seed)
      await prisma.$disconnect()
    }
  },
)

// The other half of the same rule: a terminate that DID reach the container
// still records `terminated`. Without this, "never write terminated" would pass
// the case above and break every real termination.
runDatabaseTest('a docker terminate that removes the container still records terminated', async () => {
  const prisma = new PrismaClient()
  const seed = await seedInstance(prisma, {
    instanceStatus: 'ready',
    leaseStatus: 'acknowledged',
    provider: 'docker',
    providerInstanceRef: 'container-this-daemon-has',
    startedAt: new Date(Date.now() - 10 * 60_000),
  })

  try {
    const verified = await terminateExecutionEnvironmentInstance(prisma, seed.instanceId, { commandRunner })
    assert.equal(verified, true)

    const instance = await prisma.executionEnvironmentInstance.findUniqueOrThrow({
      where: { id: seed.instanceId },
    })
    assert.equal(instance.status, 'terminated')
    assert.notEqual(instance.terminatedAt, null)
    assert.equal(instance.errorMessage, null)
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})
