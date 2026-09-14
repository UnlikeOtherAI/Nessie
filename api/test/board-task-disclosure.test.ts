import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'

import { boardTools } from '../src/mcp/tools/boards.js'
import type { McpToolContext } from '../src/mcp/tool-context.js'
import { registerBoardRoutes } from '../src/routes/boards.js'
import type { RouteDeps } from '../src/routes/types.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

// A task an agent run wrote retains that run's prompt in its title and purpose,
// so its reader must satisfy the run's disclosure basis — which the single-task
// read and the task list already enforce. The board task list and the MCP board
// read returned `listBoardTasks` verbatim, so the same private ticket that 404s
// on its own page was listed on the board.

type Seed = {
  boardId: string
  organizationId: string
  ownerId: string
  projectId: string
  userIds: string[]
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const short = suffix.slice(0, 8)
  const [owner, author] = await Promise.all([
    prisma.user.create({ data: { displayName: 'Owner', email: `board-owner-${suffix}@example.test` } }),
    prisma.user.create({ data: { displayName: 'Author', email: `board-author-${suffix}@example.test` } }),
  ])
  const organization = await prisma.organization.create({ data: { name: `board-disclosure-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'owner', userId: owner.id },
      { organizationId: organization.id, role: 'member', userId: author.id },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `board-project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `board-team-${suffix}`, projectId: project.id } })
  const base = { organizationId: organization.id, projectId: project.id, teamId: team.id, type: 'standard' as const }
  const publicChannel = await prisma.channel.create({
    data: { ...base, label: `work-${short}`, slug: `work-${short}`, visibility: 'public' },
  })
  const privateChannel = await prisma.channel.create({
    data: { ...base, label: `deal-${short}`, slug: `deal-${short}`, visibility: 'private' },
  })
  await prisma.channelMember.create({ data: { channelId: privateChannel.id, userId: author.id } })
  const thread = await prisma.thread.create({ data: { channelId: publicChannel.id } })
  const agent = await prisma.agent.create({
    data: { name: `board-agent-${suffix}`, organizationId: organization.id, projectId: project.id, teamId: team.id },
  })
  const [privateRun, publicRun] = await Promise.all([
    prisma.run.create({ data: { agentId: agent.id, status: 'completed', threadId: thread.id } }),
    prisma.run.create({ data: { agentId: agent.id, status: 'completed', threadId: thread.id } }),
  ])
  // The private run read the private channel; its outputs inherit that basis.
  await prisma.runBasisScope.create({
    data: { organizationId: organization.id, runId: privateRun.id, scopeId: privateChannel.id, scopeType: 'channel' },
  })
  const board = await prisma.board.create({
    data: {
      isDefault: true,
      name: 'Board',
      organizationId: organization.id,
      position: 0,
      projectId: project.id,
    },
  })
  await prisma.task.createMany({
    data: [
      {
        agentId: agent.id,
        organizationId: organization.id,
        projectId: project.id,
        purpose: 'PRIVATE-BOARD-CANARY',
        runId: privateRun.id,
        status: 'inbox',
        title: 'Private board ticket',
      },
      {
        agentId: agent.id,
        organizationId: organization.id,
        projectId: project.id,
        purpose: 'Public detail',
        runId: publicRun.id,
        status: 'inbox',
        title: 'Public board ticket',
      },
      {
        createdByUserId: owner.id,
        organizationId: organization.id,
        projectId: project.id,
        status: 'inbox',
        title: 'Human board ticket',
      },
    ],
  })
  return {
    boardId: board.id,
    organizationId: organization.id,
    ownerId: owner.id,
    projectId: project.id,
    userIds: [owner.id, author.id],
  }
}

const actorContextFor = (s: Seed) => ({
  actionContext: { requestId: randomUUID(), uoaIdentity: undefined },
  actor: { actorId: s.ownerId, actorType: 'user', roles: ['owner'] },
  tenant: { organizationId: s.organizationId, projectId: s.projectId },
})

runDatabaseTest('the board task list withholds a run-derived task the viewer may not read', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  const app = Fastify()
  t.after(async () => {
    await app.close()
    await prisma.organization.deleteMany({ where: { id: s.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: s.userIds } } })
    await prisma.$disconnect()
  })

  registerBoardRoutes(app, {
    isProjectAccessibleToActor: async () => true,
    prisma,
    requireActorContext: () => actorContextFor(s),
    requireProjectAdmin: async () => true,
  } as unknown as RouteDeps)
  await app.ready()

  const response = await app.inject({
    method: 'GET',
    url: `/api/projects/${s.projectId}/boards/${s.boardId}/tasks`,
  })
  assert.equal(response.statusCode, 200, response.body)
  const titles = (JSON.parse(response.body).data.tasks as { title: string }[])
    .map((task) => task.title)
    .sort()
  assert.ok(!response.body.includes('PRIVATE-BOARD-CANARY'), 'the private run prompt reached the board')
  assert.deepEqual(titles, ['Human board ticket', 'Public board ticket'])
})

runDatabaseTest('the MCP board read withholds the same run-derived task', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: s.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: s.userIds } } })
    await prisma.$disconnect()
  })

  const tool = boardTools().find((candidate) => candidate.name === 'nessie_board_get')
  assert.ok(tool)
  const result = await tool.run(
    {
      actorContext: actorContextFor(s),
      isProjectAccessibleToActor: async () => true,
      prisma,
      scopes: ['boards_read'],
    } as unknown as McpToolContext,
    { boardId: s.boardId, projectId: s.projectId },
  ) as { tasks: { title: string }[] }

  assert.ok(!JSON.stringify(result).includes('PRIVATE-BOARD-CANARY'), 'the private run prompt reached the MCP read')
  assert.deepEqual(result.tasks.map((task) => task.title).sort(), ['Human board ticket', 'Public board ticket'])
})
