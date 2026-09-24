import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { TicketChangedStoredConfigSchema } from '@nessie/schemas'

import { TriggerConfigRefusalError } from '../src/trigger-config-refusal.js'
import { createAgentTrigger } from '../src/trigger-create.js'
import { updateAgentTrigger } from '../src/trigger-lifecycle.js'
import { ticketTriggerPickupConflict } from '../src/trigger-ticket-config.js'

/**
 * A `ticket_changed` trigger is resolved on the server and refused field by
 * field (docs/plans/2026-09-23-ticket-driven-agents/triggers.md,
 * "Configuration"; docs/standards/ticket-work.md): the project from the target
 * channel, the board when the project has one, columns by id, name or
 * category, a public ordinary channel the agent is bound to, and at most one
 * enabled trigger picking up from a column — on create, enable and edit.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const INSTRUCTIONS = { general: 'Read the ticket and its comments before you act.' }

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `ticket-config-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `ticket-config-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: owner.id },
  })
  const project = await prisma.project.create({ data: { name: 'Nessie', organizationId: organization.id } })
  const other = await prisma.project.create({ data: { name: 'Elsewhere', organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const board = async (projectId: string, name: string, position: number) => {
    const created = await prisma.board.create({
      data: { isDefault: position === 0, name, organizationId: organization.id, position, projectId },
    })
    const column = (columnName: string, category: 'todo' | 'in_progress' | 'review' | 'done', at: number) =>
      prisma.boardColumn.create({
        data: { boardId: created.id, category, name: columnName, organizationId: organization.id, position: at },
        select: { id: true },
      })
    return {
      id: created.id,
      backlog: (await column('Backlog', 'todo', 0)).id,
      inProgress: (await column('In progress', 'in_progress', 1)).id,
      review: (await column('Review', 'review', 2)).id,
      done: (await column('Done', 'done', 3)).id,
    }
  }
  const engineering = await board(project.id, 'Engineering', 0)
  const foreign = await board(other.id, 'Foreign', 0)
  const channel = (label: string, data: Record<string, unknown> = {}) =>
    prisma.channel.create({
      data: {
        label,
        organizationId: organization.id,
        projectId: project.id,
        slug: `${label}-${suffix}`,
        teamId: team.id,
        visibility: 'public',
        ...data,
      },
      select: { id: true },
    })
  const eng = await channel('eng')
  const secret = await channel('secret', { visibility: 'protected' })
  const archived = await channel('old', { archivedAt: new Date() })
  const unbound = await channel('lobby')
  const agent = async (name: string) => {
    const created = await prisma.agent.create({
      data: { name, organizationId: organization.id, projectId: project.id },
    })
    for (const channelId of [eng.id, secret.id, archived.id]) {
      await prisma.agentBinding.create({ data: { agentId: created.id, channelId } })
    }
    return created.id
  }
  return {
    agentId: await agent('CTO'),
    archivedId: archived.id,
    engId: eng.id,
    engineering,
    foreign,
    organizationId: organization.id,
    ownerId: owner.id,
    projectId: project.id,
    reviewerId: await agent('Reviewer'),
    secretId: secret.id,
    teamId: team.id,
    unboundId: unbound.id,
    cleanup: async () => {
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: owner.id } })
    },
  }
}
type Seed = Awaited<ReturnType<typeof seed>>

const refusalsOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof TriggerConfigRefusalError, `expected a field-level refusal, got ${String(error)}`)
    return error.refusals.map(({ path, reason }) => `${path}: ${reason}`)
  }
  throw new Error('expected the trigger to be refused')
}

const create = (
  prisma: PrismaClient,
  s: Seed,
  config: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  agentId = s.agentId,
) => createAgentTrigger(prisma, agentId, {
  config: { instructions: INSTRUCTIONS, ...config },
  name: 'Pick up tickets',
  targetChannelId: s.engId,
  type: 'ticket_changed',
  ...extra,
}, { authorUserId: s.ownerId })

runDatabaseTest('a ticket trigger resolves its project, board and columns on the server', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))

  // No boardId: the channel's project has one board. Columns by name and by
  // category; endOn by category and by id.
  const trigger = await create(prisma, s, {
    endOn: [{ category: 'done' }, { id: s.engineering.backlog }],
    pickup: { columns: [{ name: 'in PROGRESS' }, { category: 'review' }] },
  })
  assert.ok(trigger)
  const row = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: trigger.id } })
  assert.equal(row.scopeProjectId, s.projectId)
  assert.equal(row.scopeBoardId, s.engineering.id)
  assert.equal(row.targetChannelId, s.engId)
  // One thread per ticket: no fixed thread, so nothing can run it in General.
  assert.equal(row.targetThreadId, null)
  const stored = TicketChangedStoredConfigSchema.parse(row.config)
  assert.equal(stored.boardId, s.engineering.id)
  assert.deepEqual(stored.pickup, { assignOnPickup: true, columnIds: [s.engineering.inProgress, s.engineering.review] })
  assert.deepEqual(stored.endOn, [{ category: 'done' }, { id: s.engineering.backlog }])
  const config = row.config as Record<string, unknown>
  assert.deepEqual(config['limits'], { startsPerDay: 20, wakesPerTicket: 30 })
  assert.deepEqual(config['instructions'], INSTRUCTIONS)
  // Authorship is recorded, grants nothing, and never leaves the server.
  assert.equal(config['authorUserId'], s.ownerId)
  assert.equal(config['createdByUserId'], undefined)
  assert.equal(config['launchOrigin'], undefined)
  assert.equal(trigger.config['authorUserId'], undefined)
})

runDatabaseTest('each wrong field is refused by its path, naming what exists instead', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))
  const columns = '(columns: Backlog, In progress, Review, Done)'

  assert.deepEqual(await refusalsOf(create(prisma, s, { pickup: { columns: [{ name: 'In Progres' }] } })), [
    `pickup.columns[0]: no column "In Progres" on board Engineering ${columns}`,
  ])
  assert.deepEqual(
    await refusalsOf(create(prisma, s, { pickup: { columns: [{ id: s.foreign.inProgress }, { name: 'Done' }] } })),
    [
      `pickup.columns[0]: no column with id ${s.foreign.inProgress} on board Engineering ${columns}`,
      'pickup.columns[1]: column "Done" ends the work (endOn), so it cannot also start it',
    ],
  )
  assert.deepEqual(
    await refusalsOf(create(prisma, s, { endOn: [{ id: s.foreign.done }] })),
    [`endOn[0]: no column with id ${s.foreign.done} on board Engineering ${columns}`],
  )
  assert.deepEqual(await refusalsOf(create(prisma, s, { boardId: s.foreign.id })), [
    'boardId: board Foreign is in another project than #eng (project Nessie); '
    + 'a ticket trigger works a board of its channel\'s project',
  ])
  // The schema's own refusals travel with their paths too.
  assert.deepEqual((await refusalsOf(create(prisma, s, { instructions: undefined, pickUp: {} }))).sort(), [
    'config: Unrecognized key(s) in object: \'pickUp\'',
    'instructions: give the agent standing instructions, at least {"general": "…"}',
  ])
  assert.deepEqual(
    await refusalsOf(create(prisma, s, {}, { nextRunAt: new Date().toISOString(), targetThreadId: randomUUID() })),
    [
      'targetThreadId: a ticket trigger opens one thread per ticket in its channel; give targetChannelId only',
      'nextRunAt: a ticket trigger runs when a ticket changes, not on a schedule',
    ],
  )
  // A second board makes the board a required choice, listed with ids.
  const second = await prisma.board.create({
    data: { name: 'Design', organizationId: s.organizationId, position: 1, projectId: s.projectId },
  })
  assert.deepEqual(await refusalsOf(create(prisma, s, {})), [
    `boardId: project Nessie has 2 boards, so name one: Engineering (boardId=${s.engineering.id}), `
    + `Design (boardId=${second.id})`,
  ])
  assert.equal(await prisma.agentTrigger.count({ where: { agentId: s.agentId } }), 0, 'nothing refused was written')
})

runDatabaseTest('the target channel is live, ordinary, public and has the agent in it', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))
  const target = (targetChannelId: string | undefined) => refusalsOf(create(prisma, s, {}, { targetChannelId }))

  assert.deepEqual(await target(undefined), [
    'targetChannelId: a ticket trigger needs the channel its work threads open in: a public channel of the '
    + 'board\'s project that the agent is bound to',
  ])
  assert.deepEqual(await target(s.secretId), [
    'targetChannelId: #secret is protected. A ticket trigger\'s channel must be public, so that everyone who '
    + 'can read a ticket can open its work thread',
  ])
  assert.deepEqual(await target(s.archivedId), ['targetChannelId: #old is archived; pick a live channel'])
  assert.deepEqual(await target(s.unboundId), ['targetChannelId: CTO is not in #lobby; add it to the channel first'])
  assert.deepEqual(await target(randomUUID()), ['targetChannelId: no such channel in this organisation'])
})

runDatabaseTest('one enabled trigger picks up from a column, on create, enable and edit', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))
  const scope = (triggerId: string) => ({ organizationId: s.organizationId, triggerId })

  const first = await create(prisma, s, { pickup: { columns: [{ category: 'in_progress' }] } })
  assert.ok(first)
  const conflict = `pickup.columns[0]: column "In progress" is already a start-work column of the enabled `
    + `trigger "Pick up tickets" of CTO (triggerId=${first.id}), and two agents would start on the same ticket. `
    + 'Disable that trigger, or pick another column'

  // Create: refused, naming the other trigger.
  assert.deepEqual(
    await refusalsOf(create(prisma, s, { pickup: { columns: [{ name: 'In progress' }] } }, {}, s.reviewerId)),
    [conflict],
  )
  // A disabled second one may exist; enabling it is refused the same way.
  const second = await create(
    prisma,
    s,
    { pickup: { columns: [{ id: s.engineering.inProgress }] } },
    { enabled: false },
    s.reviewerId,
  )
  assert.ok(second)
  assert.equal(second.enabled, false)
  assert.deepEqual(await refusalsOf(updateAgentTrigger(prisma, scope(second.id), { enabled: true })), [conflict])
  assert.equal(await ticketTriggerPickupConflict(prisma as never, { ...second, scopeBoardId: s.engineering.id }), conflict.replace(/^pickup\.columns\[0\]: /, ''))
  // An edit that moves the first trigger off the column frees it.
  const moved = await updateAgentTrigger(prisma, scope(first.id), { config: { pickup: { columns: [{ name: 'Review' }] } } })
  assert.ok(moved)
  const enabled = await updateAgentTrigger(prisma, scope(second.id), { enabled: true })
  assert.equal(enabled?.enabled, true)
  // And editing the first back onto it is refused, naming the second.
  assert.deepEqual(
    (await refusalsOf(updateAgentTrigger(prisma, scope(first.id), { config: { pickup: { columns: [{ category: 'in_progress' }] } } })))
      .map((line) => line.replace(second.id, '<second>')),
    [
      'pickup.columns[0]: column "In progress" is already a start-work column of the enabled trigger '
      + '"Pick up tickets" of Reviewer (triggerId=<second>), and two agents would start on the same ticket. '
      + 'Disable that trigger, or pick another column',
    ],
  )
})

runDatabaseTest('an edit names only what it changes, and the rest is resolved again as stored', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))
  const trigger = await create(prisma, s, {
    follow: { includeSourceEvents: true, kinds: ['comment'] },
    pickup: { assignOnPickup: false, columns: [{ name: 'In progress' }] },
  })
  assert.ok(trigger)
  const scope = { organizationId: s.organizationId, triggerId: trigger.id }

  const renamed = await updateAgentTrigger(prisma, scope, { name: 'CTO pickup' })
  assert.equal(renamed?.name, 'CTO pickup')
  const updated = await updateAgentTrigger(prisma, scope, {
    config: { instructions: { general: 'Be brief.', onPickup: 'Comment a plan.' }, limits: { wakesPerTicket: 10 } },
  })
  assert.ok(updated)
  const row = await prisma.agentTrigger.findUniqueOrThrow({ where: { id: trigger.id } })
  const config = row.config as Record<string, unknown>
  assert.deepEqual(config['pickup'], { assignOnPickup: false, columnIds: [s.engineering.inProgress] })
  assert.deepEqual(config['follow'], { includeSourceEvents: true, kinds: ['comment'] })
  assert.deepEqual(config['limits'], { startsPerDay: 20, wakesPerTicket: 10 })
  assert.deepEqual(config['instructions'], { general: 'Be brief.', onPickup: 'Comment a plan.' })
  assert.equal(config['authorUserId'], s.ownerId, 'authorship survives an edit')

  // A nested patch merges one level deep: what it does not name survives.
  await updateAgentTrigger(prisma, scope, { config: { limits: { startsPerDay: 5 } } })
  const nested = await updateAgentTrigger(prisma, scope, {
    config: {
      follow: { kinds: ['comment', 'priority'] },
      instructions: { onTicketChanged: 'Answer the change.' },
      limits: { wakesPerTicket: 50 },
    },
  })
  assert.ok(nested)
  const merged = (await prisma.agentTrigger.findUniqueOrThrow({ where: { id: trigger.id } }))
    .config as Record<string, unknown>
  assert.deepEqual(merged['follow'], { includeSourceEvents: true, kinds: ['comment', 'priority'] }, 'the source opt-in stays')
  assert.deepEqual(merged['limits'], { startsPerDay: 5, wakesPerTicket: 50 }, 'the other limit stays')
  assert.deepEqual(merged['instructions'], {
    general: 'Be brief.', onPickup: 'Comment a plan.', onTicketChanged: 'Answer the change.',
  })
  // The same checks as a create: a channel that is not public is refused.
  assert.deepEqual(await refusalsOf(updateAgentTrigger(prisma, scope, { targetChannelId: s.secretId })), [
    'targetChannelId: #secret is protected. A ticket trigger\'s channel must be public, so that everyone who '
    + 'can read a ticket can open its work thread',
  ])
  // A follow-only trigger: pickup set to null.
  const followOnly = await updateAgentTrigger(prisma, scope, { config: { pickup: null } })
  assert.ok(followOnly)
  assert.equal(
    ((await prisma.agentTrigger.findUniqueOrThrow({ where: { id: trigger.id } })).config as Record<string, unknown>)['pickup'],
    null,
  )
})

runDatabaseTest('the quiet wake is stored as resolved, kept by an edit that does not name it, and turned off by null', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))
  const configOf = async (id: string) =>
    (await prisma.agentTrigger.findUniqueOrThrow({ where: { id } })).config as Record<string, unknown>

  const byDefault = await create(prisma, s, { pickup: { columns: [{ name: 'In progress' }] } })
  assert.ok(byDefault)
  assert.equal((await configOf(byDefault.id))['quietWakeMinutes'], 30)
  const scope = { organizationId: s.organizationId, triggerId: byDefault.id }
  await updateAgentTrigger(prisma, scope, { config: { quietWakeMinutes: 90 } })
  assert.equal((await configOf(byDefault.id))['quietWakeMinutes'], 90)
  await updateAgentTrigger(prisma, scope, { config: { limits: { wakesPerTicket: 12 } } })
  assert.equal((await configOf(byDefault.id))['quietWakeMinutes'], 90, 'an edit that does not name it keeps it')
  await updateAgentTrigger(prisma, scope, { config: { quietWakeMinutes: null } })
  assert.equal((await configOf(byDefault.id))['quietWakeMinutes'], null)
  assert.deepEqual(await refusalsOf(updateAgentTrigger(prisma, scope, { config: { quietWakeMinutes: 5 } })), [
    'quietWakeMinutes: Number must be greater than or equal to 15',
  ])
})
