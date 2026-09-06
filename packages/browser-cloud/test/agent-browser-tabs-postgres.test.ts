import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import type { BrowserbaseClient } from '../src/browserbase-client.js'
import type { CdpClient } from '../src/cdp-client.js'
import {
  listAgentBrowserTabs,
  persistAgentBrowserTabs,
  type CapturedTab,
} from '../src/agent-browser-tabs.js'
import { resumeAgentBrowser } from '../src/resume.js'
import {
  cloudBrowserSettings,
  releaseCloudBrowserSession,
  touchResumedSession,
  type CloudBrowserDeps,
} from '../src/session-lifecycle.js'

/**
 * What survives a session: the tabs, as a set; a resume that opens the same
 * browser on the same account with no run and the idle TTL; the idle window
 * moving while somebody watches and stopping at the cap; and the last state
 * written on the way out. All storage- or money-level, none provable on a stub.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `tabs ${suffix}` } })
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `tabs-${suffix}@example.com` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: owner.id, role: 'owner' },
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
  const agent = await prisma.agent.create({
    data: {
      name: `a-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const connection = await prisma.cloudBrowserConnection.create({
    data: {
      organizationId: organization.id,
      scope: 'organization',
      projectId: 'company',
      apiKeyRef: `secret_browserbase_${suffix}`,
      createdByUserId: owner.id,
    },
  })
  return {
    organizationId: organization.id,
    ownerUserId: owner.id,
    agentId: agent.id,
    threadId: thread.id,
    teamId: team.id,
    connectionId: connection.id,
    cleanup: async () => {
      await prisma.organization.delete({ where: { id: organization.id } })
      await prisma.user.delete({ where: { id: owner.id } })
    },
  }
}

const fakeClient = (calls: string[]): BrowserbaseClient => ({
  createSession: async (input) => {
    const id = `bb-${randomUUID()}`
    calls.push(`session:${input.contextId ?? 'none'}`)
    return { id, connectUrl: 'wss://connect.browserbase.com/x', status: 'RUNNING' }
  },
  endSession: async (id) => { calls.push(`end:${id}`) },
  liveView: async () => ({ debuggerFullscreenUrl: 'https://x.browserbase.com/v', pages: [] }),
  createContext: async () => ({ id: `ctx-${randomUUID()}` }),
  deleteContext: async () => undefined,
})

/** A browser with these pages open; records what it was asked to do. */
const fakeCdp = (pages: Array<{ url: string; title: string }>, calls: string[]): CdpClient => ({
  call: async (method, params, options) => {
    calls.push(`${method}:${String(params?.url ?? params?.targetId ?? '')}`)
    if (method === 'Target.attachToTarget') return { sessionId: `s-${String(params?.targetId)}` }
    if (method === 'Page.captureScreenshot') {
      return { data: Buffer.from(`jpeg:${String(options?.sessionId)}`).toString('base64') }
    }
    return {}
  },
  pageSessionId: () => 'page',
  attachToPage: async () => 'page',
  targets: async () => pages.map((page, index) => ({ ...page, targetId: `t${index}`, type: 'page' })),
  close: () => { calls.push('close') },
  closed: new Promise(() => undefined),
})

const deps = (
  prisma: PrismaClient,
  calls: string[],
  cdp: CdpClient,
  now?: () => Date,
): CloudBrowserDeps => ({
  prisma,
  resolveSecret: async () => 'bb-key',
  clientFactory: () => fakeClient(calls),
  connect: async () => cdp,
  encryptionSecret: 'test-auth-secret',
  now,
})

const tab = (position: number, url: string, picture: boolean): CapturedTab => ({
  position,
  url,
  title: `Title ${position}`,
  screenshot: picture ? Uint8Array.from(Buffer.from(`shot-${position}`)) : null,
  screenshotMime: picture ? 'image/jpeg' : null,
})

runDatabaseTest('tabs are a set: a capture replaces what was there', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const browser = await prisma.agentBrowser.create({
      data: {
        organizationId: s.organizationId,
        agentId: s.agentId,
        connectionId: s.connectionId,
        browserbaseContextId: 'ctx-1',
      },
    })
    const where = { organizationId: s.organizationId, agentBrowserId: browser.id }
    await persistAgentBrowserTabs(prisma, {
      ...where,
      tabs: [tab(0, 'https://a.example', true), tab(1, 'https://b.example', false)],
    })
    let rows = await listAgentBrowserTabs(prisma, where)
    assert.deepEqual(
      rows.map((row) => [row.position, row.url, row.screenshotDataUrl !== null, row.capturedAt !== null]),
      [
        // Seen now whether or not the picture came out.
        [0, 'https://a.example', true, true],
        [1, 'https://b.example', false, true],
      ],
    )
    assert.ok(rows[0]?.screenshotDataUrl?.startsWith('data:image/jpeg;base64,'))

    // A tab the agent closed must not linger as one it still has.
    await persistAgentBrowserTabs(prisma, { ...where, tabs: [tab(0, 'https://c.example', true)] })
    rows = await listAgentBrowserTabs(prisma, where)
    assert.deepEqual(rows.map((row) => row.url), ['https://c.example'])

    await persistAgentBrowserTabs(prisma, { ...where, tabs: [] })
    assert.deepEqual(await listAgentBrowserTabs(prisma, where), [])
  } finally {
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('a resume reopens the same browser with no run, tabs restored, on the idle TTL', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  const calls: string[] = []
  const cdpCalls: string[] = []
  try {
    const browser = await prisma.agentBrowser.create({
      data: {
        organizationId: s.organizationId,
        agentId: s.agentId,
        connectionId: s.connectionId,
        browserbaseContextId: 'ctx-resume',
      },
    })
    await persistAgentBrowserTabs(prisma, {
      organizationId: s.organizationId,
      agentBrowserId: browser.id,
      tabs: [tab(0, 'https://first.example', true), tab(1, 'https://second.example', true)],
    })

    const resumed = await resumeAgentBrowser(deps(prisma, calls, fakeCdp([], cdpCalls)), {
      organizationId: s.organizationId,
      agentId: s.agentId,
      agentVisibility: 'team',
      agentOwnerUserId: null,
      threadId: s.threadId,
      teamId: s.teamId,
      userId: s.ownerUserId,
    })
    assert.equal(resumed.restoredTabs, 2)
    // The same persistent context, so the sign-ins are the ones it had.
    assert.deepEqual(calls, ['session:ctx-resume'])
    assert.deepEqual(cdpCalls, [
      'Page.navigate:https://first.example',
      'Target.createTarget:https://second.example',
      'close',
    ])

    const row = await prisma.cloudBrowserSession.findUniqueOrThrow({
      where: { id: resumed.sessionId },
    })
    assert.equal(row.runId, null)
    assert.equal(row.requestedByUserId, s.ownerUserId)
    assert.equal(row.agentBrowserId, browser.id)
    assert.equal(row.connectionId, s.connectionId)
    assert.equal(row.status, 'active')
    const settings = cloudBrowserSettings()
    // `startedAt` is the database's clock and `expiresAt` this process's, so
    // the idle window is asserted to the second rather than the millisecond.
    const idle = row.expiresAt.getTime() - row.startedAt.getTime()
    assert.ok(
      Math.abs(idle - settings.resumeIdleMs) < 5_000,
      `expected the idle TTL (${settings.resumeIdleMs}ms), got ${idle}ms`,
    )

    // Watching extends the window; the cap is the ordinary TTL from the start.
    const later = new Date(row.startedAt.getTime() + 2 * 60 * 1000)
    await touchResumedSession(prisma, { sessionId: resumed.sessionId, now: later })
    let touched = await prisma.cloudBrowserSession.findUniqueOrThrow({
      where: { id: resumed.sessionId },
    })
    assert.equal(touched.expiresAt.getTime(), later.getTime() + settings.resumeIdleMs)
    const nearCap = new Date(row.startedAt.getTime() + settings.ttlMs - 1000)
    await touchResumedSession(prisma, { sessionId: resumed.sessionId, now: nearCap })
    touched = await prisma.cloudBrowserSession.findUniqueOrThrow({
      where: { id: resumed.sessionId },
    })
    assert.equal(touched.expiresAt.getTime(), row.startedAt.getTime() + settings.ttlMs)

    // Released — by the reaper, by hand, either way — the last state is written first.
    const leaving = fakeCdp([{ url: 'https://gmail.example/inbox', title: 'Inbox' }], cdpCalls)
    const released = await releaseCloudBrowserSession(deps(prisma, calls, leaving), {
      sessionId: resumed.sessionId,
      releasedBy: 'reaper',
    })
    assert.equal(released, true)
    const after = await listAgentBrowserTabs(prisma, {
      organizationId: s.organizationId,
      agentBrowserId: browser.id,
    })
    assert.deepEqual(after.map((t) => [t.url, t.title, t.screenshotDataUrl !== null]), [
      ['https://gmail.example/inbox', 'Inbox', true],
    ])
    assert.ok(calls.some((call) => call.startsWith('end:')))
  } finally {
    await s.cleanup()
    await prisma.$disconnect()
  }
})

runDatabaseTest('a signed-in browser is seen by its signers and its requester, nobody else', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const stranger = await prisma.user.create({
      data: { displayName: 'Stranger', email: `stranger-${randomUUID()}@example.com` },
    })
    await prisma.organizationMember.create({
      data: { organizationId: s.organizationId, userId: stranger.id, role: 'member' },
    })
    const browser = await prisma.agentBrowser.create({
      data: {
        organizationId: s.organizationId,
        agentId: s.agentId,
        connectionId: s.connectionId,
        browserbaseContextId: 'ctx-audience',
      },
    })
    const { viewerMaySeeAgentBrowser } = await import('../src/agent-browser.js')
    const see = (viewerId: string, requestedByUserId: string | null = null) =>
      viewerMaySeeAgentBrowser(prisma, { agentBrowserId: browser.id, viewerId, requestedByUserId })

    // Nobody signed in: what the agent could see anyway.
    assert.equal(await see(stranger.id), true)

    await prisma.agentBrowserLogin.create({
      data: {
        agentBrowserId: browser.id,
        organizationId: s.organizationId,
        userId: s.ownerUserId,
        serviceHint: 'Mail',
      },
    })
    assert.equal(await see(s.ownerUserId), true)
    assert.equal(await see(stranger.id), false)
    // A session you asked for is your own request, whoever signed the browser in.
    assert.equal(await see(stranger.id, stranger.id), true)
    await prisma.user.delete({ where: { id: stranger.id } }).catch(() => undefined)
  } finally {
    await s.cleanup()
    await prisma.$disconnect()
  }
})
