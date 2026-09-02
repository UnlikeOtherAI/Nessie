import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import type { BrowserbaseClient } from '../src/browserbase-client.js'
import {
  openCloudBrowserSession,
  reapExpiredCloudBrowserSessions,
  releaseSessionsForRun,
  resolveConnectionForRun,
  type CloudBrowserDeps,
} from '../src/session-lifecycle.js'

/**
 * The claims here all cost money or correctness if they are wrong: a second
 * concurrent session on one context makes websites force logouts, a session
 * nobody releases bills until its own timeout, and a personal connection used
 * by an unattended run spends an individual's allowance on a schedule they
 * never asked for. Stubs cannot check any of them — the guarantees live in
 * partial unique indexes and an advisory lock.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  userId: string
  otherUserId: string
  agentId: string
  threadId: string
  runId: string
  cleanup: () => Promise<void>
}

const seedWorkspace = async (prisma: PrismaClient, label: string): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `${label} ${suffix}` },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Owner', email: `owner-${suffix}@example.com` },
  })
  const otherUser = await prisma.user.create({
    data: { displayName: 'Colleague', email: `other-${suffix}@example.com` },
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, userId: user.id, role: 'owner' },
      { organizationId: organization.id, userId: otherUser.id, role: 'member' },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `p-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `t-${suffix}`, projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: `c-${suffix}`,
      // A standard channel is required to carry a slug.
      slug: `c-${suffix.slice(0, 8)}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({
    data: { channelId: channel.id, title: 'general' },
  })
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const run = await prisma.run.create({
    data: { agentId: agent.id, threadId: thread.id },
  })

  return {
    organizationId: organization.id,
    userId: user.id,
    otherUserId: otherUser.id,
    agentId: agent.id,
    threadId: thread.id,
    runId: run.id,
    // Scoped to this suite's own seed: a global cleanup would delete rows a
    // concurrently running suite is about to assert on.
    cleanup: async () => {
      await prisma.organization.delete({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: [user.id, otherUser.id] } } })
    },
  }
}

const fakeClient = (calls: string[]): BrowserbaseClient => ({
  createSession: async () => {
    const id = `bb-${randomUUID()}`
    calls.push(`create:${id}`)
    return { id, connectUrl: 'wss://connect.browserbase.com/x', status: 'RUNNING' }
  },
  endSession: async (sessionId) => {
    calls.push(`end:${sessionId}`)
  },
  liveView: async () => ({ debuggerFullscreenUrl: 'https://x.browserbase.com/v', pages: [] }),
})

const depsFor = (prisma: PrismaClient, calls: string[]): CloudBrowserDeps => ({
  prisma,
  resolveSecret: async () => 'bb-api-key',
  clientFactory: () => fakeClient(calls),
})

runDatabaseTest('a run cannot hold two cloud browsers at once', async () => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma, 'browser one-per-run')
  const calls: string[] = []
  const deps = depsFor(prisma, calls)
  try {
    await prisma.cloudBrowserConnection.create({
      data: {
        organizationId: seed.organizationId,
        scope: 'organization',
        projectId: 'proj',
        apiKeyRef: 'secret_browserbase_x',
        createdByUserId: seed.userId,
      },
    })

    const first = await openCloudBrowserSession(deps, {
      organizationId: seed.organizationId,
      runId: seed.runId,
      threadId: seed.threadId,
      agentId: seed.agentId,
      requestedByUserId: seed.userId,
    })
    assert.ok(first.browserbaseSessionId)

    await assert.rejects(
      openCloudBrowserSession(deps, {
        organizationId: seed.organizationId,
        runId: seed.runId,
        threadId: seed.threadId,
        agentId: seed.agentId,
        requestedByUserId: seed.userId,
      }),
      (error: Error & { code?: string }) => error.code === 'CLOUD_BROWSER_SESSION_ALREADY_OPEN',
    )
  } finally {
    await releaseSessionsForRun(deps, { runId: seed.runId, releasedBy: 'test' })
    await seed.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('releasing a run tells the provider to stop the browser', async () => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma, 'browser release')
  const calls: string[] = []
  const deps = depsFor(prisma, calls)
  try {
    await prisma.cloudBrowserConnection.create({
      data: {
        organizationId: seed.organizationId,
        scope: 'organization',
        projectId: 'proj',
        apiKeyRef: 'secret_browserbase_x',
        createdByUserId: seed.userId,
      },
    })
    const opened = await openCloudBrowserSession(deps, {
      organizationId: seed.organizationId,
      runId: seed.runId,
      threadId: seed.threadId,
      agentId: seed.agentId,
      requestedByUserId: seed.userId,
    })

    const released = await releaseSessionsForRun(deps, {
      runId: seed.runId,
      releasedBy: 'run_terminal',
    })

    assert.equal(released, 1)
    // Flipping the row is not enough: a browser nobody told Browserbase to
    // stop keeps billing until its own timeout.
    assert.ok(
      calls.includes(`end:${opened.browserbaseSessionId}`),
      'the provider must be told to stop the session',
    )
    const row = await prisma.cloudBrowserSession.findUnique({
      where: { id: opened.sessionId },
      select: { status: true, releasedBy: true, endedAt: true },
    })
    assert.equal(row?.status, 'released')
    assert.equal(row?.releasedBy, 'run_terminal')
    assert.ok(row?.endedAt)
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('the reaper stops a session whose run crashed', async () => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma, 'browser reaper')
  const calls: string[] = []
  const deps = depsFor(prisma, calls)
  try {
    const connection = await prisma.cloudBrowserConnection.create({
      data: {
        organizationId: seed.organizationId,
        scope: 'organization',
        projectId: 'proj',
        apiKeyRef: 'secret_browserbase_x',
        createdByUserId: seed.userId,
      },
    })
    // A live row already past its TTL: what a crashed worker leaves behind.
    const stranded = await prisma.cloudBrowserSession.create({
      data: {
        organizationId: seed.organizationId,
        connectionId: connection.id,
        runId: seed.runId,
        threadId: seed.threadId,
        agentId: seed.agentId,
        browserbaseSessionId: 'bb-stranded',
        status: 'active',
        expiresAt: new Date(Date.now() - 60_000),
      },
    })

    const reaped = await reapExpiredCloudBrowserSessions(deps, { limit: 10 })

    assert.ok(reaped >= 1)
    assert.ok(calls.includes('end:bb-stranded'), 'the reaper must call the provider')
    const row = await prisma.cloudBrowserSession.findUnique({
      where: { id: stranded.id },
      select: { status: true, releasedBy: true },
    })
    assert.equal(row?.status, 'released')
    assert.equal(row?.releasedBy, 'reaper')
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('an unattended run never spends an individual’s browser hours', async () => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma, 'browser scope')
  try {
    await prisma.cloudBrowserConnection.create({
      data: {
        organizationId: seed.organizationId,
        scope: 'user',
        userId: seed.userId,
        projectId: 'personal',
        apiKeyRef: 'secret_browserbase_personal',
        createdByUserId: seed.userId,
      },
    })

    // The owner's own run resolves their personal connection.
    const mine = await resolveConnectionForRun(prisma, {
      organizationId: seed.organizationId,
      requestedByUserId: seed.userId,
    })
    assert.equal(mine?.scope, 'user')

    // A colleague's run must not reach it.
    const theirs = await resolveConnectionForRun(prisma, {
      organizationId: seed.organizationId,
      requestedByUserId: seed.otherUserId,
    })
    assert.equal(theirs, null)

    // An unattended run has no requester at all, so nothing resolves.
    const unattended = await resolveConnectionForRun(prisma, {
      organizationId: seed.organizationId,
      requestedByUserId: null,
    })
    assert.equal(unattended, null)

    // Once the company subscribes, the organisation connection wins for
    // everyone — including the person who already had their own.
    await prisma.cloudBrowserConnection.create({
      data: {
        organizationId: seed.organizationId,
        scope: 'organization',
        projectId: 'company',
        apiKeyRef: 'secret_browserbase_company',
        createdByUserId: seed.userId,
      },
    })
    const preferred = await resolveConnectionForRun(prisma, {
      organizationId: seed.organizationId,
      requestedByUserId: seed.userId,
    })
    assert.equal(preferred?.scope, 'organization')
    assert.equal(preferred?.projectId, 'company')
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('a needs_attention connection stops resolving for new runs', async () => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma, 'browser health')
  try {
    await prisma.cloudBrowserConnection.create({
      data: {
        organizationId: seed.organizationId,
        scope: 'organization',
        projectId: 'proj',
        apiKeyRef: 'secret_browserbase_x',
        createdByUserId: seed.userId,
        status: 'needs_attention',
        healthReason: 'auth_failed',
      },
    })

    const resolved = await resolveConnectionForRun(prisma, {
      organizationId: seed.organizationId,
      requestedByUserId: seed.userId,
    })

    // A dead key must stop the toolset advertising a browser, rather than
    // failing at the moment somebody actually needs one.
    assert.equal(resolved, null)
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})
