import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import type { BrowserbaseClient } from '../src/browserbase-client.js'
import {
  openCloudBrowserSession,
  releaseCloudBrowserSession,
  type CloudBrowserDeps,
} from '../src/session-lifecycle.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const AUTH_SECRET = 'session-admission-failure-test-secret'
const EMPTY_GATE = { authenticatedOrigins: [], currentUrl: null, touchedAuthenticated: false }

type Seed = {
  agentId: string
  organizationId: string
  runId: string
  threadId: string
  userId: string
  cleanup: () => Promise<void>
}

const seed = async (prisma: PrismaClient, label: string): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `${label}-${suffix}` } })
  const user = await prisma.user.create({
    data: { displayName: 'Owner', email: `${label}-${suffix}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `p-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `t-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `c-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `c-${suffix.slice(0, 8)}`,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: { name: `a-${suffix}`, organizationId: organization.id, projectId: project.id, teamId: team.id },
  })
  const run = await prisma.run.create({ data: { agentId: agent.id, threadId: thread.id } })
  await prisma.cloudBrowserConnection.create({
    data: {
      apiKeyRef: `secret_browserbase_${suffix.replaceAll('-', '')}`,
      createdByUserId: user.id,
      organizationId: organization.id,
      scope: 'organization',
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

type ActivationFailure = 'throw' | 'zero'

/**
 * Inject failure only at the durable acknowledgement after Browserbase has
 * returned. The real database remains responsible for the session state and
 * the subsequent release, so this cannot accidentally mirror the code under
 * test in a fake Prisma implementation.
 */
const prismaWithActivationFailure = (prisma: PrismaClient, failure: ActivationFailure): PrismaClient => {
  let pending = true
  const sessions = prisma.cloudBrowserSession
  const guardedSessions = new Proxy(sessions, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if (property !== 'updateMany' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (input: { data?: { status?: unknown }; where?: { status?: unknown } }) => {
        const activation = input.where?.status === 'allocating' && input.data?.status === 'active'
        if (pending && activation) {
          pending = false
          if (failure === 'throw') throw new Error('activation write unavailable')
          return { count: 0 }
        }
        return value.call(target, input)
      }
    },
  })
  return new Proxy(prisma, {
    get(target, property) {
      if (property === 'cloudBrowserSession') return guardedSessions
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as PrismaClient
}

const depsFor = (
  prisma: PrismaClient,
  browserbaseSessionId: string,
  calls: string[],
  failedStops = 0,
): CloudBrowserDeps => ({
  clientFactory: () => ({
    createSession: async () => {
      calls.push(`create:${browserbaseSessionId}`)
      return {
        connectUrl: 'wss://connect.browserbase.com/test',
        id: browserbaseSessionId,
        status: 'RUNNING',
      }
    },
    endSession: async (sessionId) => {
      calls.push(`end:${sessionId}`)
      if (failedStops > 0) {
        failedStops -= 1
        throw new Error('provider stop unavailable')
      }
    },
    liveView: async () => ({ debuggerFullscreenUrl: 'https://browserbase.com/test', pages: [] }),
  }) satisfies BrowserbaseClient,
  encryptionSecret: AUTH_SECRET,
  prisma,
  resolveSecret: async () => 'test-key',
})

for (const failure of ['throw', 'zero'] as const) {
  runDatabaseTest(`a post-create activation ${failure} stays blocking until the remote stop succeeds`, async () => {
    const prisma = new PrismaClient()
    const row = await seed(prisma, `browser-activation-${failure}`)
    const browserbaseSessionId = `bb-${randomUUID()}`
    const calls: string[] = []
    const failingDeps = depsFor(
      prismaWithActivationFailure(prisma, failure),
      browserbaseSessionId,
      calls,
      1,
    )
    const normalDeps = depsFor(prisma, browserbaseSessionId, calls)
    try {
      await assert.rejects(
        openCloudBrowserSession(failingDeps, {
          agentId: row.agentId,
          encryptionSecret: AUTH_SECRET,
          organizationId: row.organizationId,
          originGate: EMPTY_GATE,
          requestedByUserId: row.userId,
          runId: row.runId,
          teamId: null,
          threadId: row.threadId,
        }),
      )
      assert.deepEqual(calls, [`create:${browserbaseSessionId}`, `end:${browserbaseSessionId}`])

      const stranded = await prisma.cloudBrowserSession.findFirstOrThrow({
        where: { runId: row.runId },
        select: { browserbaseSessionId: true, id: true, status: true },
      })
      assert.equal(stranded.status, 'unknown')
      assert.equal(stranded.browserbaseSessionId, browserbaseSessionId)

      assert.equal(
        await releaseCloudBrowserSession(normalDeps, { releasedBy: 'activation_write_failed', sessionId: stranded.id }),
        true,
      )
      assert.equal(
        await releaseCloudBrowserSession(normalDeps, { releasedBy: 'duplicate_release', sessionId: stranded.id }),
        false,
      )
      assert.deepEqual(calls, [
        `create:${browserbaseSessionId}`,
        `end:${browserbaseSessionId}`,
        `end:${browserbaseSessionId}`,
      ])
      assert.equal(
        (await prisma.cloudBrowserSession.findUniqueOrThrow({ where: { id: stranded.id } })).status,
        'released',
      )
    } finally {
      await row.cleanup()
      await prisma.$disconnect()
    }
  })
}
