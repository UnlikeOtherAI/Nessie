import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import type { BrowserbaseClient } from '../src/browserbase-client.js'
import {
  ensureAgentBrowser,
  recordAgentBrowserLogin,
  reconcileTombstonedAgentBrowsers,
  resetAgentBrowser,
  resolveDurableBrowserConnection,
} from '../src/agent-browser.js'
import {
  claimSessionControl,
  openCloudBrowserSession,
  reapExpiredCloudBrowserSessions,
  releaseCloudBrowserSession,
  releaseSessionControl,
  releaseSessionsForRun,
} from '../src/session-lifecycle.js'
import type { CloudBrowserDeps } from '../src/session-lifecycle.js'

/**
 * The durable-browser rules are all storage-level or money-level: which
 * account may hold a browser, that two agents never share one, that one agent
 * cannot open its own browser twice at once, and that a reset stops pointing
 * at a context before anything deletes it. None survives a stub.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  ownerUserId: string
  otherUserId: string
  workspaceAgentId: string
  privateAgentId: string
  threadId: string
  runId: string
  secondRunId: string
  cleanup: () => Promise<void>
}

const seed = async (prisma: PrismaClient, label: string): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `${label} ${suffix}` } })
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `owner-${suffix}@example.com` },
  })
  const other = await prisma.user.create({
    data: { displayName: 'Other', email: `other-${suffix}@example.com` },
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, userId: owner.id, role: 'owner' },
      { organizationId: organization.id, userId: other.id, role: 'member' },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `p-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `t-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `c-${suffix}`,
      slug: `c-${suffix.slice(0, 8)}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id, title: 'general' } })
  const workspaceAgent = await prisma.agent.create({
    data: {
      name: `ws-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const privateAgent = await prisma.agent.create({
    data: {
      name: `pr-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      visibility: 'private',
      ownerUserId: owner.id,
    },
  })
  const run = await prisma.run.create({
    data: { agentId: workspaceAgent.id, threadId: thread.id },
  })
  const secondRun = await prisma.run.create({
    data: { agentId: workspaceAgent.id, threadId: thread.id },
  })

  return {
    organizationId: organization.id,
    ownerUserId: owner.id,
    otherUserId: other.id,
    workspaceAgentId: workspaceAgent.id,
    privateAgentId: privateAgent.id,
    threadId: thread.id,
    runId: run.id,
    secondRunId: secondRun.id,
    cleanup: async () => {
      await prisma.organization.delete({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } })
    },
  }
}

const fakeClient = (calls: string[]): BrowserbaseClient => ({
  createSession: async (input) => {
    const id = `bb-${randomUUID()}`
    calls.push(`session:${id}:${input.contextId ?? 'none'}:${input.persistContext ?? false}`)
    return { id, connectUrl: 'wss://connect.browserbase.com/x', status: 'RUNNING' }
  },
  endSession: async (id) => { calls.push(`end:${id}`) },
  liveView: async () => ({ debuggerFullscreenUrl: 'https://x.browserbase.com/v', pages: [] }),
  createContext: async () => {
    const id = `ctx-${randomUUID()}`
    calls.push(`context:create:${id}`)
    return { id }
  },
  deleteContext: async (id) => { calls.push(`context:delete:${id}`) },
})

const depsFor = (prisma: PrismaClient, calls: string[]): CloudBrowserDeps => ({
  prisma,
  resolveSecret: async () => 'bb-api-key',
  clientFactory: () => fakeClient(calls),
})

const connect = (
  prisma: PrismaClient,
  input: { organizationId: string; scope: 'organization' | 'user'; userId?: string },
) => prisma.cloudBrowserConnection.create({
  data: {
    organizationId: input.organizationId,
    scope: input.scope,
    userId: input.userId ?? null,
    projectId: input.scope === 'user' ? 'personal' : 'company',
    apiKeyRef: `secret_browserbase_${input.scope}`,
    createdByUserId: input.userId ?? input.organizationId,
  },
})

runDatabaseTest('a workspace agent’s browser refuses to live on a personal account', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma, 'durable workspace')
  try {
    // Only a personal connection exists.
    await connect(prisma, {
      organizationId: s.organizationId,
      scope: 'user',
      userId: s.ownerUserId,
    })

    await assert.rejects(
      resolveDurableBrowserConnection(prisma, {
        organizationId: s.organizationId,
        agentVisibility: 'workspace',
        agentOwnerUserId: s.ownerUserId,
      }),
      // Its state would otherwise be reachable through runs the account's
      // owner never requested.
      (error: Error & { code?: string }) => error.code === 'CLOUD_BROWSER_NO_CONNECTION',
    )
  } finally {
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('a private agent prefers its owner’s account over the company one', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma, 'durable private')
  try {
    await connect(prisma, { organizationId: s.organizationId, scope: 'organization' })
    await connect(prisma, {
      organizationId: s.organizationId,
      scope: 'user',
      userId: s.ownerUserId,
    })

    const chosen = await resolveDurableBrowserConnection(prisma, {
      organizationId: s.organizationId,
      agentVisibility: 'private',
      agentOwnerUserId: s.ownerUserId,
    })

    // On the company account, the company's Browserbase admin could replay a
    // private agent's browsing — not the privacy the label implies.
    assert.equal(chosen.scope, 'user')
  } finally {
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('an agent gets one browser, reused across runs', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma, 'durable reuse')
  const calls: string[] = []
  const deps = depsFor(prisma, calls)
  try {
    await connect(prisma, { organizationId: s.organizationId, scope: 'organization' })

    const first = await ensureAgentBrowser(deps, {
      organizationId: s.organizationId,
      agentId: s.workspaceAgentId,
      agentVisibility: 'workspace',
      agentOwnerUserId: null,
    })
    const second = await ensureAgentBrowser(deps, {
      organizationId: s.organizationId,
      agentId: s.workspaceAgentId,
      agentVisibility: 'workspace',
      agentOwnerUserId: null,
    })

    assert.equal(first.id, second.id)
    assert.equal(
      calls.filter((call) => call.startsWith('context:create')).length,
      1,
      'the second call must reuse the context, not mint another',
    )
    // A different agent never shares it — the whole point of per-agent.
    const other = await ensureAgentBrowser(deps, {
      organizationId: s.organizationId,
      agentId: s.privateAgentId,
      agentVisibility: 'workspace',
      agentOwnerUserId: null,
    })
    assert.notEqual(other.browserbaseContextId, first.browserbaseContextId)
  } finally {
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('one agent cannot open its own browser in two runs at once', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma, 'durable single session')
  const calls: string[] = []
  const deps = depsFor(prisma, calls)
  try {
    await connect(prisma, { organizationId: s.organizationId, scope: 'organization' })
    const browser = await ensureAgentBrowser(deps, {
      organizationId: s.organizationId,
      agentId: s.workspaceAgentId,
      agentVisibility: 'workspace',
      agentOwnerUserId: null,
    })
    const attach = {
      id: browser.id,
      connectionId: browser.connectionId,
      browserbaseContextId: browser.browserbaseContextId,
      hasLogins: false,
    }

    await openCloudBrowserSession(deps, {
      organizationId: s.organizationId,
      runId: s.runId,
      threadId: s.threadId,
      agentId: s.workspaceAgentId,
      requestedByUserId: s.ownerUserId,
      agentBrowser: attach,
    })

    // Browserbase warns two sessions on one context make sites force logouts.
    await assert.rejects(
      openCloudBrowserSession(deps, {
        organizationId: s.organizationId,
        runId: s.secondRunId,
        threadId: s.threadId,
        agentId: s.workspaceAgentId,
        requestedByUserId: s.ownerUserId,
        agentBrowser: attach,
      }),
      (error: Error & { code?: string }) => error.code === 'CLOUD_BROWSER_SESSION_ALREADY_OPEN',
    )

    // The context is attached with persist, which is what makes tomorrow's
    // run find the login still there.
    assert.ok(
      calls.some((call) => call.includes(`${browser.browserbaseContextId}:true`)),
      'the durable session must attach its context with persist',
    )
  } finally {
    await releaseSessionsForRun(deps, { runId: s.runId, releasedBy: 'test' })
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('a session on a browser with logins is authenticated from the first frame', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma, 'durable authenticated')
  const calls: string[] = []
  const deps = depsFor(prisma, calls)
  try {
    await connect(prisma, { organizationId: s.organizationId, scope: 'organization' })
    const browser = await ensureAgentBrowser(deps, {
      organizationId: s.organizationId,
      agentId: s.workspaceAgentId,
      agentVisibility: 'workspace',
      agentOwnerUserId: null,
    })
    await recordAgentBrowserLogin(prisma, {
      organizationId: s.organizationId,
      agentBrowserId: browser.id,
      userId: s.ownerUserId,
      serviceHint: 'Google — owner@example.com',
    })

    const opened = await openCloudBrowserSession(deps, {
      organizationId: s.organizationId,
      runId: s.runId,
      threadId: s.threadId,
      agentId: s.workspaceAgentId,
      requestedByUserId: s.ownerUserId,
      agentBrowser: {
        id: browser.id,
        connectionId: browser.connectionId,
        browserbaseContextId: browser.browserbaseContextId,
        hasLogins: true,
      },
    })

    const row = await prisma.cloudBrowserSession.findUnique({
      where: { id: opened.sessionId },
      select: { authenticated: true },
    })
    // Before any page loads: an empty basis publishes to everyone, so this
    // must be true at open, not discovered later.
    assert.equal(row?.authenticated, true)
  } finally {
    await releaseSessionsForRun(deps, { runId: s.runId, releasedBy: 'test' })
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('reset stops pointing at the context before anything deletes it', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma, 'durable reset')
  const calls: string[] = []
  const deps = depsFor(prisma, calls)
  try {
    await connect(prisma, { organizationId: s.organizationId, scope: 'organization' })
    const browser = await ensureAgentBrowser(deps, {
      organizationId: s.organizationId,
      agentId: s.workspaceAgentId,
      agentVisibility: 'workspace',
      agentOwnerUserId: null,
    })
    await recordAgentBrowserLogin(prisma, {
      organizationId: s.organizationId,
      agentBrowserId: browser.id,
      userId: s.ownerUserId,
      serviceHint: 'Google',
    })

    const result = await resetAgentBrowser(prisma, {
      organizationId: s.organizationId,
      agentBrowserId: browser.id,
    })
    assert.equal(result.tombstoned, true)

    // Tombstoned first: no run can reach it, and the logins are gone because
    // they describe state that no longer exists.
    const tombstoned = await prisma.agentBrowser.findUnique({
      where: { id: browser.id },
      select: { status: true, browserbaseContextId: true },
    })
    assert.equal(tombstoned?.status, 'tombstoned')
    assert.equal(
      await prisma.agentBrowserLogin.count({ where: { agentBrowserId: browser.id } }),
      0,
    )
    assert.ok(
      !calls.some((call) => call.startsWith('context:delete')),
      'the remote delete belongs to the reconciler, not the transaction',
    )

    // The next open gets a fresh browser rather than the retired one.
    const fresh = await ensureAgentBrowser(deps, {
      organizationId: s.organizationId,
      agentId: s.workspaceAgentId,
      agentVisibility: 'workspace',
      agentOwnerUserId: null,
    })
    assert.notEqual(fresh.id, browser.id)

    const deleted = await reconcileTombstonedAgentBrowsers(deps, { limit: 5 })
    assert.equal(deleted, 1)
    assert.ok(calls.includes(`context:delete:${tombstoned?.browserbaseContextId}`))
    assert.equal(await prisma.agentBrowser.count({ where: { id: browser.id } }), 0)
  } finally {
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('reset refuses while the browser is open', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma, 'durable reset busy')
  const calls: string[] = []
  const deps = depsFor(prisma, calls)
  try {
    await connect(prisma, { organizationId: s.organizationId, scope: 'organization' })
    const browser = await ensureAgentBrowser(deps, {
      organizationId: s.organizationId,
      agentId: s.workspaceAgentId,
      agentVisibility: 'workspace',
      agentOwnerUserId: null,
    })
    await openCloudBrowserSession(deps, {
      organizationId: s.organizationId,
      runId: s.runId,
      threadId: s.threadId,
      agentId: s.workspaceAgentId,
      requestedByUserId: s.ownerUserId,
      agentBrowser: {
        id: browser.id,
        connectionId: browser.connectionId,
        browserbaseContextId: browser.browserbaseContextId,
        hasLogins: false,
      },
    })

    await assert.rejects(
      resetAgentBrowser(prisma, {
        organizationId: s.organizationId,
        agentBrowserId: browser.id,
      }),
      (error: Error & { code?: string }) => error.code === 'CLOUD_BROWSER_CAPACITY',
    )
  } finally {
    await releaseSessionsForRun(deps, { runId: s.runId, releasedBy: 'test' })
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('handing back the controls marks the session authenticated', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma, 'control handback')
  const calls: string[] = []
  const deps = depsFor(prisma, calls)
  try {
    await connect(prisma, { organizationId: s.organizationId, scope: 'organization' })
    // An ephemeral session with no logins: nothing marks it authenticated at
    // open, which is exactly the case that used to lose the basis.
    const opened = await openCloudBrowserSession(deps, {
      organizationId: s.organizationId,
      runId: s.runId,
      threadId: s.threadId,
      agentId: s.workspaceAgentId,
      requestedByUserId: s.ownerUserId,
    })
    const before = await prisma.cloudBrowserSession.findUnique({
      where: { id: opened.sessionId },
      select: { authenticated: true },
    })
    assert.equal(before?.authenticated, false)

    assert.equal(
      await claimSessionControl(prisma, {
        sessionId: opened.sessionId,
        userId: s.ownerUserId,
      }),
      true,
    )
    assert.equal(
      await releaseSessionControl(prisma, {
        sessionId: opened.sessionId,
        userId: s.ownerUserId,
      }),
      true,
    )

    // A person at the controls may have signed in, and the agent resumes into
    // whatever they left behind.
    const after = await prisma.cloudBrowserSession.findUnique({
      where: { id: opened.sessionId },
      select: { authenticated: true },
    })
    assert.equal(after?.authenticated, true)
  } finally {
    await releaseSessionsForRun(deps, { runId: s.runId, releasedBy: 'test' })
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('only the holder can hand the controls back', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma, 'control holder')
  const calls: string[] = []
  const deps = depsFor(prisma, calls)
  try {
    await connect(prisma, { organizationId: s.organizationId, scope: 'organization' })
    const opened = await openCloudBrowserSession(deps, {
      organizationId: s.organizationId,
      runId: s.runId,
      threadId: s.threadId,
      agentId: s.workspaceAgentId,
      requestedByUserId: s.ownerUserId,
    })
    await claimSessionControl(prisma, {
      sessionId: opened.sessionId,
      userId: s.ownerUserId,
    })

    // A bystander must not yank the controls out from under somebody
    // mid-sign-in.
    assert.equal(
      await claimSessionControl(prisma, {
        sessionId: opened.sessionId,
        userId: s.otherUserId,
      }),
      false,
    )
    assert.equal(
      await releaseSessionControl(prisma, {
        sessionId: opened.sessionId,
        userId: s.otherUserId,
      }),
      false,
    )
  } finally {
    await releaseSessionsForRun(deps, { runId: s.runId, releasedBy: 'test' })
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('a scheduled run never bills somebody’s personal account', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma, 'durable unattended')
  const calls: string[] = []
  const deps = depsFor(prisma, calls)
  try {
    // Only a personal connection exists, and the private agent's browser
    // legitimately lives on it.
    await connect(prisma, {
      organizationId: s.organizationId,
      scope: 'user',
      userId: s.ownerUserId,
    })
    const browser = await ensureAgentBrowser(deps, {
      organizationId: s.organizationId,
      agentId: s.privateAgentId,
      agentVisibility: 'private',
      agentOwnerUserId: s.ownerUserId,
    })
    const attach = {
      id: browser.id,
      connectionId: browser.connectionId,
      browserbaseContextId: browser.browserbaseContextId,
      hasLogins: false,
    }

    // A run the owner asked for is fine.
    await openCloudBrowserSession(deps, {
      organizationId: s.organizationId,
      runId: s.runId,
      threadId: s.threadId,
      agentId: s.privateAgentId,
      requestedByUserId: s.ownerUserId,
      agentBrowser: attach,
    })
    await releaseSessionsForRun(deps, { runId: s.runId, releasedBy: 'test' })

    // A scheduled one has no requester, so it must not spend their hours —
    // the count of logins is irrelevant, it is whose money it is.
    await assert.rejects(
      openCloudBrowserSession(deps, {
        organizationId: s.organizationId,
        runId: s.secondRunId,
        threadId: s.threadId,
        agentId: s.privateAgentId,
        requestedByUserId: null,
        agentBrowser: attach,
      }),
      (error: Error & { code?: string }) => error.code === 'CLOUD_BROWSER_NO_CONNECTION',
    )
  } finally {
    await releaseSessionsForRun(deps, { runId: s.secondRunId, releasedBy: 'test' })
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('a session already being released cannot be claimed again', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma, 'release exclusivity')
  const calls: string[] = []
  const deps = depsFor(prisma, calls)
  try {
    await connect(prisma, { organizationId: s.organizationId, scope: 'organization' })
    const opened = await openCloudBrowserSession(deps, {
      organizationId: s.organizationId,
      runId: s.runId,
      threadId: s.threadId,
      agentId: s.workspaceAgentId,
      requestedByUserId: s.ownerUserId,
    })

    // Deterministic stand-in for the real race — the tool, the terminal
    // transition and the reaper can all reach release at once. Racing them
    // with Promise.all proved nothing: the two updates serialise and the
    // interleaving that matters never happened. This asserts the property
    // directly: a session mid-release is not claimable by a second releaser.
    await prisma.cloudBrowserSession.update({
      where: { id: opened.sessionId },
      data: { status: 'releasing' },
    })

    const second = await releaseCloudBrowserSession(deps, {
      sessionId: opened.sessionId,
      releasedBy: 'reaper',
    })

    assert.equal(second, false, 'a second releaser must not claim it')
    assert.equal(
      calls.filter((call) => call.startsWith('end:')).length,
      0,
      'and must not call the provider — the first releaser owns that',
    )
  } finally {
    await prisma.cloudBrowserSession.updateMany({
      where: { runId: s.runId },
      data: { status: 'released' },
    })
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('a session whose remote stop failed is retried, not abandoned', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma, 'unknown retry')
  const calls: string[] = []
  const deps = depsFor(prisma, calls)
  try {
    const connection = await connect(prisma, {
      organizationId: s.organizationId,
      scope: 'organization',
    })
    // `unknown` is what a failed provider stop leaves behind — the row most
    // likely to still be costing money, and previously the one the reaper
    // skipped forever.
    const stranded = await prisma.cloudBrowserSession.create({
      data: {
        organizationId: s.organizationId,
        connectionId: connection.id,
        runId: s.runId,
        threadId: s.threadId,
        agentId: s.workspaceAgentId,
        browserbaseSessionId: 'bb-unknown',
        status: 'unknown',
        expiresAt: new Date(Date.now() - 60_000),
      },
    })

    await reapExpiredCloudBrowserSessions(deps, { limit: 10 })

    assert.ok(calls.includes('end:bb-unknown'), 'the reaper must retry the provider stop')
    const row = await prisma.cloudBrowserSession.findUnique({
      where: { id: stranded.id },
      select: { status: true },
    })
    assert.equal(row?.status, 'released')
  } finally {
    await s.cleanup()
    await prisma.$disconnect()
  }
})
