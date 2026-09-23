import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { PrismaClient } from '@prisma/client'
import { TicketChangedWorkConfigSchema } from '@nessie/schemas'

/**
 * `20260924000000_board_agent_watchers_to_ticket_triggers`, run against rows
 * seeded the way the retired agent-watcher API wrote them
 * (docs/plans/2026-09-23-ticket-driven-agents/triggers.md → "Board watchers").
 *
 * The migration is one `DO` block over every agent watcher row, so running it
 * again here is running it on exactly these rows: the database the suite runs
 * on already applied it, and nothing writes an agent watcher any more.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const migrationSql = readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations/20260924000000_board_agent_watchers_to_ticket_triggers/migration.sql',
), 'utf8')

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const adder = await prisma.user.create({ data: { displayName: 'Adder', email: `adder-${suffix}@example.test` } })
  const other = await prisma.user.create({ data: { displayName: 'Other', email: `other-${suffix}@example.test` } })
  const organization = await prisma.organization.create({ data: { name: `watchers ${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, userId: adder.id, role: 'owner' },
      { organizationId: organization.id, userId: other.id, role: 'member' },
    ],
  })
  const project = await prisma.project.create({ data: { name: `p-${suffix}`, organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: `t-${suffix}`, projectId: project.id } })
  const board = await prisma.board.create({
    data: { isDefault: true, name: 'Engineering', organizationId: organization.id, position: 0, projectId: project.id },
  })
  const channel = (label: string, visibility: 'public' | 'protected') => prisma.channel.create({
    data: {
      label, organizationId: organization.id, projectId: project.id, slug: `${label}-${suffix}`, teamId: team.id, visibility,
    },
  })
  const [publicRoom, protectedRoom] = [await channel('eng', 'public'), await channel('leads', 'protected')]
  const agent = (name: string, extra: Record<string, unknown> = {}) => prisma.agent.create({
    data: { name, organizationId: organization.id, projectId: project.id, role: 'assistant', visibility: 'team', ...extra },
  })
  const bound = await agent('Triage')
  const unbound = await agent('Unplaced')
  const system = await agent('System', { systemManaged: true, systemSlug: `system-${suffix}` })
  const othersPrivate = await agent('Theirs', { ownerUserId: other.id, visibility: 'private' })
  // Bound to a protected room first and the public one after: only a public
  // channel may carry ticket work, whatever was bound first.
  await prisma.agentBinding.create({ data: { agentId: bound.id, channelId: protectedRoom.id } })
  await prisma.agentBinding.create({ data: { agentId: bound.id, channelId: publicRoom.id } })
  await prisma.agentBinding.create({ data: { agentId: unbound.id, channelId: protectedRoom.id } })
  const watcher = (agentId: string) => ({
    addedByUserId: adder.id, agentId, boardId: board.id, organizationId: organization.id,
  })
  await prisma.boardWatcher.createMany({
    data: [
      watcher(bound.id),
      watcher(unbound.id),
      watcher(system.id),
      watcher(othersPrivate.id),
      { addedByUserId: adder.id, boardId: board.id, organizationId: organization.id, userId: other.id },
    ],
  })
  return { adder, board, bound, organization, other, othersPrivate, project, publicRoom, system, unbound }
}

runDatabaseTest('agent watchers become disabled, follow-only ticket triggers and people watchers stay', async () => {
  const prisma = new PrismaClient()
  const world = await seed(prisma)
  try {
    await prisma.$executeRawUnsafe(migrationSql)

    const triggers = await prisma.agentTrigger.findMany({
      where: { agentId: { in: [world.bound.id, world.unbound.id, world.system.id, world.othersPrivate.id] } },
      orderBy: { createdAt: 'asc' },
    })
    // Only the two ordinary agents were ever wakeable, so only they get one.
    assert.deepEqual(triggers.map((trigger) => trigger.agentId).sort(), [world.bound.id, world.unbound.id].sort())
    for (const trigger of triggers) {
      assert.equal(trigger.type, 'ticket_changed')
      assert.equal(trigger.enabled, false)
      assert.equal(trigger.status, 'paused')
      assert.equal(trigger.name, 'Board watcher: Engineering')
      assert.match(trigger.description ?? '', /board watcher Adder added\. It starts no work until/)
      assert.equal(trigger.scopeBoardId, world.board.id)
      assert.equal(trigger.scopeProjectId, world.project.id)
      // The stored form every ticket-trigger reader parses: follow-only, with
      // the defaults, no instructions yet, and the adder as its author.
      const config = TicketChangedWorkConfigSchema.parse(trigger.config)
      assert.equal(config.boardId, world.board.id)
      assert.equal(config.pickup, null)
      assert.deepEqual(config.follow, {
        includeSourceEvents: false,
        kinds: ['comment', 'description', 'moved', 'thread_message', 'document'],
      })
      assert.deepEqual(config.endOn, [{ category: 'todo' }, { category: 'done' }])
      assert.deepEqual(config.limits, { startsPerDay: 20, wakesPerTicket: 30 })
      assert.equal(config.instructions, undefined)
      assert.equal((trigger.config as Record<string, unknown>).authorUserId, world.adder.id)
    }
    const byAgent = new Map(triggers.map((trigger) => [trigger.agentId, trigger]))
    assert.equal(byAgent.get(world.bound.id)?.targetChannelId, world.publicRoom.id, 'the public project channel')
    assert.equal(byAgent.get(world.unbound.id)?.targetChannelId, null, 'no public channel: left for the editor')

    const left = await prisma.boardWatcher.findMany({ where: { boardId: world.board.id } })
    assert.deepEqual(left.map((row) => [row.userId, row.agentId]), [[world.other.id, null]])
  } finally {
    await prisma.organization.deleteMany({ where: { id: world.organization.id } })
    await prisma.user.deleteMany({ where: { id: { in: [world.adder.id, world.other.id] } } })
    await prisma.$disconnect()
  }
})
