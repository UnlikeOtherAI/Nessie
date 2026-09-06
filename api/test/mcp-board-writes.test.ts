import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import { getTask } from '../src/services/tasks.js'
import { nessieMcpTools } from '../src/mcp/server.js'
import type { McpToolContext } from '../src/mcp/tool-context.js'

// The board writes, against a real database.
//
// The property that matters most is the one a pre-check would have got wrong:
// a task mirrored from a read-only source must be refused, and refused in words
// that tell the agent where the change belongs. Nessie already decides that in
// the write-back collaborator, so this proves the tool surfaces that decision
// rather than inventing a second one.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const tool = (name: string) => {
  const found = nessieMcpTools().find((candidate) => candidate.name === name)
  assert.ok(found, `${name} is not registered`)
  return found
}

type Seed = {
  boardId: string
  columnId: string
  organizationId: string
  projectId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `bw ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Owner', email: `bw-${randomUUID()}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: org.id, role: 'owner', userId: user.id },
  })
  const board = await prisma.board.create({
    data: { name: 'Delivery', organizationId: org.id, position: 0, projectId: project.id },
  })
  const column = await prisma.boardColumn.create({
    data: {
      boardId: board.id,
      category: 'in_progress',
      name: 'In progress',
      organizationId: org.id,
      position: 1,
    },
  })
  return {
    boardId: board.id,
    columnId: column.id,
    organizationId: org.id,
    projectId: project.id,
    userId: user.id,
  }
}

const contextFor = (prisma: PrismaClient, s: Seed): McpToolContext => ({
  actorContext: AuthorizedActionContextSchema.parse({
    actionContext: { requestId: randomUUID() },
    actor: { actorId: s.userId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId: s.organizationId, projectId: s.projectId },
  }),
  authSecret: 'test-secret',
  checkPolicy: async () => ({ allowed: true, reasonCode: 'ALLOWED' }),
  // The real reader, so the test cannot pass against a shape production never
  // produces.
  getTask: async (taskId) =>
    getTask(prisma, taskId, s.organizationId, undefined) as never,
  isProjectAccessibleToActor: async () => true,
  knowledge: null,
  prisma,
  scopes: ['boards_read', 'boards_write'],
})

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  await prisma.organization.delete({ where: { id: s.organizationId } })
  await prisma.user.delete({ where: { id: s.userId } }).catch(() => undefined)
}

runDatabaseTest('an agent can create a task and read it back', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(prisma, s)
    const created = await tool('nessie_task_create').run(context, {
      boardId: s.boardId,
      projectId: s.projectId,
      title: 'Ship the MCP server',
    }) as { task?: { id: string } }

    assert.ok(created.task, 'the task should have been created')
    const stored = await prisma.task.findUnique({ where: { id: created.task.id } })
    assert.equal(stored?.title, 'Ship the MCP server')
    assert.equal(stored?.organizationId, s.organizationId)

    const read = await tool('nessie_task_get').run(context, {
      taskId: created.task.id,
    }) as { origin?: { kind: string; writable: boolean } }
    // A native task says so, and says writes reach it.
    assert.deepEqual(read.origin, { kind: 'internal', writable: true })
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an agent can update a native task', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(prisma, s)
    const created = await tool('nessie_task_create').run(context, {
      projectId: s.projectId,
      title: 'Before',
    }) as { task: { id: string } }

    await tool('nessie_task_update').run(context, {
      priority: 'high',
      taskId: created.task.id,
      title: 'After',
    })

    const stored = await prisma.task.findUnique({ where: { id: created.task.id } })
    assert.equal(stored?.title, 'After')
    assert.equal(stored?.priority, 'high')
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a write to a read-only Linear mirror is refused, and says where to go', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(prisma, s)
    const created = await tool('nessie_task_create').run(context, {
      projectId: s.projectId,
      title: 'Mirrored from Linear',
    }) as { task: { id: string } }

    // Make it a mirror of a read-only Linear source, exactly as a sync would.
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
        writeMode: 'read_only',
      },
    })
    await prisma.taskExternalLink.create({
      data: {
        externalId: 'ENG-1',
        externalKey: 'ENG-1',
        externalUrl: 'https://linear.app/acme/issue/ENG-1',
        organizationId: s.organizationId,
        sourceId: source.id,
        taskId: created.task.id,
      },
    })

    // The read says so before the agent tries.
    const read = await tool('nessie_task_get').run(context, {
      taskId: created.task.id,
    }) as { origin: { kind: string; provider: string; writable: boolean } }
    assert.equal(read.origin.kind, 'mirrored')
    assert.equal(read.origin.provider, 'linear')
    assert.equal(read.origin.writable, false)

    // And the write is refused rather than quietly applied locally, which the
    // next sync would have overwritten.
    const refused = await tool('nessie_task_update').run(context, {
      taskId: created.task.id,
      title: 'Renamed behind Linear\'s back',
    }) as { error?: string; retryable?: boolean }

    // Specifically the source's own refusal, not merely "some failure": a
    // not-found would satisfy a looser assertion and prove nothing about
    // `writeMode` being read at all. The wording comes from the write-back
    // collaborator, which names the provider and the remedy — better than
    // anything this tool could compose, which is the reason it is passed
    // through rather than replaced.
    assert.match(
      String(refused.error),
      /Linear/,
      `expected the source's refusal naming the provider, got: ${refused.error}`,
    )
    assert.equal(refused.retryable, false, 'retrying will never help')

    const stored = await prisma.task.findUnique({ where: { id: created.task.id } })
    assert.equal(
      stored?.title,
      'Mirrored from Linear',
      'the local row must be untouched by a refused write',
    )
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a task from an unreachable project is not writable by id', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(prisma, s)
    const created = await tool('nessie_task_create').run(context, {
      projectId: s.projectId,
      title: 'Somebody else\'s',
    }) as { task: { id: string } }

    // The reachability check is what stands between an agent and any task id it
    // can guess, so a context that cannot see the task must refuse the write.
    const blind: McpToolContext = { ...context, getTask: async () => null }
    const refused = await tool('nessie_task_update').run(blind, {
      taskId: created.task.id,
      title: 'Should not land',
    }) as { error?: string }
    assert.match(String(refused.error), /not found|cannot reach/i)

    const stored = await prisma.task.findUnique({ where: { id: created.task.id } })
    assert.equal(stored?.title, 'Somebody else\'s')
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})
