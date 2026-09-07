#!/usr/bin/env node
//   DATABASE_URL=postgresql://… pnpm --filter @nessie/admin test:e2e:disclosure
//
// Scripted inference proves Nessie's routing, provenance, authorization and UI
// behavior. It deliberately does not claim that a live model inferred the
// Czech request correctly; that requires a live-provider evaluation.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import {
  assertFreshServersAvailable,
  startAdmin,
  startApi,
  stopProcess,
} from '../navigation/lib/servers.mjs'
import {
  SECRET,
  SHARED_SUMMARY,
  seedFixture,
  submitMentionedRequest,
  waitForRun,
} from './fixture.mjs'
import {
  installActivityProbe,
  installEventProbe,
  setActivitySubscriptions,
  stopActivityProbe,
  stopEventProbe,
} from './realtime-probes.mjs'

const ADMIN_URL = 'http://localhost:5455'
const API_URL = 'http://127.0.0.1:5454'
const SCREENSHOTS = resolve(import.meta.dirname, '..', '..', '..', 'e2e', 'screenshots', 'disclosure')

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

const savePublicFailureEvidence = async (page, error) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error)
  await writeFile(resolve(SCREENSHOTS, 'failure.txt'), `${detail}\n`)
  if (!page) return

  const body = await page.locator('body').innerText().catch(() => '')
  await writeFile(resolve(SCREENSHOTS, 'failure-public-recipient.txt'), body)
  await page.screenshot({
    path: resolve(SCREENSHOTS, 'failure-public-recipient.png'),
    fullPage: true,
  }).catch(() => {})
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
  providerType: 'local-bootstrap',
  roles: [user.role],
  sub: user.id,
  team: scope.teamId,
  tv: 0,
}, process.env.NESSIE_AUTH_SECRET, 3_600, user.sessionId).token

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
  // UI submissions run through the API's local-mode embedded worker. This
  // harness supplies the isolated fixture and terminal-state observation.
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
  let audiencePage = null
  try {
    // This security evaluation must never adopt another worktree's dev loop:
    // that would exercise different source and leave this fixture unverified.
    apiServer = await startApi({ reuseExisting: false })
    adminServer = await startAdmin({ reuseExisting: false })
    const ownerMe = await api('/api/auth/me', ownerToken)
    assert.deepEqual(
      ownerMe.data.user.roleIds,
      ['owner'],
      'A is an organization owner through the API’s live membership resolver',
    )
    browser = await launchBrowser()
    ownerContext = await openViewportContext(browser, { name: 'desktop', token: ownerToken })
    sourceContext = await openViewportContext(browser, { name: 'desktop', token: sourceToken })
    audienceContext = await openViewportContext(browser, { name: 'desktop', token: audienceToken })
    const ownerPage = await ownerContext.newPage()
    const sourcePage = await sourceContext.newPage()
    audiencePage = await audienceContext.newPage()
    await Promise.all([
      ownerPage.page.goto(`${ADMIN_URL}/channels/${fixture.group.id}`, { waitUntil: 'domcontentloaded' }),
      sourcePage.page.goto(`${ADMIN_URL}/channels/${fixture.privateChannel.id}`, { waitUntil: 'domcontentloaded' }),
      audiencePage.page.goto(`${ADMIN_URL}/channels/${fixture.group.id}`, { waitUntil: 'domcontentloaded' }),
    ])
    await audiencePage.page.waitForSelector('text=¿Alguien puede confirmar el plan', { timeout: 60_000 })
    await installEventProbe(audiencePage.page, audienceToken)
    await installActivityProbe(audiencePage.page, audienceToken, [{
      channelId: fixture.group.id,
      kind: 'channel',
    }])
    await ownerPage.page.locator('form.admin-compose [role="textbox"]').fill(
      'Můžu prosím zveřejnit Bertin soukromý update?',
    )
    await ownerPage.page.locator('form.admin-compose [role="textbox"]').press('Enter')
    await audiencePage.page.waitForFunction(() => {
      const events = window.__disclosureEventProbe?.events ?? []
      return events.some((frame) => frame.event === 'message.new'
        && frame.data?.contentPreview?.includes('Bertin soukromý update'))
    }, { timeout: 60_000 })
    await audiencePage.page.waitForFunction(() => {
      const events = window.__disclosureActivityProbe?.events ?? []
      return events.some((frame) => frame.type === 'event'
        && frame.event === 'message.new'
        && frame.data?.contentPreview?.includes('Bertin soukromý update'))
    }, { timeout: 60_000 })
    // The known-public SSE canary must not consume a mock utility decision before B's disclosure judge.
    await pipeline.prisma.agentBinding.create({
      data: { agentId: fixture.scope.agentId, channelId: fixture.group.id },
    })
    await setActivitySubscriptions(audiencePage.page, [
      { channelId: fixture.group.id, kind: 'channel' },
      { agentId: fixture.scope.agentId, kind: 'agent' },
    ])

    await submitMentionedRequest(
      sourcePage.page,
      'Disclosure shared agent',
      `Čau, drž to prosím mezi námi: ${SECRET} Připrav stručný update pro Team launch, ale nic nezveřejňuj bez mého souhlasu.`,
    )
    const firstRun = await waitForRun(pipeline, fixture.scope.agentId, fixture.privateThread.id)
    runIds.push(firstRun.id)
    const terminal = await pipeline.waitForTerminalRuns([firstRun.id], 60_000)
    assert.equal(terminal.get(firstRun.id), 'completed', 'private-chat worker run completes')
    assert.equal(
      model.stats().turnCounts[-1],
      1,
      'the first private request invoked exactly its declined disclosure judge',
    )
    const activityFrames = await audiencePage.page.evaluate(() => window.__disclosureActivityProbe?.events ?? [])
    assert.equal(
      activityFrames.some((frame) => frame.type === 'event' && frame.data?.runId === firstRun.id),
      false,
      'a group reader receives no private-agent run event on public channel and agent scopes',
    )
    assertWithheld(JSON.stringify(activityFrames), 'recipient activity websocket frames')
    await sourcePage.page.goto(`${ADMIN_URL}/channels/${fixture.group.id}`, { waitUntil: 'domcontentloaded' })

    const forwarded = await pipeline.prisma.message.findFirstOrThrow({
      where: { metadata: { path: ['delegatedFromRunId'], equals: firstRun.id }, threadId: fixture.groupThread.id },
      select: { id: true },
    })
    const basis = await pipeline.prisma.messageBasisScope.findMany({
      where: { messageId: forwarded.id }, select: { scopeId: true, scopeType: true },
    })
    assert.deepEqual(basis, [{
      scopeId: fixture.privateChannel.id,
      scopeType: 'channel',
    }], 'private source stamps its exact channel basis on forwarded content')
    const sources = await pipeline.prisma.messageDisclosureSource.findMany({
      where: { messageId: forwarded.id },
      select: { sourceAuthorUserId: true, sourceChannelId: true },
    })
    assert.deepEqual(sources, [{
      sourceAuthorUserId: fixture.sourceAuthor.id,
      sourceChannelId: fixture.privateChannel.id,
    }], 'private source preserves B as the only author allowed to grant this reply')
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
      ]) {
        const response = await fetch(`${API_URL}${path}`, { headers: { authorization: `Bearer ${token}` } })
        assert.equal(response.status, 200, `${label} can reach the visible shared agent: ${path}`)
        assertWithheld(await response.text(), `${label} ${path}`)
      }
      const toolsResponse = await fetch(
        `${API_URL}/api/agents/${fixture.scope.agentId}/runs/${firstRun.id}/tools`,
        { headers: { authorization: `Bearer ${token}` } },
      )
      assert.equal(toolsResponse.status, 200, `${label} receives a filtered private run-tool response`)
      const toolsPayload = JSON.parse(await toolsResponse.text())
      assert.deepEqual(toolsPayload.data, [], `${label} cannot enumerate private run tools`)
    }

    await sourcePage.page.waitForSelector(
      `[data-testid="restricted-message-${forwarded.id}"]`,
      { timeout: 60_000 },
    )
    await sourcePage.page.screenshot({ path: resolve(SCREENSHOTS, 'source-author-share-control.png'), fullPage: true })
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
    await submitMentionedRequest(
      sourcePage.page,
      'Disclosure shared agent',
      `Pořád citlivé: ${SECRET}. Prosím pošli přesně „${SHARED_SUMMARY}“ do Team launch. Jo, fakt to tam chci hodit, diky!`,
    )
    const explicitRun = await waitForRun(pipeline, fixture.scope.agentId, fixture.explicitThread.id)
    runIds.push(explicitRun.id)
    const explicitTerminal = await pipeline.waitForTerminalRuns([explicitRun.id], 60_000)
    assert.equal(explicitTerminal.get(explicitRun.id), 'completed', 'author’s explicit private request completes')
    assert.equal(
      model.stats().turnCounts[-1],
      2,
      'the explicit private request invoked exactly its positive disclosure judge',
    )
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
    await stopActivityProbe(audiencePage.page)
    await ownerPage.close()
    await sourcePage.close()
    await audiencePage.close()
    console.log('[disclosure e2e] PASS: private transcript → shared worker → UI and explicit scoped disclosure')
  } catch (error) {
    await savePublicFailureEvidence(audiencePage?.page, error)
    throw error
  } finally {
    if (audienceContext) await audienceContext.close().catch(() => {})
    if (sourceContext) await sourceContext.close().catch(() => {})
    if (ownerContext) await ownerContext.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    if (adminServer) await stopProcess(adminServer)
    if (apiServer) await stopProcess(apiServer)
    await pipeline.prisma.user.deleteMany({
      where: { id: { in: [fixture.sourceAuthor.id, fixture.audience.id] } },
    }).catch(() => {})
    await cleanupScope(pipeline.prisma, pipeline.pool, fixture.scope, runIds).catch(() => {})
    await pipeline.stop().catch(() => {})
    await model.close().catch(() => {})
  }
}

await main()
