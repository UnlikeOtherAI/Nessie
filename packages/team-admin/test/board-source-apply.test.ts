import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { type NormalisedItem, itemFingerprint } from '@nessie/board-sources'

import { applyInboundItem, type BoardSourceApplyContext } from '../src/board-source-apply.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const item = (over: Partial<NormalisedItem> = {}): NormalisedItem => ({
  externalId: 'linear-issue-1',
  externalKey: 'ENG-1',
  url: 'https://linear.app/acme/issue/ENG-1',
  title: 'Ship the mirror',
  description: 'From upstream',
  stateId: 'state-todo',
  stateName: 'Todo',
  assignee: null,
  priority: 'high',
  dueDate: null,
  labels: [],
  fields: {},
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  archived: false,
  ...over,
})

type Seed = {
  organizationId: string
  projectId: string
  sourceId: string
  connectionId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Source tester', email: `source-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `sources-${suffix}` } })
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
  const source = await prisma.boardSource.create({
    data: {
      projectId: project.id,
      organizationId: organization.id,
      connectionId: connection.id,
      provider: 'linear',
      name: 'Engineering',
      container: { teamId: 'team-1' },
      containerKey: 'team-1',
      createdByUserId: user.id,
    },
  })
  return {
    organizationId: organization.id,
    projectId: project.id,
    sourceId: source.id,
    connectionId: connection.id,
    userId: user.id,
  }
}

const context = (seeded: Seed, over: Partial<BoardSourceApplyContext> = {}): BoardSourceApplyContext => ({
  id: seeded.sourceId,
  organizationId: seeded.organizationId,
  projectId: seeded.projectId,
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
  ...over,
})

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: seeded.userId } })
}

runDatabaseTest('an external item becomes an ordinary task with a link', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const outcome = await applyInboundItem(prisma, context(seeded), item())
    assert.equal(outcome.applied, 'created')

    const task = await prisma.task.findFirstOrThrow({
      where: { projectId: seeded.projectId },
      include: { externalLink: true },
    })
    assert.equal(task.title, 'Ship the mirror')
    assert.equal(task.detail, 'From upstream')
    // `todo` with nobody on it is `inbox`, which is what the board's To do
    // column shows — the same status a native task would carry.
    assert.equal(task.status, 'inbox')
    assert.equal(task.externalLink?.externalKey, 'ENG-1')
    assert.equal(task.externalLink?.remoteStateName, 'Todo')
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('re-applying an unchanged item writes no event', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await applyInboundItem(prisma, context(seeded), item())
    const second = await applyInboundItem(prisma, context(seeded), item())
    assert.equal(second.applied, 'unchanged')
    assert.equal(await prisma.taskEvent.count({ where: { taskId: second.taskId } }), 0)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

// The mechanism the whole write-back design rests on: after we change something
// upstream, the webhook it triggers must be recognised as our own rather than
// applied as if somebody else had made it.
runDatabaseTest('our own write coming back is an echo, not a change', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await applyInboundItem(prisma, context(seeded), item())
    const moved = item({ stateId: 'state-done', stateName: 'Done' })

    // Stamp the outbound fingerprint the way a write-back does.
    await prisma.taskExternalLink.update({
      where: {
        sourceId_externalId: { sourceId: seeded.sourceId, externalId: moved.externalId },
      },
      data: { outboundFingerprint: itemFingerprint(moved, []) },
    })
    const eventsBefore = await prisma.taskEvent.count()

    const outcome = await applyInboundItem(prisma, context(seeded), moved)
    assert.equal(outcome.applied, 'echo')
    assert.equal(await prisma.taskEvent.count(), eventsBefore)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a real upstream change moves the task and records who moved it', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const created = await applyInboundItem(prisma, context(seeded), item())
    const outcome = await applyInboundItem(
      prisma,
      context(seeded),
      item({ stateId: 'state-done', stateName: 'Done', updatedAt: '2026-09-03T00:00:00.000Z' }),
    )
    assert.equal(outcome.applied, 'updated')

    const task = await prisma.task.findUniqueOrThrow({ where: { id: created.taskId } })
    assert.equal(task.status, 'done')

    // The vendor is the authority for its own item, so this bypasses the
    // transition rules — but it still says who did it and from what.
    const events = await prisma.taskEvent.findMany({ where: { taskId: created.taskId } })
    assert.equal(events.length, 1)
    const payload = events[0]?.payload as Record<string, unknown>
    assert.equal(payload.bySourceId, seeded.sourceId)
    assert.equal(payload.from, 'inbox')
    assert.equal(payload.to, 'done')
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

// Nothing guesses what an unmapped state means. The source says so, and a
// person maps it — docs/standards/capability-health-alerts.md.
runDatabaseTest('a state nobody mapped is reported rather than guessed', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const outcome = await applyInboundItem(
      prisma,
      context(seeded),
      item({ stateId: 'state-triage', stateName: 'Needs triage' }),
    )
    assert.deepEqual(outcome, { applied: 'unmapped_state', stateName: 'Needs triage' })
    assert.equal(await prisma.task.count({ where: { projectId: seeded.projectId } }), 0)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an assignee resolves through the identity link, or is kept as display data', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const assigned = item({
      assignee: { externalUserId: 'linear-user-1', displayName: 'Alice Upstream' },
    })

    // With no link, the provider's own name is kept on the link so the card can
    // say who it is — and no Nessie person is invented for them.
    const first = await applyInboundItem(prisma, context(seeded), assigned)
    let task = await prisma.task.findUniqueOrThrow({
      where: { id: first.taskId },
      include: { externalLink: true },
    })
    assert.equal(task.assigneeUserId, null)
    assert.equal(task.externalLink?.remoteAssigneeDisplay, 'Alice Upstream')
    assert.equal(task.status, 'inbox')

    // With a link, it is a real assignment — and `todo` with somebody on it is
    // `assigned`, not `inbox`.
    const linked = context(seeded, {
      identityByExternalUserId: new Map([
        ['linear-user-1', { userId: seeded.userId, agentId: null }],
      ]),
    })
    const second = await applyInboundItem(
      prisma,
      linked,
      item({
        assignee: { externalUserId: 'linear-user-1', displayName: 'Alice Upstream' },
        updatedAt: '2026-09-04T00:00:00.000Z',
        title: 'Ship the mirror (updated)',
      }),
    )
    task = await prisma.task.findUniqueOrThrow({
      where: { id: second.taskId },
      include: { externalLink: true },
    })
    assert.equal(task.assigneeUserId, seeded.userId)
    assert.equal(task.status, 'assigned')
    assert.equal(task.externalLink?.remoteAssigneeDisplay, null)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an item cancelled upstream leaves the board', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const created = await applyInboundItem(prisma, context(seeded), item())
    await applyInboundItem(
      prisma,
      context(seeded),
      item({ archived: true, updatedAt: '2026-09-05T00:00:00.000Z' }),
    )
    const task = await prisma.task.findUniqueOrThrow({ where: { id: created.taskId } })
    assert.equal(task.status, 'cancelled')
    assert.notEqual(task.archivedAt, null)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('mapped fields land on native columns and custom fields', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const definition = await prisma.taskFieldDefinition.create({
      data: {
        projectId: seeded.projectId,
        organizationId: seeded.organizationId,
        name: 'Estimate',
        type: 'number',
        position: 0,
      },
    })
    const mapped = context(seeded, {
      fieldMappings: [
        { externalKey: 'points', externalLabel: 'Points', target: 'native:storyPoints' },
        {
          externalKey: 'estimate',
          externalLabel: 'Estimate',
          target: `field:${definition.id}`,
        },
      ],
    })

    const outcome = await applyInboundItem(
      prisma,
      mapped,
      item({ fields: { points: 8, estimate: 3 } }),
    )
    const task = await prisma.task.findUniqueOrThrow({ where: { id: outcome.taskId } })
    assert.equal(task.storyPoints, 8)
    assert.deepEqual(task.fieldValues, { [definition.id]: 3 })
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('two workers applying one new item create exactly one task', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    // What a provider retry looks like once it has become two queue jobs: two
    // workers apply the same external item at the same instant. The link's
    // unique constraint stops a second *link*, but nothing constrains
    // `(sourceId, externalId)` on `Task`, so before the advisory lock both
    // read "no link", both inserted, and the loser's task was an orphan on
    // nobody's board (audit 9.1).
    const outcomes = await Promise.all([
      applyInboundItem(prisma, context(seeded), item()),
      applyInboundItem(prisma, context(seeded), item()),
      applyInboundItem(prisma, context(seeded), item()),
      applyInboundItem(prisma, context(seeded), item()),
    ])

    const tasks = await prisma.task.findMany({ where: { projectId: seeded.projectId } })
    assert.equal(tasks.length, 1, 'one external item is one task, however many appliers race')
    const links = await prisma.taskExternalLink.findMany({ where: { sourceId: seeded.sourceId } })
    assert.equal(links.length, 1)
    assert.equal(links[0]?.taskId, tasks[0]?.id, 'the surviving link points at the surviving task')
    // Every applier reports the same task, so no caller is holding an id that
    // is about to stop existing.
    for (const outcome of outcomes) {
      assert.equal('taskId' in outcome ? outcome.taskId : null, tasks[0]?.id)
    }
    // Exactly one of them created it; the rest saw the first's work.
    assert.equal(outcomes.filter((outcome) => outcome.applied === 'created').length, 1)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
