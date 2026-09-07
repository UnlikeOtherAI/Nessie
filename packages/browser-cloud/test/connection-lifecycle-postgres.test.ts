import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import type { BrowserbaseClient } from '../src/browserbase-client.js'
import {
  disconnectCloudBrowser,
  openCloudBrowserSession,
  resetAgentBrowser,
  persistCloudBrowserConnection,
  type CloudBrowserDeps,
} from '../src/index.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const AUTH_SECRET = 'connection-lifecycle-test-secret'
const EMPTY_GATE = { authenticatedOrigins: [], currentUrl: null, touchedAuthenticated: false }

type Seed = {
  agentId: string
  connectionId: string
  oldRef: string
  organizationId: string
  runId: string
  threadId: string
  userId: string
  cleanup: () => Promise<void>
}

const createSecret = async (prisma: PrismaClient, ref: string): Promise<void> => {
  await prisma.mcpOAuthSecret.create({
    data: { authTag: 'tag', ciphertext: 'ciphertext', iv: 'iv', ref },
  })
}

const seed = async (prisma: PrismaClient, label: string): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `${label}-${suffix}` } })
  const user = await prisma.user.create({
    data: { displayName: 'Owner', email: `${label}-${suffix}@example.test` },
  })
  await prisma.organizationMember.create({ data: { organizationId: organization.id, role: 'owner', userId: user.id } })
  const project = await prisma.project.create({ data: { name: `p-${suffix}`, organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: `t-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: { label: `c-${suffix}`, organizationId: organization.id, projectId: project.id, slug: `c-${suffix.slice(0, 8)}`, teamId: team.id },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: { name: `a-${suffix}`, organizationId: organization.id, projectId: project.id, teamId: team.id },
  })
  const run = await prisma.run.create({ data: { agentId: agent.id, threadId: thread.id } })
  const oldRef = `secret_browserbase_${suffix.replaceAll('-', '')}`
  await createSecret(prisma, oldRef)
  const connection = await prisma.cloudBrowserConnection.create({
    data: { apiKeyRef: oldRef, createdByUserId: user.id, organizationId: organization.id, scope: 'organization' },
  })
  return {
    agentId: agent.id,
    connectionId: connection.id,
    oldRef,
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

const depsFor = (prisma: PrismaClient): CloudBrowserDeps => ({
  clientFactory: () => ({
    createSession: async () => ({
      connectUrl: 'wss://connect.browserbase.com/test', id: `bb-${randomUUID()}`, status: 'RUNNING',
    }),
    endSession: async () => undefined,
    liveView: async () => ({ debuggerFullscreenUrl: 'https://browserbase.com/test', pages: [] }),
  }) satisfies BrowserbaseClient,
  encryptionSecret: AUTH_SECRET,
  prisma,
  resolveSecret: async () => 'test-key',
})

runDatabaseTest('replacing a connection removes its old encrypted Browserbase key', async () => {
  const prisma = new PrismaClient()
  const row = await seed(prisma, 'browser-rekey')
  const newRef = `secret_browserbase_new_${randomUUID().replaceAll('-', '')}`
  try {
    await prisma.$transaction(async (tx) => {
      await persistCloudBrowserConnection({
        prisma: tx,
        storeSecret: async () => {
          await tx.mcpOAuthSecret.create({
            data: { authTag: 'tag', ciphertext: 'next', iv: 'iv', ref: newRef },
          })
          return newRef
        },
      }, {
        actingUserId: row.userId,
        apiKey: 'next-key',
        organizationId: row.organizationId,
        scope: 'organization',
        userId: null,
      })
    })
    assert.equal(await prisma.mcpOAuthSecret.count({ where: { ref: row.oldRef } }), 0)
    assert.equal(await prisma.mcpOAuthSecret.count({ where: { ref: newRef } }), 1)
  } finally {
    await row.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('disconnect disables a retained durable browser and deletes only its key', async () => {
  const prisma = new PrismaClient()
  const row = await seed(prisma, 'browser-disconnect')
  try {
    await prisma.agentBrowser.create({
      data: {
        agentId: row.agentId,
        browserbaseContextId: `ctx-${randomUUID()}`,
        connectionId: row.connectionId,
        organizationId: row.organizationId,
      },
    })
    await disconnectCloudBrowser(prisma, { connectionId: row.connectionId, organizationId: row.organizationId })
    const connection = await prisma.cloudBrowserConnection.findUniqueOrThrow({ where: { id: row.connectionId } })
    assert.equal(connection.status, 'disabled')
    assert.equal(connection.healthReason, 'disabled_by_owner')
    assert.equal(await prisma.mcpOAuthSecret.count({ where: { ref: row.oldRef } }), 0)
    assert.equal(await prisma.agentBrowser.count({ where: { connectionId: row.connectionId, status: 'active' } }), 1)
  } finally {
    await row.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('an allocating session makes disconnect fail before a provider browser can be orphaned', async () => {
  const prisma = new PrismaClient()
  const row = await seed(prisma, 'browser-disconnect-admission')
  try {
    await openCloudBrowserSession(depsFor(prisma), {
      agentId: row.agentId,
      encryptionSecret: AUTH_SECRET,
      organizationId: row.organizationId,
      originGate: EMPTY_GATE,
      requestedByUserId: row.userId,
      runId: row.runId,
      teamId: null,
      threadId: row.threadId,
    })
    await assert.rejects(
      disconnectCloudBrowser(prisma, { connectionId: row.connectionId, organizationId: row.organizationId }),
      (error: Error & { code?: string }) => error.code === 'CLOUD_BROWSER_CAPACITY',
    )
    assert.equal(await prisma.cloudBrowserConnection.count({ where: { id: row.connectionId, status: 'active' } }), 1)
  } finally {
    await row.cleanup()
    await prisma.$disconnect()
  }
})


runDatabaseTest('a disabled parent prevents a late reset from creating an uncleanable tombstone', async () => {
  const prisma = new PrismaClient()
  const row = await seed(prisma, 'browser-reset-disconnect')
  try {
    const browser = await prisma.agentBrowser.create({
      data: {
        agentId: row.agentId,
        browserbaseContextId: `ctx-${randomUUID()}`,
        connectionId: row.connectionId,
        organizationId: row.organizationId,
      },
    })
    await disconnectCloudBrowser(prisma, { connectionId: row.connectionId, organizationId: row.organizationId })
    assert.deepEqual(
      await resetAgentBrowser(prisma, { agentBrowserId: browser.id, organizationId: row.organizationId }),
      { tombstoned: false },
    )
    assert.equal(await prisma.agentBrowser.count({ where: { id: browser.id, status: 'active' } }), 1)
  } finally {
    await row.cleanup()
    await prisma.$disconnect()
  }
})
