import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import { McpScopeError } from '../src/mcp/scopes.js'
import { nessieMcpTools } from '../src/mcp/server.js'
import type { McpToolContext } from '../src/mcp/tool-context.js'
import { getTask } from '../src/services/tasks.js'

// A project's labels through the MCP server, against a real database: the
// scope gate, the name clash that hands back the label to use, the replace-set
// on a task, the delete that reports what it unlinked, the warning on renaming
// a label an external source owns, and the repaint every change publishes.
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

type Seed = { organizationId: string; projectId: string; otherProjectId: string; userId: string }

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `lb ${randomUUID()}` } })
  const [project, other] = await Promise.all(['p', 'q'].map((name) =>
    prisma.project.create({ data: { name, organizationId: org.id } })))
  const user = await prisma.user.create({
    data: { displayName: 'Owner', email: `lb-${randomUUID()}@example.test` },
  })
  await prisma.organizationMember.create({ data: { organizationId: org.id, role: 'owner', userId: user.id } })
  await prisma.board.create({
    data: { name: 'Delivery', organizationId: org.id, position: 0, projectId: project!.id },
  })
  return { organizationId: org.id, projectId: project!.id, otherProjectId: other!.id, userId: user.id }
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

runDatabaseTest('an agent manages a project\'s labels and sets them on a task', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const published: Published[] = []
    const context = contextFor(prisma, s, published)

    const bug = await tool('nessie_label_create').run(context, {
      projectId: s.projectId,
      name: 'Bug',
      color: '#EF4444',
    }) as { label: { id: string; color: string } }
    assert.equal(bug.label.color, '#ef4444', 'stored lower-case')
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

    const created = await tool('nessie_task_create').run(context, {
      projectId: s.projectId,
      title: 'Crash on save',
      labelIds: [bug.label.id],
    }) as { task: { id: string; labels: Array<{ id: string }> } }
    assert.deepEqual(created.task.labels.map((label) => label.id), [bug.label.id])

    // A label from another project means nothing on this task.
    const foreign = await prisma.taskLabel.create({
      data: {
        organizationId: s.organizationId,
        projectId: s.otherProjectId,
        name: 'Elsewhere',
        normalizedName: 'elsewhere',
      },
    })
    const refused = await tool('nessie_task_update').run(context, {
      taskId: created.task.id,
      labelIds: [foreign.id],
    }) as { code?: string }
    assert.equal(refused.code, 'LABEL_NOT_IN_PROJECT')

    const listed = await tool('nessie_label_list').run(context, { projectId: s.projectId }) as {
      labels: Array<{ id: string; taskCount?: number }>
    }
    assert.deepEqual(listed.labels.map((label) => [label.id, label.taskCount]), [[bug.label.id, 1]])

    const read = await tool('nessie_task_get').run(context, { taskId: created.task.id }) as {
      labels: Array<{ name: string }>
    }
    assert.deepEqual(read.labels.map((label) => label.name), ['Bug'])

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
        name: 'Frontend',
        normalizedName: 'frontend',
        sourceId: source.id,
        externalId: 'lin-label-1',
      },
    })

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
      labelId: owned.id,
      color: '#3b82f6',
    }) as { warning?: string }
    assert.equal(recoloured.warning, undefined)
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})
