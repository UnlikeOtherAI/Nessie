import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PrismaClient } from '@prisma/client'

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
// the only evidence of which instance row created it.
const shimDirectory = mkdtempSync(`${tmpdir()}/nessie-docker-collision-`)
const stateDirectory = mkdtempSync(`${tmpdir()}/nessie-docker-collision-state-`)
writeFileSync(
  join(shimDirectory, 'docker'),
  [
    '#!/bin/sh',
    `STATE=${JSON.stringify(stateDirectory)}`,
    'cmd="$1"',
    'case "$cmd" in',
    '  run)',
    '    name=""',
    '    label=""',
    '    shift',
    '    while [ $# -gt 0 ]; do',
    '      case "$1" in',
    '        --name) shift; name="$1" ;;',
    '        --label)',
    '          shift',
    '          case "$1" in',
    '            nessie.instance-id=*) label="${1#nessie.instance-id=}" ;;',
    '          esac',
    '          ;;',
    '      esac',
    '      shift',
    '    done',
    '    if [ -f "$STATE/$name" ]; then',
    '      existing=$(sed -n 1p "$STATE/$name")',
    '      echo "docker: Error response from daemon: Conflict. The container name'
    + ' \\"/$name\\" is already in use by container \\"$existing\\"." >&2',
    '      exit 125',
    '    fi',
    '    count=$(cat "$STATE/.count" 2>/dev/null || echo 0)',
    '    count=$((count + 1))',
    '    echo "$count" > "$STATE/.count"',
    '    id="container-id-$count"',
    '    printf \'%s\\n%s\\n\' "$id" "$label" > "$STATE/$name"',
    '    printf \'%s\\n\' "$id"',
    '    ;;',
    '  inspect)',
    '    target="$2"',
    '    format="$4"',
    '    case "$format" in',
    '      *State*)',
    '        printf \'{"Running":true,"Status":"running"}\\n\'',
    '        ;;',
    '      *Labels*)',
    '        if [ -f "$STATE/$target" ]; then',
    '          printf \'%s\\t%s\\n\' "$(sed -n 1p "$STATE/$target")" "$(sed -n 2p "$STATE/$target")"',
    '        else',
    '          echo "Error: No such object: $target" >&2',
    '          exit 1',
    '        fi',
    '        ;;',
    '      *)',
    '        if [ -f "$STATE/$target" ]; then',
    '          sed -n 1p "$STATE/$target"',
    '        else',
    '          echo "Error: No such object: $target" >&2',
    '          exit 1',
    '        fi',
    '        ;;',
    '    esac',
    '    ;;',
    '  *)',
    '    exit 0',
    '    ;;',
    'esac',
    '',
  ].join('\n'),
)
chmodSync(join(shimDirectory, 'docker'), 0o755)
process.env['PATH'] = `${shimDirectory}:${process.env['PATH'] ?? ''}`

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
        instanceId: firstId,
        runnerLabelPrefix: seed.runnerLabelPrefix,
      })
      const second = await allocateExecutionEnvironmentInstance(prisma, {
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
