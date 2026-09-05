import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  type BoardSourceAdapter,
  type NormalisedItem,
  SourceRejectedError,
  itemFingerprint,
} from '@nessie/board-sources'

import { sealSecret } from '@nessie/runtime'

import { applyInboundItem } from '../src/board-source-apply.js'
import { createBoardSourceWriteBack } from '../src/board-source-writeback.js'
import { listBoards, moveProjectTaskToColumn } from '../src/index.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const item = (over: Partial<NormalisedItem> = {}): NormalisedItem => ({
  externalId: 'issue-1',
  externalKey: 'ENG-1',
  url: 'https://linear.app/acme/issue/ENG-1',
  title: 'Ship it',
  description: null,
  stateId: 'state-todo',
  stateName: 'Todo',
  assignee: null,
  priority: null,
  dueDate: null,
  labels: [],
  fields: {},
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  archived: false,
  ...over,
})

/** A stand-in provider: records what it was asked, answers with an echo. */
const fakeAdapter = (behaviour: {
  onApply?: (change: Record<string, unknown>) => void
  refuseWith?: SourceRejectedError
  echo?: NormalisedItem
}): BoardSourceAdapter =>
  ({
    provider: 'linear',
    allowedHosts: ['api.linear.app'],
    oauth: {
      buildAuthorizeUrl: () => '',
      exchange: async () => {
        throw new Error('unused')
      },
      refresh: async (credential) => credential,
    },
    listContainers: async () => [],
    describeContainer: async () => ({ states: [], fields: [], members: [] }),
    fetchPage: async () => ({ items: [], checkpoint: { phase: 'incremental' }, hasMore: false }),
    fetchItems: async () => [],
    ensureWebhook: async () => null,
    verifyWebhook: () => true,
    parseWebhook: () => ({ deliveryId: '', containerKey: null, externalIds: [] }),
    applyChange: async (_ctx, _container, _item, change) => {
      behaviour.onApply?.(change as Record<string, unknown>)
      if (behaviour.refuseWith) throw behaviour.refuseWith
      return behaviour.echo ?? item({ stateId: 'state-done', stateName: 'Done' })
    },
  }) as unknown as BoardSourceAdapter

type Seed = {
  organizationId: string
  projectId: string
  sourceId: string
  taskId: string
  userId: string
}

const seed = async (
  prisma: PrismaClient,
  writeMode: 'read_only' | 'read_write',
): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Writeback tester', email: `wb-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `wb-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const connection = await prisma.boardSourceConnection.create({
    data: {
      organizationId: organization.id,
      ownerUserId: user.id,
      provider: 'linear',
      externalAccountId: `acct-${suffix}`,
      externalTenantId: `org-${suffix}`,
    },
  })
  await prisma.boardSourceConnectionCredential.create({
    data: {
      connectionId: connection.id,
      // Sealed with the same secret the tests pass in; never a real token.
      accessTokenCiphertext: sealSecret('test-secret', 'token'),
    },
  })
  const source = await prisma.boardSource.create({
    data: {
      projectId: project.id,
      organizationId: organization.id,
      connectionId: connection.id,
      provider: 'linear',
      name: 'Engineering',
      container: { teamId: 'team-1' },
      containerKey: 'team-1',
      writeMode,
      createdByUserId: user.id,
      stateMapping: [
        {
          externalStateId: 'state-todo',
          externalStateName: 'Todo',
          category: 'todo',
          isDefaultForCategory: true,
        },
        {
          externalStateId: 'state-done',
          externalStateName: 'Done',
          category: 'done',
          isDefaultForCategory: true,
        },
      ],
    },
  })

  const applied = await applyInboundItem(
    prisma,
    {
      id: source.id,
      organizationId: organization.id,
      projectId: project.id,
      provider: 'linear',
      stateMapping: [
        {
          externalStateId: 'state-todo',
          externalStateName: 'Todo',
          category: 'todo',
          isDefaultForCategory: true,
        },
        {
          externalStateId: 'state-done',
          externalStateName: 'Done',
          category: 'done',
          isDefaultForCategory: true,
        },
      ],
      fieldMappings: [],
      identityByExternalUserId: new Map(),
    },
    item(),
  )

  return {
    organizationId: organization.id,
    projectId: project.id,
    sourceId: source.id,
    taskId: applied.taskId as string,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: seeded.userId } })
}

const doneColumn = async (prisma: PrismaClient, projectId: string, organizationId: string) => {
  const [board] = await listBoards(prisma, { id: projectId, organizationId })
  const column = board?.columns.find((entry) => entry.category === 'done')
  assert.ok(column)
  return column
}

runDatabaseTest('a read-only source refuses a stage-changing move, in words', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma, 'read_only')
  try {
    const column = await doneColumn(prisma, seeded.projectId, seeded.organizationId)
    const outcome = await moveProjectTaskToColumn(
      prisma,
      {
        taskId: seeded.taskId,
        organizationId: seeded.organizationId,
        columnId: column.id,
        actorId: seeded.userId,
      },
      createBoardSourceWriteBack({
        prisma,
        encryptionSecret: 'test-secret',
        resolveAdapter: () => fakeAdapter({}),
      }),
    )
    assert.ok('error' in outcome)
    assert.equal(outcome.error, 'SOURCE_READ_ONLY')
    assert.match((outcome as { detail: string }).detail, /read & write/)

    // Nothing local moved either: the board and the ticket still agree.
    const task = await prisma.task.findUniqueOrThrow({ where: { id: seeded.taskId } })
    assert.equal(task.status, 'inbox')
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a read-write move asks the provider and applies its echo', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma, 'read_write')
  try {
    const column = await doneColumn(prisma, seeded.projectId, seeded.organizationId)
    const asked: Record<string, unknown>[] = []
    const outcome = await moveProjectTaskToColumn(
      prisma,
      {
        taskId: seeded.taskId,
        organizationId: seeded.organizationId,
        columnId: column.id,
        actorId: seeded.userId,
      },
      createBoardSourceWriteBack({
        prisma,
        encryptionSecret: 'test-secret',
        resolveAdapter: () => fakeAdapter({ onApply: (change) => asked.push(change) }),
      }),
    )
    assert.ok(!('error' in outcome), JSON.stringify(outcome))

    // The state written is the one mapped as that category's default.
    assert.deepEqual(asked, [{ stateId: 'state-done' }])

    const task = await prisma.task.findUniqueOrThrow({ where: { id: seeded.taskId } })
    assert.equal(task.status, 'done')

    // The echo's fingerprint is stamped, which is what makes the webhook this
    // write triggers recognisable as our own.
    const link = await prisma.taskExternalLink.findUniqueOrThrow({
      where: { taskId: seeded.taskId },
    })
    assert.equal(
      link.outboundFingerprint,
      itemFingerprint(item({ stateId: 'state-done', stateName: 'Done' }), []),
    )
    assert.notEqual(link.lastOutboundAt, null)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a provider refusal is surfaced and nothing local changes', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma, 'read_write')
  try {
    const column = await doneColumn(prisma, seeded.projectId, seeded.organizationId)
    const outcome = await moveProjectTaskToColumn(
      prisma,
      {
        taskId: seeded.taskId,
        organizationId: seeded.organizationId,
        columnId: column.id,
        actorId: seeded.userId,
      },
      createBoardSourceWriteBack({
        prisma,
        encryptionSecret: 'test-secret',
        resolveAdapter: () =>
          fakeAdapter({
            refuseWith: new SourceRejectedError(
              'LINEAR_UPDATE_REFUSED',
              'ENG-1 has no transition to Done',
            ),
          }),
      }),
    )
    assert.ok('error' in outcome)
    assert.equal(outcome.error, 'SOURCE_REJECTED')
    assert.match((outcome as { detail: string }).detail, /no transition to Done/)

    const task = await prisma.task.findUniqueOrThrow({ where: { id: seeded.taskId } })
    assert.equal(task.status, 'inbox')
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a native task is untouched by the write-back path', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma, 'read_only')
  try {
    const native = await prisma.task.create({
      data: {
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        status: 'inbox',
        title: 'A native task',
      },
    })
    const column = await doneColumn(prisma, seeded.projectId, seeded.organizationId)
    const outcome = await moveProjectTaskToColumn(
      prisma,
      {
        taskId: native.id,
        organizationId: seeded.organizationId,
        columnId: column.id,
        actorId: seeded.userId,
      },
      createBoardSourceWriteBack({
        prisma,
        encryptionSecret: 'test-secret',
        resolveAdapter: () => {
          throw new Error('a native task must never reach a provider')
        },
      }),
    )
    assert.ok(!('error' in outcome), JSON.stringify(outcome))
    const task = await prisma.task.findUniqueOrThrow({ where: { id: native.id } })
    assert.equal(task.status, 'done')
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
