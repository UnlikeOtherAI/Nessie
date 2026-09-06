import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  claimBoardWatchNotification,
  resolveBoardWatchRecipients,
  type BoardWatchEvent,
} from '../src/board-watch-notify.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  projectId: string
  boardId: string
  secondBoardId: string
  taskId: string
  watcherUserId: string
  outsiderUserId: string
  ownerUserId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `owner-${suffix}@example.test` },
  })
  const watcher = await prisma.user.create({
    data: { displayName: 'Watcher', email: `watcher-${suffix}@example.test` },
  })
  // In the organisation, but not a member of the project — so entitled to
  // nothing on this board.
  const outsider = await prisma.user.create({
    data: { displayName: 'Outsider', email: `outsider-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `watch-${suffix}` } })
  for (const [user, role] of [[owner, 'owner'], [watcher, 'member'], [outsider, 'member']] as const) {
    await prisma.organizationMember.create({
      data: { organizationId: organization.id, userId: user.id, role },
    })
  }
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  await prisma.projectMember.create({
    data: { projectId: project.id, userId: watcher.id, role: 'member' },
  })
  const board = await prisma.board.create({
    data: {
      projectId: project.id,
      organizationId: organization.id,
      name: 'Board',
      isDefault: true,
      position: 0,
    },
  })
  const secondBoard = await prisma.board.create({
    data: {
      projectId: project.id,
      organizationId: organization.id,
      name: 'Second view',
      // Only one default per project (partial unique index). This matters more
      // than it looks: `boardTaskPoolWhere` gives the default board every task
      // with a null `board_id` and a non-default board only its own, so a task
      // belongs to exactly one board's pool.
      isDefault: false,
      position: 1,
    },
  })
  const task = await prisma.task.create({
    data: {
      organizationId: organization.id,
      projectId: project.id,
      title: 'A mirrored ticket',
      priority: 'medium',
    },
  })
  return {
    organizationId: organization.id,
    projectId: project.id,
    boardId: board.id,
    secondBoardId: secondBoard.id,
    taskId: task.id,
    watcherUserId: watcher.id,
    outsiderUserId: outsider.id,
    ownerUserId: owner.id,
  }
}

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({
    where: { id: { in: [seeded.watcherUserId, seeded.outsiderUserId, seeded.ownerUserId] } },
  })
}

const event = (seeded: Seed, over: Partial<BoardWatchEvent> = {}): BoardWatchEvent => ({
  taskId: seeded.taskId,
  projectId: seeded.projectId,
  organizationId: seeded.organizationId,
  fingerprint: 'fp-1',
  changes: ['status'],
  ...over,
})

runDatabaseTest('one change is claimed once, however many deliveries carry it', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    // A sweep page and a webhook can both apply the same item: the notify runs
    // after the apply transaction commits, so nothing else keys on it.
    assert.equal(await claimBoardWatchNotification(prisma, event(seeded)), true)
    assert.equal(await claimBoardWatchNotification(prisma, event(seeded)), false)
    // A genuinely different change is a different telling.
    assert.equal(
      await claimBoardWatchNotification(prisma, event(seeded, { fingerprint: 'fp-2' })),
      true,
    )
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a board with no watchers tells nobody', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    assert.deepEqual(await resolveBoardWatchRecipients(prisma, [event(seeded)]), [])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a watcher entitled to the task is told once', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await prisma.boardWatcher.create({
      data: {
        boardId: seeded.boardId,
        organizationId: seeded.organizationId,
        userId: seeded.watcherUserId,
        addedByUserId: seeded.ownerUserId,
      },
    })
    const recipients = await resolveBoardWatchRecipients(prisma, [event(seeded)])
    assert.equal(recipients.length, 1)
    assert.deepEqual(recipients[0]?.taskIds, [seeded.taskId])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a watcher on a board the task is not on hears nothing', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    // The task has a null `board_id`, so it is on the default board's pool and
    // not on this one. Watching a board is watching what that board shows.
    await prisma.boardWatcher.create({
      data: {
        boardId: seeded.secondBoardId,
        organizationId: seeded.organizationId,
        userId: seeded.watcherUserId,
        addedByUserId: seeded.ownerUserId,
      },
    })
    assert.deepEqual(await resolveBoardWatchRecipients(prisma, [event(seeded)]), [])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('one watcher told about two tickets is one recipient, not two', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await prisma.boardWatcher.create({
      data: {
        boardId: seeded.boardId,
        organizationId: seeded.organizationId,
        userId: seeded.watcherUserId,
        addedByUserId: seeded.ownerUserId,
      },
    })
    const second = await prisma.task.create({
      data: {
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        title: 'Another ticket',
        priority: 'medium',
      },
    })
    const recipients = await resolveBoardWatchRecipients(prisma, [
      event(seeded),
      event(seeded, { taskId: second.id, fingerprint: 'fp-2' }),
    ])
    assert.equal(recipients.length, 1)
    assert.equal(recipients[0]?.taskIds.length, 2)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a watcher who cannot read the task is dropped before any write', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await prisma.boardWatcher.create({
      data: {
        boardId: seeded.boardId,
        organizationId: seeded.organizationId,
        userId: seeded.outsiderUserId,
        addedByUserId: seeded.ownerUserId,
      },
    })
    // The alert row, the message and the push all exist before any renderer
    // runs, and a push reaches a lock screen — so the check has to be here,
    // not at render time.
    assert.deepEqual(await resolveBoardWatchRecipients(prisma, [event(seeded)]), [])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a task the board filter hides tells that board nobody', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    // `sources: 'native'` keeps only tasks with no external link. The task in
    // this seed has none, so give it one and it leaves the board.
    await prisma.board.update({
      where: { id: seeded.boardId },
      data: { filter: { sources: 'native' } },
    })
    const connection = await prisma.boardSourceConnection.create({
      data: {
        organizationId: seeded.organizationId,
        ownerUserId: seeded.ownerUserId,
        provider: 'linear',
        externalAccountId: `acct-${randomUUID()}`,
        externalTenantId: `org-${randomUUID()}`,
      },
    })
    const source = await prisma.boardSource.create({
      data: {
        projectId: seeded.projectId,
        organizationId: seeded.organizationId,
        connectionId: connection.id,
        provider: 'linear',
        name: 'Engineering',
        container: { teamId: 'team-1' },
        containerKey: 'team-1',
        createdByUserId: seeded.ownerUserId,
      },
    })
    await prisma.taskExternalLink.create({
      data: {
        organizationId: seeded.organizationId,
        taskId: seeded.taskId,
        sourceId: source.id,
        externalId: 'ext-1',
        externalKey: 'ENG-1',
        externalUrl: 'https://linear.app/acme/issue/ENG-1',
      },
    })
    await prisma.boardWatcher.create({
      data: {
        boardId: seeded.boardId,
        organizationId: seeded.organizationId,
        userId: seeded.watcherUserId,
        addedByUserId: seeded.ownerUserId,
      },
    })
    assert.deepEqual(await resolveBoardWatchRecipients(prisma, [event(seeded)]), [])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an agent whose reader cannot see the task is dropped too', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    // An agent watcher is woken in a DM a *person* reads, and the kickoff
    // carries ticket titles. So the same entitlement rule the user branch
    // applies has to reach whoever is on the other side of the agent —
    // otherwise the agent branch is a way around it.
    const agent = await prisma.agent.create({
      data: {
        name: 'Triage',
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        role: 'assistant',
        visibility: 'team',
      },
    })
    await prisma.boardWatcher.create({
      data: {
        boardId: seeded.boardId,
        organizationId: seeded.organizationId,
        agentId: agent.id,
        // The outsider is in the organisation but not in this project.
        addedByUserId: seeded.outsiderUserId,
      },
    })
    assert.deepEqual(await resolveBoardWatchRecipients(prisma, [event(seeded)]), [])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
