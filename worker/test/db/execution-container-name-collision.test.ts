import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PrismaClient } from '@prisma/client'

import type { CommandRunner } from '../../src/control/execution/command-runner.js'
import { runDatabaseTest } from './support.js'

// A launch config may pin `containerName`, and that pin lives on the TEMPLATE,
// so every instance launched from it runs `docker run --name <the same name>`.
// The second one is told the name is already in use, and adopting whatever holds
// it gave two instance rows one container id: terminating either destroyed the
// other's live environment. This file asserts the durable rows, because the id
// two rows must never share is a column, not a return value. Same rule as the
// gcloud pinned-name fix (`deriveGcloudProviderInstanceRef`): a row may only
// ever name a machine no other row can name.

// Provisioning docker is refused outside `local`, so the collision only exists
// in the mode that still allows it. The gate resolves the mode once per process,
// which is why this file is separate from `execution-row-honesty.test.ts`.
process.env['NESSIE_MODE'] = 'local'

// A `docker` on PATH with a one-container-per-name daemon: `run` refuses a name
// it already holds the way the real daemon does, and `inspect` answers about the
// container behind a name — including the `nessie.instance-id` label, which is
// the only evidence of which instance row created it. The test fakes the typed
// command boundary, so it cannot fall through to a real Docker executable.
const stateDirectory = mkdtempSync(`${tmpdir()}/nessie-docker-collision-state-`)
const commandRunner: CommandRunner = async (command, args) => {
  assert.equal(command, 'docker')
  const statePath = (name: string): string => join(stateDirectory, name)
  if (args[0] === 'run') {
    const nameIndex = args.indexOf('--name')
    const name = nameIndex < 0 ? '' : args[nameIndex + 1] ?? ''
    const label = args.find((arg) => arg.startsWith('nessie.instance-id='))?.slice('nessie.instance-id='.length) ?? ''
    const record = statePath(name)
    if (existsSync(record)) {
      const [existing] = readFileSync(record, 'utf8').split('\n')
      throw new Error(
        `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${existing}".`,
      )
    }
    const countFile = statePath('.count')
    const count = Number(existsSync(countFile) ? readFileSync(countFile, 'utf8') : '0') + 1
    writeFileSync(countFile, String(count))
    const id = `container-id-${count}`
    writeFileSync(record, `${id}\n${label}\n`)
    return { stderr: '', stdout: `${id}\n` }
  }
  if (args[0] === 'inspect') {
    const target = args[1] ?? ''
    const format = args[args.indexOf('--format') + 1] ?? ''
    if (format.includes('State')) return { stderr: '', stdout: '{"Running":true,"Status":"running"}\n' }
    const record = statePath(target)
    if (!existsSync(record)) throw new Error(`Error: No such object: ${target}`)
    const [id, label] = readFileSync(record, 'utf8').trimEnd().split('\n')
    return { stderr: '', stdout: format.includes('Labels') ? `${id}\t${label}\n` : `${id}\n` }
  }
  return { stderr: '', stdout: '' }
}

const { allocateExecutionEnvironmentInstance } = await import('../../src/control/execution.js')
const { buildDockerContainerName } = await import('../../src/control/execution/naming.js')

type Seed = {
  organizationId: string
  runnerLabelPrefix: string
  templateId: string
}

const seedDockerTemplate = async (
  prisma: PrismaClient,
  launchConfig: Record<string, unknown>,
): Promise<Seed> => {
  const org = await prisma.organization.create({
    data: { name: `container-collision ${randomUUID()}` },
  })
  const template = await prisma.executionEnvironmentTemplate.create({
    data: {
      createdByActorId: 'user-seed',
      createdByActorType: 'user',
      image: 'alpine:3',
      launchConfig,
      mode: 'container',
      name: `tpl ${randomUUID()}`,
      organizationId: org.id,
      provider: 'docker',
    },
  })
  const runnerLabelPrefix = `collision-${randomUUID().slice(0, 8)}`
  await prisma.executionRunner.create({
    data: {
      heartbeatAt: new Date(),
      label: `${runnerLabelPrefix}-docker`,
      organizationId: org.id,
      provider: 'docker',
      status: 'active',
    },
  })

  return { organizationId: org.id, runnerLabelPrefix, templateId: template.id }
}

const launchInstance = async (prisma: PrismaClient, seed: Seed): Promise<string> => {
  const instance = await prisma.executionEnvironmentInstance.create({
    data: {
      launchedByActorId: 'user-seed',
      launchedByActorType: 'user',
      organizationId: seed.organizationId,
      status: 'pending',
      templateId: seed.templateId,
    },
  })
  return instance.id
}

const cleanup = async (prisma: PrismaClient, seed: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

runDatabaseTest(
  'two instances from one pinned-name template never end up naming the same container',
  async () => {
    const prisma = new PrismaClient()
    const seed = await seedDockerTemplate(prisma, {
      containerName: 'nessie-pinned-box',
      image: 'alpine:3',
    })

    try {
      const firstId = await launchInstance(prisma, seed)
      const secondId = await launchInstance(prisma, seed)

      const first = await allocateExecutionEnvironmentInstance(prisma, {
        commandRunner,
        instanceId: firstId,
        runnerLabelPrefix: seed.runnerLabelPrefix,
      })
      const second = await allocateExecutionEnvironmentInstance(prisma, {
        commandRunner,
        instanceId: secondId,
        runnerLabelPrefix: seed.runnerLabelPrefix,
      })

      const firstRow = await prisma.executionEnvironmentInstance.findUniqueOrThrow({
        where: { id: firstId },
      })
      const secondRow = await prisma.executionEnvironmentInstance.findUniqueOrThrow({
        where: { id: secondId },
      })

      // The invariant, stated on the durable rows and asserted before anything
      // else: one container, at most one row naming it. Adoption used to give
      // both rows `container-id-1`, so terminating the second destroyed the
      // first's environment while its row still said `ready`.
      assert.notEqual(firstRow.providerInstanceRef, secondRow.providerInstanceRef)
      assert.equal(firstRow.providerInstanceRef, 'container-id-1')
      assert.equal(secondRow.providerInstanceRef, null)
      assert.equal(firstRow.status, 'ready')

      // And the loser fails loudly, naming the container it refused to take.
      assert.equal(secondRow.status, 'failed')
      assert.match(String(secondRow.errorMessage), /DOCKER_CONTAINER_NAME_IN_USE:nessie-pinned-box/)
      assert.match(String(secondRow.errorMessage), new RegExp(`owned-by:${firstId}`))

      assert.equal(first, true)
      assert.equal(second, false)
    } finally {
      await cleanup(prisma, seed)
      await prisma.$disconnect()
    }
  },
)

// The case adoption exists for, and the only one it may serve: `docker run`
// created the container and the worker died before the row was written, so the
// retry meets a container this same instance created. The `nessie.instance-id`
// label is what tells the two cases apart.
runDatabaseTest('a retry adopts the container this instance itself created', async () => {
  const prisma = new PrismaClient()
  const seed = await seedDockerTemplate(prisma, { image: 'alpine:3' })

  try {
    const instanceId = await launchInstance(prisma, seed)
    // The container the first attempt created before the worker died: the
    // instance's own derived name, carrying its own instance label.
    writeFileSync(
      join(stateDirectory, buildDockerContainerName(instanceId)),
      `container-from-the-lost-attempt\n${instanceId}\n`,
    )

    const allocated = await allocateExecutionEnvironmentInstance(prisma, {
      commandRunner,
      instanceId,
      runnerLabelPrefix: seed.runnerLabelPrefix,
    })

    assert.equal(allocated, true)

    const row = await prisma.executionEnvironmentInstance.findUniqueOrThrow({
      where: { id: instanceId },
    })
    assert.equal(row.status, 'ready')
    assert.equal(row.providerInstanceRef, 'container-from-the-lost-attempt')
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})
