#!/usr/bin/env node
//   DATABASE_URL=postgresql://… pnpm --filter @nessie/admin test:e2e:disclosure
//
// Scripted inference proves Nessie's routing, provenance, authorization and UI
// behavior. It deliberately does not claim that a live model would infer the
// Czech request correctly; that needs a separately approved live-model eval.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import {
  assertFreshServersAvailable,
  startAdmin,
  startApi,
  stopProcess,
} from '../navigation/lib/servers.mjs'

const ADMIN_URL = 'http://localhost:5455'
const API_URL = 'http://127.0.0.1:5454'
const SCREENSHOTS = resolve(import.meta.dirname, '..', '..', '..', 'e2e', 'screenshots', 'disclosure')
const SECRET = 'Kestrel closes on Friday.'
const SHARED_SUMMARY = 'Project Kestrel will close this Friday.'

const assertNoSecret = (value, boundary) => {
  assert.equal(
    String(value).includes(SECRET),
    false,
    `${boundary} exposed the private source text`,
  )
}

const assertWithheld = (value, boundary) => {
  assertNoSecret(value, boundary)
  assert.equal(String(value).includes(SHARED_SUMMARY), false, `${boundary} exposed the restricted reply`)
}

const responseData = async (response, label) => {
  const text = await response.text()
  assert.ok(response.ok, `${label} failed with ${response.status}: ${text}`)
  const payload = text ? JSON.parse(text) : null
  return payload?.data
}

const api = async (path, token, options = {}) => {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
  })
  return { data: await responseData(response, `${options.method ?? 'GET'} ${path}`), response }
}

const tokenFor = (issueSessionToken, user, scope) => issueSessionToken({
  org: scope.organizationId,
  proj: scope.projectId,
  providerId: 'local',
  providerType: 'local',
  roles: [user.role],
  sub: user.id,
  team: scope.teamId,
  tv: 0,
}, process.env.NESSIE_AUTH_SECRET, 3_600).token

const installEventProbe = (page, token) => page.evaluate(async (bearer) => {
  const controller = new AbortController()
  window.__disclosureEventProbe = { controller, events: [] }
  const response = await fetch('/api/events/stream', {
    headers: { authorization: `Bearer ${bearer}` },
    signal: controller.signal,
  })
  if (!response.ok) throw new Error(`event stream failed with ${response.status}`)
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('event stream did not return text/event-stream')
  }
  if (!response.body) throw new Error('event stream has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  void (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      pending += decoder.decode(next.value, { stream: true })
      let boundary = pending.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const event = /^event: (.+)$/mu.exec(frame)?.[1]
        const data = /^data: (.+)$/mu.exec(frame)?.[1]
        if (event && data) {
          window.__disclosureEventProbe.events.push({ event, data: JSON.parse(data) })
        }
        boundary = pending.indexOf('\n\n')
      }
    }
  })().catch((error) => {
    if (error.name !== 'AbortError') window.__disclosureEventProbe.error = String(error)
  })
}, token)

const stopEventProbe = (page) => page.evaluate(() => {
  window.__disclosureEventProbe?.controller.abort()
})

const seedFixture = async (pipeline, seedScope, groupId) => {
  const scope = await seedScope(pipeline.prisma, 'disclosure-browser')
  const prisma = pipeline.prisma
  const agentOwner = { id: scope.userId, role: 'owner' }
  const sourceAuthor = await prisma.user.create({
    data: {
      displayName: 'Berta Source Author',
      email: `disclosure-source-${Date.now()}@example.test`,
    },
  })
  const audience = await prisma.user.create({
    data: {
      displayName: 'Cyril Team Reader',
      email: `disclosure-audience-${Date.now()}@example.test`,
    },
  })
  const group = await prisma.channel.create({
    data: {
      id: groupId,
      label: 'Team launch',
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      slug: `team-launch-${groupId.slice(0, 8)}`,
      teamId: scope.teamId,
      visibility: 'public',
    },
  })
  const privateChannel = await prisma.channel.create({
    data: {
      dmKey: `disclosure-private:${scope.agentId}:${sourceAuthor.id}`,
      label: 'Private source chat',
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      slug: `private-source-${groupId.slice(0, 8)}`,
      teamId: scope.teamId,
      type: 'dm',
      visibility: 'private',
    },
  })
  const explicitChannel = await prisma.channel.create({
    data: {
      label: 'Explicit private source chat', organizationId: scope.organizationId,
      projectId: scope.projectId, slug: `explicit-source-${groupId.slice(0, 8)}`,
      teamId: scope.teamId, visibility: 'private',
    },
  })
  const [groupThread, privateThread, explicitThread] = await Promise.all([
    prisma.thread.create({ data: { channelId: group.id, title: 'Team launch' } }),
    prisma.thread.create({ data: { channelId: privateChannel.id, title: 'Private source chat' } }),
    prisma.thread.create({ data: { channelId: explicitChannel.id, title: 'Explicit private source chat' } }),
  ])

  await prisma.$transaction([
    prisma.organizationMember.create({
      data: { organizationId: scope.organizationId, role: 'member', userId: agentOwner.id },
    }),
    prisma.organizationMember.create({
      data: { organizationId: scope.organizationId, role: 'member', userId: sourceAuthor.id },
    }),
    prisma.organizationMember.create({
      data: { organizationId: scope.organizationId, role: 'member', userId: audience.id },
    }),
    prisma.projectMember.createMany({
      data: [
        { projectId: scope.projectId, role: 'member', userId: agentOwner.id },
        { projectId: scope.projectId, role: 'member', userId: sourceAuthor.id },
        { projectId: scope.projectId, role: 'member', userId: audience.id },
      ],
    }),
    prisma.teamMember.createMany({
      data: [
        { teamId: scope.teamId, role: 'member', userId: agentOwner.id },
        { teamId: scope.teamId, role: 'member', userId: sourceAuthor.id },
        { teamId: scope.teamId, role: 'member', userId: audience.id },
      ],
    }),
    prisma.channelMember.createMany({
      data: [
        { channelId: group.id, role: 'member', userId: agentOwner.id },
        { channelId: group.id, role: 'member', userId: sourceAuthor.id },
        { channelId: group.id, role: 'member', userId: audience.id },
        { channelId: privateChannel.id, role: 'member', userId: sourceAuthor.id },
        { channelId: explicitChannel.id, role: 'member', userId: sourceAuthor.id },
      ],
    }),
    prisma.agent.update({
      where: { id: scope.agentId },
      data: {
        agentKind: 'shared',
        name: 'Disclosure shared agent',
        ownerUserId: agentOwner.id,
        systemManaged: false,
        toolPolicy: { send_message: true },
      },
    }),
    prisma.agentBinding.create({
      data: { agentId: scope.agentId, channelId: privateChannel.id },
    }),
    prisma.agentBinding.create({
      data: { agentId: scope.agentId, channelId: explicitChannel.id },
    }),
    prisma.toolRegistryEntry.upsert({
      where: { organizationId_scopeKey_toolId: { organizationId: scope.organizationId, scopeKey: 'builtin', toolId: 'send_message' } },
      create: {
        builtin: true, description: 'Send a message to a channel.', enabled: true,
        handlerKind: 'builtin', label: 'Send message', organizationId: scope.organizationId,
        overview: 'Send a message to a channel.', safe: false, scopeKey: 'builtin', toolId: 'send_message',
      },
      update: { builtin: true, enabled: true },
    }),
  ])

  await prisma.message.create({
    data: {
      content: `Čau, prosím drž to mezi námi: ${SECRET} Neházej to do týmu, díky.`,
      role: 'user',
      threadId: privateThread.id,
      userId: sourceAuthor.id,
    },
  })
  await prisma.message.create({
    data: { content: `Hele, pořád je to citlivý: ${SECRET}`, role: 'user', threadId: explicitThread.id, userId: sourceAuthor.id },
  })
  await prisma.message.create({
    data: {
      content: '¿Alguien puede confirmar el plan del lanzamiento? thx!',
      role: 'user',
      threadId: groupThread.id,
      userId: audience.id,
    },
  })

  return {
    agentOwner,
    explicitChannel,
    explicitThread,
    group,
    groupThread,
    privateChannel,
    privateThread,
    audience: { id: audience.id, role: 'member' },
    scope,
    sourceAuthor: { id: sourceAuthor.id, role: 'member' },
  }
}

const submitMentionedRequest = async (page, agentName, text) => {
  const composer = page.locator('[role="textbox"][data-placeholder="Message"]')
  await composer.fill(`@${agentName}`)
  await page.locator('button').filter({ hasText: agentName }).first().click()
  await composer.press('End')
  await composer.pressSequentially(` ${text}`)
  await composer.press('Enter')
}

const waitForRun = async (pipeline, agentId, threadId) => {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const run = await pipeline.prisma.run.findFirst({
      where: { agentId, threadId, triggerMessageId: { not: null } }, orderBy: { createdAt: 'desc' },
    })
    if (run) return run
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`No run was admitted for thread ${threadId}`)
}

const main = async () => {
  process.env.DATABASE_URL ??= 'postgresql://nessie:nessie@127.0.0.1:55432/nessie_disclosure'
  process.env.NESSIE_DB_URL ??= process.env.DATABASE_URL
  process.env.NESSIE_AUTH_SECRET ??= 'disclosure-browser-e2e-secret'
  process.env.NESSIE_MODEL_API_KEY ??= 'mock-token'
  process.env.NESSIE_MODEL_PROVIDER ??= 'openai'
  process.env.OPENAI_API_KEY ??= 'mock-token'

  await rm(SCREENSHOTS, { force: true, recursive: true })
  await mkdir(SCREENSHOTS, { recursive: true })
  await assertFreshServersAvailable()

  const groupId = randomUUID()
  const { createMockLlmServer, parseScenario } = await import('@nessie/mock-llm')
  const scenario = parseScenario({
    name: 'disclosure-private-withheld',
    defaults: { latencyMs: 5, model: 'mock-model' },
    turns: [
      {
        reasoning: 'The person explicitly names one team destination and authorizes this exact update.',
        stream: { chunkDelayMs: 5, chunkSize: 12 },
        text: '',
        toolCalls: [{
          arguments: { content: SHARED_SUMMARY, channelId: groupId },
          toolCallId: 'mock-disclosure-send-1',
          toolName: 'send_message',
        }],
        usage: { inputTokens: 101, outputTokens: 21 },
      },
      {
        text: 'Hotovo — poslal jsem přesně schválené shrnutí do Team launch.',
        usage: { inputTokens: 133, outputTokens: 12 },
      },
    ],
    utilityTurns: [{ text: '{"share":false}' }, { text: '{"share":true}' }],
  })
  const model = await createMockLlmServer({ scenario })
  // `worker/src/run/agent-loop.ts` reads model configuration at import time.
  // Set the mock URL before importing pipeline.ts, not merely before enqueuing.
  process.env.NESSIE_MODEL_BASE_URL = `${model.url}/v1`

  const { issueSessionToken } = await import('../../../api/src/auth/session.ts')
  const { cleanupScope, seedScope, startMockPipeline } = await import('../../../worker/test-harness/pipeline.ts')
  const pipeline = await startMockPipeline({ workers: 1 })
  const fixture = await seedFixture(pipeline, seedScope, groupId)
  const ownerToken = tokenFor(issueSessionToken, fixture.agentOwner, fixture.scope)
  const sourceToken = tokenFor(issueSessionToken, fixture.sourceAuthor, fixture.scope)
  const audienceToken = tokenFor(issueSessionToken, fixture.audience, fixture.scope)
  const runIds = []

  let apiServer = null
  let adminServer = null
  let browser = null
  let ownerContext = null
  let sourceContext = null
  let audienceContext = null
  try {
    // This security evaluation must never adopt another worktree's dev loop:
    // that would exercise different source and leave this fixture unverified.
    apiServer = await startApi({ reuseExisting: false })
    adminServer = await startAdmin({ reuseExisting: false })
    browser = await launchBrowser()
    ownerContext = await openViewportContext(browser, { name: 'desktop', token: ownerToken })
    sourceContext = await openViewportContext(browser, { name: 'desktop', token: sourceToken })
    audienceContext = await openViewportContext(browser, { name: 'desktop', token: audienceToken })
    const ownerPage = await ownerContext.newPage()
    const sourcePage = await sourceContext.newPage()
    const audiencePage = await audienceContext.newPage()
    await Promise.all([
      ownerPage.page.goto(`${ADMIN_URL}/channels/${fixture.group.id}`, { waitUntil: 'domcontentloaded' }),
      sourcePage.page.goto(`${ADMIN_URL}/channels/${fixture.privateChannel.id}`, { waitUntil: 'domcontentloaded' }),
      audiencePage.page.goto(`${ADMIN_URL}/channels/${fixture.group.id}`, { waitUntil: 'domcontentloaded' }),
    ])
    await audiencePage.page.waitForSelector('text=¿Alguien puede confirmar el plan', { timeout: 60_000 })
    await installEventProbe(audiencePage.page, audienceToken)
    await ownerPage.page.locator('[role="textbox"][data-placeholder="Message"]').fill(
      'Můžu prosím zveřejnit Bertin soukromý update?',
    )
    await ownerPage.page.locator('[role="textbox"][data-placeholder="Message"]').press('Enter')
    await audiencePage.page.waitForFunction(() => {
      const events = window.__disclosureEventProbe?.events ?? []
      return events.some((frame) => frame.event === 'message.new'
        && frame.data?.contentPreview?.includes('Bertin soukromý update'))
    }, { timeout: 60_000 })

    await submitMentionedRequest(sourcePage.page, 'Disclosure shared agent', 'Můžeš poslat stručný update do Team launch?')
    const firstRun = await waitForRun(pipeline, fixture.scope.agentId, fixture.privateThread.id)
    runIds.push(firstRun.id)
    const terminal = await pipeline.waitForTerminalRuns([firstRun.id], 60_000)
    assert.equal(terminal.get(firstRun.id), 'completed', 'private-chat worker run completes')
    await sourcePage.page.goto(`${ADMIN_URL}/channels/${fixture.group.id}`, { waitUntil: 'domcontentloaded' })

    const forwarded = await pipeline.prisma.message.findFirstOrThrow({
      where: { metadata: { path: ['delegatedFromRunId'], equals: firstRun.id }, threadId: fixture.groupThread.id },
      select: { id: true },
    })
    const basis = await pipeline.prisma.messageBasisScope.findMany({
      where: { messageId: forwarded.id }, select: { scopeId: true, scopeType: true },
    })
    assert.deepEqual(basis, [{ scopeId: fixture.sourceAuthor.id, scopeType: 'user' }], 'private source stamps exact author basis on forwarded content')
    assert.equal(
      await pipeline.prisma.disclosureGrant.count({ where: { messageId: forwarded.id } }),
      0,
      'the model’s declined judgement creates no disclosure grant',
    )

    await audiencePage.page.waitForFunction((messageId) => {
      const card = document.querySelector(`[data-testid="restricted-message-${messageId}"]`)
      return card?.textContent?.includes('isn’t shown') ?? false
    }, forwarded.id, { timeout: 60_000 })
    const recipientBody = await audiencePage.page.locator('body').innerText()
    assertWithheld(recipientBody, 'recipient transcript UI')
    assert.equal(recipientBody.includes(SHARED_SUMMARY), false, 'recipient sees no forwarded summary before consent')
    await audiencePage.page.screenshot({ path: resolve(SCREENSHOTS, 'before-source-author-share.png'), fullPage: true })

    await audiencePage.page.waitForFunction((messageId) => {
      const events = window.__disclosureEventProbe?.events ?? []
      return events.some((frame) => frame.event === 'message.new'
        && frame.data?.messageId === messageId
        && frame.data?.restricted === true)
    }, forwarded.id, { timeout: 60_000 })
    const realtime = await audiencePage.page.evaluate(() => window.__disclosureEventProbe?.events ?? [])
    assertWithheld(JSON.stringify(realtime), 'recipient realtime frame')

    await audiencePage.page.getByRole('button', { name: 'Search messages' }).click()
    await audiencePage.page.getByPlaceholder('Search messages in this channel').fill('Kestrel')
    await audiencePage.page.getByText('No matches.').waitFor({ timeout: 30_000 })

    const denied = await fetch(`${API_URL}/api/messages/${forwarded.id}/disclosure-grants`, {
      body: JSON.stringify({ kind: 'message', duration: '10m' }),
      headers: { authorization: `Bearer ${audienceToken}`, 'content-type': 'application/json' },
      method: 'POST',
    })
    assert.equal(denied.status, 403, 'a target-group reader cannot approve the source author’s private information')

    const ownerDenied = await fetch(`${API_URL}/api/messages/${forwarded.id}/disclosure-grants`, {
      body: JSON.stringify({ kind: 'message', duration: '10m' }),
      headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      method: 'POST',
    })
    assert.equal(ownerDenied.status, 403, 'the shared agent owner cannot approve another person’s private information')

    for (const [label, token] of [['group reader', audienceToken], ['agent owner', ownerToken]]) {
      for (const path of [
        `/api/agents/${fixture.scope.agentId}/messages`,
        `/api/agents/${fixture.scope.agentId}/activity`,
        `/api/agents/${fixture.scope.agentId}/runs/${firstRun.id}/tools`,
      ]) {
        const response = await fetch(`${API_URL}${path}`, { headers: { authorization: `Bearer ${token}` } })
        assert.ok(response.status < 500, `${label} read route responds safely: ${path}`)
        assertWithheld(await response.text(), `${label} ${path}`)
      }
    }

    await sourcePage.page.waitForSelector(
      `[data-testid="restricted-message-${forwarded.id}"]`,
      { timeout: 60_000 },
    )
    await sourcePage.page
      .locator(`#msg-${forwarded.id}`)
      .getByRole('button', { name: 'Share this reply' })
      .click()
    await audiencePage.page.waitForFunction(
      (summary) => document.body.innerText.includes(summary),
      SHARED_SUMMARY,
      { timeout: 60_000 },
    )
    const afterShare = await audiencePage.page.locator('body').innerText()
    assertNoSecret(afterShare, 'recipient UI after content-scoped share')
    assert.ok(afterShare.includes(SHARED_SUMMARY), 'author’s one-reply share reaches the intended group')
    const grants = await pipeline.prisma.disclosureGrant.findMany({
      where: { messageId: forwarded.id },
      select: { audienceId: true, audienceKind: true, grantedByUserId: true },
    })
    assert.deepEqual(grants, [{
      audienceId: fixture.group.id,
      audienceKind: 'channel',
      grantedByUserId: fixture.sourceAuthor.id,
    }], 'the UI control grants only this reply to its current channel')
    await audiencePage.page.screenshot({ path: resolve(SCREENSHOTS, 'after-source-author-share.png'), fullPage: true })

    const sourceSearch = await api(`/api/channels/${fixture.group.id}/messages/search?query=Kestrel`, audienceToken)
    assertWithheld(JSON.stringify(sourceSearch.data), 'recipient search API after one-reply share')
    assert.equal(sourceSearch.data.length, 0, 'one-reply grant does not widen to source transcript')

    await sourcePage.page.goto(`${ADMIN_URL}/channels/${fixture.explicitChannel.id}`, { waitUntil: 'domcontentloaded' })
    await submitMentionedRequest(sourcePage.page, 'Disclosure shared agent', `Prosím pošli přesně „${SHARED_SUMMARY}“ do Team launch. Jo, fakt to tam chci hodit, diky!`)
    const explicitRun = await waitForRun(pipeline, fixture.scope.agentId, fixture.explicitThread.id)
    runIds.push(explicitRun.id)
    const explicitTerminal = await pipeline.waitForTerminalRuns([explicitRun.id], 60_000)
    assert.equal(explicitTerminal.get(explicitRun.id), 'completed', 'author’s explicit private request completes')
    const automaticallyShared = await pipeline.prisma.message.findFirstOrThrow({
      where: { metadata: { path: ['delegatedFromRunId'], equals: explicitRun.id }, threadId: fixture.groupThread.id },
      select: { id: true },
    })
    const automaticGrant = await pipeline.prisma.disclosureGrant.findMany({
      where: { messageId: automaticallyShared.id },
      select: { audienceId: true, audienceKind: true, grantedByUserId: true },
    })
    assert.deepEqual(automaticGrant, [{
      audienceId: fixture.group.id,
      audienceKind: 'channel',
      grantedByUserId: fixture.sourceAuthor.id,
    }], 'B’s explicit request auto-grants only the exact group reply')
    assert.equal(
      await pipeline.prisma.scopeDisclosureGrant.count({ where: { agentId: fixture.scope.agentId } }),
      0,
      'the explicit request creates no standing disclosure grant',
    )
    await audiencePage.page.reload({ waitUntil: 'domcontentloaded' })
    await audiencePage.page.waitForFunction(({ messageId, summary }) => {
      const row = document.querySelector(`#msg-${messageId}`)
      return row?.textContent?.includes(summary) ?? false
    }, { messageId: automaticallyShared.id, summary: SHARED_SUMMARY }, { timeout: 60_000 })
    await sourcePage.page.goto(`${ADMIN_URL}/channels/${fixture.group.id}`, { waitUntil: 'domcontentloaded' })
    assert.equal(
      await sourcePage.page.locator(`#msg-${automaticallyShared.id}`).getByRole('button', { name: 'Share this reply' }).count(),
      0,
      'an explicit author request needs no redundant share click',
    )
    await audiencePage.page.screenshot({ path: resolve(SCREENSHOTS, 'after-explicit-author-share.png'), fullPage: true })

    await stopEventProbe(audiencePage.page)
    await ownerPage.close()
    await sourcePage.close()
    await audiencePage.close()
    console.log('[disclosure e2e] PASS: private transcript → shared worker → UI and explicit scoped disclosure')
  } finally {
    if (audienceContext) await audienceContext.close().catch(() => {})
    if (sourceContext) await sourceContext.close().catch(() => {})
    if (ownerContext) await ownerContext.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    if (adminServer) await stopProcess(adminServer)
    if (apiServer) await stopProcess(apiServer)
    await pipeline.prisma.user.deleteMany({ where: { email: { startsWith: 'disclosure-' } } }).catch(() => {})
    await cleanupScope(pipeline.prisma, pipeline.pool, fixture.scope, runIds).catch(() => {})
    await pipeline.stop().catch(() => {})
    await model.close().catch(() => {})
  }
}

await main()
