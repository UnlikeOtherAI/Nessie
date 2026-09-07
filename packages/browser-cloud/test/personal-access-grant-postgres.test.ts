import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  BROWSER_ACT_TOOL_ID,
  BROWSER_DOWNLOAD_TOOL_ID,
  BROWSER_OBSERVE_TOOL_ID,
  BROWSER_OPEN_TOOL_ID,
} from '@nessie/runtime'

import type { BrowserbaseClient } from '../src/browserbase-client.js'
import {
  activatePersonalBrowserAccessGrant,
  adoptPersonalBrowserAccessGrant,
  createPersonalBrowserAccessGrant,
  hasPendingPersonalBrowserAccess,
  revokePersonalBrowserAccessGrant,
  validatePersonalBrowserAccess,
} from '../src/personal-access-grant.js'
import { claimSessionControl } from '../src/session-control.js'
import { cloudBrowserSettings } from '../src/session-lifecycle.js'
import type { CloudBrowserDeps } from '../src/session-lifecycle.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const AUTH_SECRET = 'personal-access-grant-test-secret'
const policy = {
  [BROWSER_ACT_TOOL_ID]: true,
  [BROWSER_DOWNLOAD_TOOL_ID]: true,
  [BROWSER_OBSERVE_TOOL_ID]: true,
  [BROWSER_OPEN_TOOL_ID]: true,
}

type Seed = {
  agentId: string
  organizationId: string
  runId: string
  threadId: string
  userId: string
  cleanup: () => Promise<void>
}

const seedPrivateHome = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `grant-${suffix}` } })
  const user = await prisma.user.create({
    data: { displayName: 'Grant owner', email: `grant-${suffix}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: user.id },
  })
  const project = await prisma.project.create({ data: { name: `p-${suffix}`, organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: `t-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `private-${suffix}`,
      organizationId: organization.id,
      type: 'dm',
      projectId: project.id,
      slug: `private-${suffix.slice(0, 8)}`,
      teamId: team.id,
      visibility: 'private',
    },
  })
  await prisma.channelMember.create({ data: { channelId: channel.id, userId: user.id } })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: {
      name: `private-${suffix}`,
      organizationId: organization.id,
      ownerUserId: user.id,
      projectId: project.id,
      teamId: team.id,
      toolPolicy: policy,
      visibility: 'private',
    },
  })
  await prisma.channel.update({
    where: { id: channel.id },
    data: { dmKey: `agent:${organization.id}:${user.id}:${agent.id}` },
  })
  await prisma.agentBinding.create({
    data: { agentId: agent.id, channelId: channel.id, principalUserId: null },
  })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'waiting_input', threadId: thread.id },
  })
  await prisma.cloudBrowserConnection.create({
    data: {
      apiKeyRef: `secret_test_${suffix}`,
      createdByUserId: user.id,
      organizationId: organization.id,
      scope: 'user',
      userId: user.id,
    },
  })
  return {
    agentId: agent.id,
    organizationId: organization.id,
    runId: run.id,
    threadId: thread.id,
    userId: user.id,
    cleanup: async () => {
      await prisma.organization.delete({ where: { id: organization.id } })
      await prisma.user.delete({ where: { id: user.id } })
    },
  }
}

const depsFor = (prisma: PrismaClient, ended: string[]): CloudBrowserDeps => ({
  clientFactory: () => ({
    createSession: async () => ({
      connectUrl: 'wss://connect.browserbase.com/personal-grant',
      id: `bb-${randomUUID()}`,
      status: 'RUNNING',
    }),
    endSession: async (sessionId) => { ended.push(sessionId) },
    liveView: async () => ({ debuggerFullscreenUrl: 'https://browserbase.example.test', pages: [] }),
  }) satisfies BrowserbaseClient,
  encryptionSecret: AUTH_SECRET,
  prisma,
  resolveSecret: async () => 'browserbase-key',
})

const createGrant = (prisma: PrismaClient, seed: Seed) =>
  createPersonalBrowserAccessGrant(prisma, {
    agentId: seed.agentId,
    expiresAt: new Date(Date.now() + 60_000),
    organizationId: seed.organizationId,
    origins: ['https://app.example.test'],
    runId: seed.runId,
    threadId: seed.threadId,
    userId: seed.userId,
  })

const createLongGrant = (prisma: PrismaClient, seed: Seed) =>
  createPersonalBrowserAccessGrant(prisma, {
    agentId: seed.agentId,
    expiresAt: new Date(Date.now() + 6 * 60 * 1000),
    organizationId: seed.organizationId,
    origins: ['https://app.example.test'],
    runId: seed.runId,
    threadId: seed.threadId,
    userId: seed.userId,
  })

runDatabaseTest('a fresh personal connection activates a no-context private grant', async () => {
  const prisma = new PrismaClient()
  const seed = await seedPrivateHome(prisma)
  const ended: string[] = []
  try {
    const grant = await createGrant(prisma, seed)
    const activated = await activatePersonalBrowserAccessGrant(depsFor(prisma, ended), {
      grantId: grant.grantId,
      userId: seed.userId,
    })
    const recovered = await activatePersonalBrowserAccessGrant(depsFor(prisma, ended), {
      grantId: grant.grantId,
      userId: seed.userId,
    })
    const session = await prisma.cloudBrowserSession.findUniqueOrThrow({ where: { id: activated.sessionId } })

    assert.equal(recovered.sessionId, activated.sessionId)
    assert.equal(session.agentBrowserId, null)
    assert.equal(session.interactionTransport, 'mediated')
    assert.equal(activated.initialOrigin, 'https://app.example.test')
    assert.equal(await prisma.agentBrowser.count({ where: { agentId: seed.agentId } }), 0)
    assert.equal(ended.length, 0)
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('a temporary grant honors its deadline beyond the resume idle window', async () => {
  const prisma = new PrismaClient()
  const seed = await seedPrivateHome(prisma)
  const ended: string[] = []
  try {
    const grant = await createLongGrant(prisma, seed)
    const activated = await activatePersonalBrowserAccessGrant(depsFor(prisma, ended), {
      grantId: grant.grantId,
      userId: seed.userId,
    })
    const session = await prisma.cloudBrowserSession.findUniqueOrThrow({
      where: { id: activated.sessionId },
      select: { expiresAt: true, startedAt: true },
    })

    assert.equal(activated.expiresAt.getTime(), grant.expiresAt.getTime())
    assert.equal(session.expiresAt.getTime(), grant.expiresAt.getTime())
    const settings = cloudBrowserSettings()
    if (settings.ttlMs > settings.resumeIdleMs) {
      assert.ok(
        session.expiresAt.getTime() - session.startedAt.getTime() > settings.resumeIdleMs,
        'a temporary grant cannot be shortened to the ordinary resume idle window',
      )
    }
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('only the canonical private home owner can take temporary browser control', async () => {
  const prisma = new PrismaClient()
  const seed = await seedPrivateHome(prisma)
  const ended: string[] = []
  try {
    const grant = await createGrant(prisma, seed)
    const activated = await activatePersonalBrowserAccessGrant(depsFor(prisma, ended), {
      grantId: grant.grantId,
      userId: seed.userId,
    })

    assert.equal(await claimSessionControl(prisma, {
      sessionId: activated.sessionId,
      userId: seed.userId,
    }), true)
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('a run that terminalizes during provider allocation cannot activate its grant', async () => {
  const prisma = new PrismaClient()
  const seed = await seedPrivateHome(prisma)
  const ended: string[] = []
  let allowCreate: (() => void) | undefined
  let startedCreate: (() => void) | undefined
  const createAllowed = new Promise<void>((resolve) => { allowCreate = resolve })
  const createStarted = new Promise<void>((resolve) => { startedCreate = resolve })
  const deps: CloudBrowserDeps = {
    ...depsFor(prisma, ended),
    clientFactory: () => ({
      createSession: async () => {
        startedCreate?.()
        await createAllowed
        return {
          connectUrl: 'wss://connect.browserbase.com/personal-grant',
          id: `bb-${randomUUID()}`,
          status: 'RUNNING',
        }
      },
      endSession: async (sessionId) => { ended.push(sessionId) },
      liveView: async () => ({ debuggerFullscreenUrl: 'https://browserbase.example.test', pages: [] }),
    }),
  }
  try {
    const grant = await createGrant(prisma, seed)
    const activation = activatePersonalBrowserAccessGrant(deps, {
      grantId: grant.grantId,
      userId: seed.userId,
    })
    await createStarted
    await prisma.run.update({ where: { id: seed.runId }, data: { status: 'cancelled' } })
    allowCreate?.()

    await assert.rejects(() => activation)
    const stored = await prisma.browserPersonalAccessGrant.findUniqueOrThrow({
      where: { id: grant.grantId },
      select: { sessionId: true, status: true },
    })
    assert.equal(stored.status, 'pending')
    assert.equal(stored.sessionId, null)
    assert.equal(ended.length, 1)
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('a revoked grant cannot fall back to a durable browser in its run', async () => {
  const prisma = new PrismaClient()
  const seed = await seedPrivateHome(prisma)
  const ended: string[] = []
  try {
    const grant = await createGrant(prisma, seed)
    await revokePersonalBrowserAccessGrant(depsFor(prisma, ended), {
      grantId: grant.grantId,
      releasedBy: 'test',
    })

    assert.equal(await hasPendingPersonalBrowserAccess(prisma, seed), true)
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('an active grant fails closed after its owner loses membership', async () => {
  const prisma = new PrismaClient()
  const seed = await seedPrivateHome(prisma)
  const ended: string[] = []
  try {
    const grant = await createGrant(prisma, seed)
    const activated = await activatePersonalBrowserAccessGrant(depsFor(prisma, ended), {
      grantId: grant.grantId,
      userId: seed.userId,
    })
    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId: seed.organizationId, userId: seed.userId } },
      data: { deactivatedAt: new Date() },
    })

    await assert.rejects(() => validatePersonalBrowserAccess(prisma, {
      agentId: seed.agentId,
      runId: seed.runId,
      sessionId: activated.sessionId,
      threadId: seed.threadId,
      toolId: BROWSER_OBSERVE_TOOL_ID,
    }))
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})


runDatabaseTest('only one concurrent activation links a grant and releases the losing session', async () => {
  const prisma = new PrismaClient()
  const seed = await seedPrivateHome(prisma)
  const ended: string[] = []
  try {
    const grant = await createGrant(prisma, seed)
    const results = await Promise.allSettled([
      activatePersonalBrowserAccessGrant(depsFor(prisma, ended), { grantId: grant.grantId, userId: seed.userId }),
      activatePersonalBrowserAccessGrant(depsFor(prisma, ended), { grantId: grant.grantId, userId: seed.userId }),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
    const active = await prisma.browserPersonalAccessGrant.findUniqueOrThrow({
      where: { id: grant.grantId }, select: { sessionId: true, status: true },
    })
    assert.equal(active.status, 'active')
    assert.ok(active.sessionId)
    assert.equal(ended.length, 1)
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('adoption rejects a terminal or unrelated successor run', async () => {
  const prisma = new PrismaClient()
  const seed = await seedPrivateHome(prisma)
  const ended: string[] = []
  try {
    const grant = await createGrant(prisma, seed)
    const activated = await activatePersonalBrowserAccessGrant(depsFor(prisma, ended), {
      grantId: grant.grantId,
      userId: seed.userId,
    })
    const successor = await prisma.run.create({
      data: {
        agentId: seed.agentId,
        continuationOfRunId: seed.runId,
        status: 'cancelled',
        threadId: seed.threadId,
      },
    })
    assert.equal(await prisma.$transaction((tx) => adoptPersonalBrowserAccessGrant(tx, {
      expectedOriginalRunId: seed.runId,
      grantId: grant.grantId,
      runId: successor.id,
      threadId: seed.threadId,
      userId: seed.userId,
    })), null)
    const session = await prisma.cloudBrowserSession.findUniqueOrThrow({ where: { id: activated.sessionId } })
    assert.equal(session.runId, null)
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('only one concurrent adoption attaches the human session to its waiting run', async () => {
  const prisma = new PrismaClient()
  const seed = await seedPrivateHome(prisma)
  const ended: string[] = []
  try {
    const grant = await createGrant(prisma, seed)
    const activated = await activatePersonalBrowserAccessGrant(depsFor(prisma, ended), {
      grantId: grant.grantId,
      userId: seed.userId,
    })
    const successor = await prisma.run.create({
      data: {
        agentId: seed.agentId,
        continuationOfRunId: seed.runId,
        threadId: seed.threadId,
      },
    })
    const adopted = await Promise.all([
      prisma.$transaction((tx) => adoptPersonalBrowserAccessGrant(tx, {
        expectedOriginalRunId: seed.runId,
        grantId: grant.grantId,
        runId: successor.id,
        threadId: seed.threadId,
        userId: seed.userId,
      })),
      prisma.$transaction((tx) => adoptPersonalBrowserAccessGrant(tx, {
        expectedOriginalRunId: seed.runId,
        grantId: grant.grantId,
        runId: successor.id,
        threadId: seed.threadId,
        userId: seed.userId,
      })),
    ])
    assert.equal(adopted.filter((result) => result?.sessionId === activated.sessionId).length, 1)
    assert.equal(adopted.filter((result) => result === null).length, 1)
    const session = await prisma.cloudBrowserSession.findUniqueOrThrow({ where: { id: activated.sessionId } })
    assert.equal(session.runId, successor.id)
    const movedGrant = await prisma.browserPersonalAccessGrant.findUniqueOrThrow({
      where: { id: grant.grantId }, select: { runId: true },
    })
    assert.equal(movedGrant.runId, successor.id)
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('an active grant refuses a separately disabled browser verb', async () => {
  const prisma = new PrismaClient()
  const seed = await seedPrivateHome(prisma)
  const ended: string[] = []
  try {
    const grant = await createGrant(prisma, seed)
    const activated = await activatePersonalBrowserAccessGrant(depsFor(prisma, ended), {
      grantId: grant.grantId,
      userId: seed.userId,
    })
    await prisma.agent.update({
      where: { id: seed.agentId },
      data: { toolPolicy: { [BROWSER_OBSERVE_TOOL_ID]: true, [BROWSER_OPEN_TOOL_ID]: true } },
    })

    await assert.rejects(() => validatePersonalBrowserAccess(prisma, {
      agentId: seed.agentId,
      runId: seed.runId,
      sessionId: activated.sessionId,
      threadId: seed.threadId,
      toolId: BROWSER_ACT_TOOL_ID,
    }))
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('cancelling during provider open leaves no active personal session', async () => {
  const prisma = new PrismaClient()
  const seed = await seedPrivateHome(prisma)
  const ended: string[] = []
  let allowCreate: (() => void) | undefined
  let startedCreate: (() => void) | undefined
  const createAllowed = new Promise<void>((resolve) => { allowCreate = resolve })
  const createStarted = new Promise<void>((resolve) => { startedCreate = resolve })
  const deps: CloudBrowserDeps = {
    ...depsFor(prisma, ended),
    clientFactory: () => ({
      createSession: async () => {
        startedCreate?.()
        await createAllowed
        return {
          connectUrl: 'wss://connect.browserbase.com/personal-grant',
          id: `bb-${randomUUID()}`,
          status: 'RUNNING',
        }
      },
      endSession: async (sessionId) => { ended.push(sessionId) },
      liveView: async () => ({ debuggerFullscreenUrl: 'https://browserbase.example.test', pages: [] }),
    }),
  }
  try {
    const grant = await createGrant(prisma, seed)
    const activation = activatePersonalBrowserAccessGrant(deps, {
      grantId: grant.grantId,
      userId: seed.userId,
    })
    await createStarted
    await revokePersonalBrowserAccessGrant(deps, { grantId: grant.grantId, releasedBy: 'test_cancel' })
    allowCreate?.()

    await assert.rejects(() => activation)
    const row = await prisma.browserPersonalAccessGrant.findUniqueOrThrow({ where: { id: grant.grantId } })
    assert.equal(row.status, 'revoked')
    assert.equal(row.sessionId, null)
    assert.equal(ended.length, 1)
  } finally {
    await seed.cleanup()
    await prisma.$disconnect()
  }
})
