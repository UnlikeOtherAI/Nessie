import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import { McpScopeError } from '../src/mcp/scopes.js'
import { nessieMcpTools } from '../src/mcp/server.js'
import type { McpToolContext } from '../src/mcp/tool-context.js'
import { getTask } from '../src/services/tasks.js'

// A board's labels through the MCP server, against a real database: the
// scope gate, `boardId` reaching the shared functions (absent ⇒ the default
// board), the name clash that hands back the label to use, the replace-set on
// a task and its board refusal, the delete that reports what it unlinked, the
// warning on renaming a label an external source owns, and the repaint every
// change publishes.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const tool = (name: string) => {
  const found = nessieMcpTools().find((candidate) => candidate.name === name)
  assert.ok(found, `${name} is not registered`)
  return found
}

test('every label tool refuses without its scope', async () => {
  const cases: Array<[string, 'boards_read' | 'boards_write']> = [
    ['nessie_label_list', 'boards_read'],
    ['nessie_label_create', 'boards_write'],
    ['nessie_label_update', 'boards_write'],
    ['nessie_label_delete', 'boards_write'],
  ]
  for (const [name, required] of cases) {
    for (const scopes of [[], required === 'boards_write' ? ['boards_read'] : ['boards_write']]) {
      await assert.rejects(
        () => tool(name).run({ scopes } as never, { projectId: randomUUID() }),
        (error: unknown) => {
          assert.ok(error instanceof McpScopeError, `${name} did not check its scope first`)
          assert.equal(error.required, required)
          return true
        },
      )
    }
  }
})

type Seed = {
  organizationId: string
  projectId: string
  otherProjectId: string
  otherProjectBoardId: string
  boardId: string
  devBoardId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `lb ${randomUUID()}` } })
  const [project, other] = await Promise.all(['p', 'q'].map((name) =>
    prisma.project.create({ data: { name, organizationId: org.id } })))
  const user = await prisma.user.create({
    data: { displayName: 'Owner', email: `lb-${randomUUID()}@example.test` },
  })
  await prisma.organizationMember.create({ data: { organizationId: org.id, role: 'owner', userId: user.id } })
  const board = await prisma.board.create({
    data: { name: 'Delivery', organizationId: org.id, position: 0, projectId: project!.id, isDefault: true },
  })
  const dev = await prisma.board.create({
    data: { name: 'Dev', organizationId: org.id, position: 1, projectId: project!.id },
  })
  const otherBoard = await prisma.board.create({
    data: { name: 'Board', organizationId: org.id, position: 0, projectId: other!.id, isDefault: true },
  })
  return {
    organizationId: org.id,
    projectId: project!.id,
    otherProjectId: other!.id,
    otherProjectBoardId: otherBoard.id,
    boardId: board.id,
    devBoardId: dev.id,
    userId: user.id,
  }
}

type Published = { event: string; data: Record<string, unknown> }

const contextFor = (prisma: PrismaClient, s: Seed, published: Published[]): McpToolContext => ({
  actorContext: AuthorizedActionContextSchema.parse({
    actionContext: { requestId: randomUUID() },
    actor: { actorId: s.userId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId: s.organizationId, projectId: s.projectId },
  }),
  encryptionKeyRing: { activeVersion: 'test', keys: { test: 'mcp-labels-encryption-root' } },
  checkPolicy: async () => ({ allowed: true, reasonCode: 'ALLOWED' }),
  getTask: async (taskId) =>
    getTask(prisma, taskId, s.organizationId, undefined, s.userId, undefined) as never,
  isProjectAccessibleToActor: async () => true,
  knowledge: null,
  prisma,
  realtime: {
    publishWs: async (_scopes, input) => {
      published.push({ event: input.event, data: input.data as Record<string, unknown> })
      return {} as never
    },
  },
  scopes: ['boards_read', 'boards_write'],
})

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  await prisma.organization.delete({ where: { id: s.organizationId } })
  await prisma.user.delete({ where: { id: s.userId } }).catch(() => undefined)
}

runDatabaseTest('an agent manages a board\'s labels and sets them on a task', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const published: Published[] = []
    const context = contextFor(prisma, s, published)

    const bug = await tool('nessie_label_create').run(context, {
      projectId: s.projectId,
      name: 'Bug',
      color: '#EF4444',
    }) as { label: { id: string; color: string; boardId: string } }
    assert.equal(bug.label.color, '#ef4444', 'stored lower-case')
    assert.equal(bug.label.boardId, s.boardId, 'no boardId creates on the default board')
    assert.ok(
      published.some((event) => event.event === 'board.updated' && event.data.projectId === s.projectId),
      'cards repaint when a label appears',
    )

    // The same name, any case: refused, with the label to use instead.
    const clash = await tool('nessie_label_create').run(context, {
      projectId: s.projectId,
      name: '  bug ',
    }) as { code?: string; label?: { id: string } }
    assert.equal(clash.code, 'LABEL_NAME_TAKEN')
    assert.equal(clash.label?.id, bug.label.id)

    // The same name on another board is that board's own label.
    const devBug = await tool('nessie_label_create').run(context, {
      projectId: s.projectId,
      boardId: s.devBoardId,
      name: 'Bug',
    }) as { label: { id: string; boardId: string } }
    assert.equal(devBug.label.boardId, s.devBoardId)
    assert.notEqual(devBug.label.id, bug.label.id)
    // A board of another project is not found.
    assert.deepEqual(
      await tool('nessie_label_create').run(context, { projectId: s.projectId, boardId: s.otherProjectBoardId, name: 'X' }),
      { error: 'Board not found in this project.' },
    )

    const created = await tool('nessie_task_create').run(context, {
      projectId: s.projectId,
      title: 'Crash on save',
      labelIds: [bug.label.id],
    }) as { task: { id: string; labels: Array<{ id: string }> } }
    assert.deepEqual(created.task.labels.map((label) => label.id), [bug.label.id])

    // Another board's label means nothing on this task.
    const refused = await tool('nessie_task_update').run(context, {
      taskId: created.task.id,
      labelIds: [devBug.label.id],
    }) as { code?: string; error?: string }
    assert.equal(refused.code, 'LABEL_NOT_ON_BOARD')
    assert.equal(refused.error, "That label is not on this task's board. Read them with nessie_label_list.")

    const listed = await tool('nessie_label_list').run(context, { projectId: s.projectId, boardId: s.boardId }) as {
      labels: Array<{ id: string; taskCount?: number }>
    }
    assert.deepEqual(listed.labels.map((label) => [label.id, label.taskCount]), [[bug.label.id, 1]])
    const everyBoard = await tool('nessie_label_list').run(context, { projectId: s.projectId }) as {
      labels: Array<{ id: string; boardId: string }>
    }
    assert.deepEqual(
      everyBoard.labels.map((label) => [label.id, label.boardId]),
      [[bug.label.id, s.boardId], [devBug.label.id, s.devBoardId]],
    )

    const read = await tool('nessie_task_get').run(context, { taskId: created.task.id }) as {
      labels: Array<{ name: string }>
    }
    assert.deepEqual(read.labels.map((label) => label.name), ['Bug'])

    // A boardId that is not the label's board is not found.
    const wrongBoard = await tool('nessie_label_delete').run(context, {
      projectId: s.projectId,
      boardId: s.devBoardId,
      labelId: bug.label.id,
    }) as { code?: string }
    assert.equal(wrongBoard.code, 'LABEL_NOT_FOUND')

    const deleted = await tool('nessie_label_delete').run(context, {
      projectId: s.projectId,
      labelId: bug.label.id,
    }) as { deleted: boolean; removedFromTasks: number }
    assert.deepEqual(deleted, { deleted: true, removedFromTasks: 1 })
    assert.equal(await prisma.taskLabelLink.count({ where: { taskId: created.task.id } }), 0)
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('renaming a label a source owns warns that the next sync restores it', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(prisma, s, [])
    const connection = await prisma.boardSourceConnection.create({
      data: {
        externalAccountId: 'lin-user-1',
        organizationId: s.organizationId,
        ownerUserId: s.userId,
        provider: 'linear',
      },
    })
    const source = await prisma.boardSource.create({
      data: {
        connectionId: connection.id,
        container: {},
        containerKey: `team-${randomUUID()}`,
        createdByUserId: s.userId,
        name: 'Linear — Core',
        organizationId: s.organizationId,
        projectId: s.projectId,
        provider: 'linear',
        writeMode: 'read_write',
      },
    })
    const owned = await prisma.taskLabel.create({
      data: {
        organizationId: s.organizationId,
        projectId: s.projectId,
        boardId: s.devBoardId,
        name: 'Frontend',
        normalizedName: 'frontend',
        sourceId: source.id,
        externalId: 'lin-label-1',
      },
    })

    // Found by id in the project, whichever board it is on; a wrong board is not found.
    const wrongBoard = await tool('nessie_label_update').run(context, {
      projectId: s.projectId,
      boardId: s.boardId,
      labelId: owned.id,
      name: 'Web',
    }) as { code?: string }
    assert.equal(wrongBoard.code, 'LABEL_NOT_FOUND')
    const renamed = await tool('nessie_label_update').run(context, {
      projectId: s.projectId,
      labelId: owned.id,
      name: 'Web',
    }) as { label: { name: string }; warning?: string }
    assert.equal(renamed.label.name, 'Web')
    assert.equal(renamed.warning, 'Linear owns this label\'s name; the next sync restores it.')

    // A recolour is not a rename, and needs no warning.
    const recoloured = await tool('nessie_label_update').run(context, {
      projectId: s.projectId,
      boardId: s.devBoardId,
      labelId: owned.id,
      color: '#3b82f6',
    }) as { warning?: string }
    assert.equal(recoloured.warning, undefined)
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})
