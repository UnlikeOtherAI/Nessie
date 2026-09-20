import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { assertFreshServersAvailable, startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'
import { seedDesignerFixture, waitForRun } from './fixture.mjs'
import { buildDesignerScenarios, GRANTED_ANSWER, REVOKED_ANSWER } from './scenarios.mjs'

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/designer-capabilities')

const submit = async (page, threadId, text) => {
  const composer = page.locator('form.admin-compose:visible [role="textbox"]').last()
  await composer.waitFor({ timeout: 60_000 })
  const sent = page.waitForResponse((response) =>
    response.request().method() === 'POST'
    && response.url().endsWith(`/api/threads/${threadId}/messages`),
  )
  await composer.click()
  await composer.pressSequentially(text)
  assert.ok((await composer.innerText()).includes(text), 'the rendered composer accepted the request')
  await composer.press('Enter')
  assert.equal((await sent).status(), 201)
}

const main = async () => {
  assert.ok(process.env.DATABASE_URL, 'Set DATABASE_URL to an isolated migrated test database')
  process.env.NESSIE_DB_URL = process.env.DATABASE_URL
  process.env.NESSIE_AUTH_SECRET = 'designer-capabilities-browser-evaluation'
  process.env.NESSIE_MODEL_PROVIDER = 'openai'
  process.env.NESSIE_MODEL_NAME = 'mock-model'
  process.env.NESSIE_MODEL_API_KEY = 'mock-token'
  process.env.OPENAI_API_KEY = 'mock-token'
  await assertFreshServersAvailable()
  await mkdir(screenshots, { recursive: true })

  const { createMockLlmServer, parseScenario } = await import('@nessie/mock-llm')
  let phase = 'grant'
  let scenarios
  let recoveries = 0
  const model = await createMockLlmServer({
    scenario: parseScenario({ name: 'designer-bootstrap', turns: [{ text: '{}' }], utility: { text: '{}' } }),
    mainScenarioResolver: () => scenarios?.[phase],
    utilityResponder: (prompt) => {
      // Fixed system protocol, not interpretation of the person's language.
      if (prompt.includes('Your previous response reached the provider output limit.')) {
        recoveries += 1
        return GRANTED_ANSWER
      }
      return undefined
    },
  })
  process.env.NESSIE_MODEL_BASE_URL = `${model.url}/v1`
  const { startMockPipeline, seedScope, cleanupScope } = await import('../../../worker/test-harness/pipeline.ts')
  const { issueSessionToken } = await import('../../../api/src/auth/session.ts')
  const pipeline = await startMockPipeline({ workers: 0 })
  let fixture
  let apiServer
  let adminServer
  let browser
  const contexts = []
  const runIds = []
  let page
  try {
    fixture = await seedDesignerFixture(pipeline.prisma, seedScope)
    scenarios = buildDesignerScenarios(parseScenario, fixture)
    const token = issueSessionToken({
      org: fixture.scope.organizationId,
      proj: fixture.scope.projectId,
      team: fixture.scope.teamId,
      providerId: 'local',
      providerType: 'local-bootstrap',
      roles: ['owner'],
      sub: fixture.scope.userId,
      tv: 0,
    }, process.env.NESSIE_AUTH_SECRET, 3_600, fixture.sessionId).token
    apiServer = await startApi({ reuseExisting: false })
    adminServer = await startAdmin({ reuseExisting: false })
    browser = await launchBrowser()
    const desktop = await openViewportContext(browser, { name: 'desktop', token })
    contexts.push(desktop)
    page = (await desktop.newPage()).page
    const conversationUrl = (index) =>
      `${ADMIN_URL}/channels/${fixture.designer.channelId}/threads/${fixture.conversations[index].id}`

    await page.goto(conversationUrl(0))
    await submit(page, fixture.conversations[0].id,
      'Dej CTO pristup k prohlizeci a nastav mu hlas Puck, prosim.')
    const grantRun = await waitForRun(pipeline.prisma, fixture.designer.agentId, fixture.conversations[0].id)
    runIds.push(grantRun.id)
    assert.equal(grantRun.status, 'completed')
    const calls = await pipeline.prisma.toolCall.findMany({
      where: { runId: grantRun.id }, orderBy: { startedAt: 'asc' },
    })
    for (const name of ['tool_spec', 'agent_tool_access_inspect', 'agent_tool_access_set', 'agent_update']) {
      const matches = calls.filter((call) => call.toolName === name)
      assert.equal(matches.length, 1, `${name} ran once without replay`)
      assert.equal(matches[0].success, true, `${name}: ${matches[0].outputPreview}`)
    }
    const target = await pipeline.prisma.agent.findUniqueOrThrow({ where: { id: fixture.scope.agentId } })
    assert.equal(target.toolPolicy?.browser_open, true)
    assert.equal(target.voiceName, 'Puck')
    const budgetStops = await pipeline.prisma.taskEvent.count({
      where: { eventType: 'run.budget_exhausted', task: { runId: grantRun.id } },
    })
    assert.equal(budgetStops, 0, 'provider truncation is not run-budget exhaustion')
    const truncatedInvocations = await pipeline.prisma.tokenLedgerEvent.count({
      where: { runId: grantRun.id, operationType: 'chat', outputTokens: 2_048 },
    })
    assert.equal(truncatedInvocations, 1, 'the scripted truncated response was actually consumed')
    await page.getByText(GRANTED_ANSWER, { exact: true }).waitFor({ timeout: 30_000 })
    assert.doesNotMatch(await page.locator('body').innerText(), /reached its token limit|Continue this run to finish/)
    await page.screenshot({ path: resolve(screenshots, 'desktop-granted.png'), fullPage: true })

    const phone = await openViewportContext(browser, { name: 'phone', token })
    contexts.push(phone)
    const phonePage = (await phone.newPage()).page
    await phonePage.goto(conversationUrl(0))
    await phonePage.getByText(GRANTED_ANSWER, { exact: true }).waitFor({ timeout: 30_000 })
    await phonePage.screenshot({ path: resolve(screenshots, 'phone-recovered.png'), fullPage: true })

    phase = 'revoke'
    await page.goto(conversationUrl(1))
    await submit(page, fixture.conversations[1].id, 'Remove CTO browser access; keep its voice.')
    const revokeRun = await waitForRun(pipeline.prisma, fixture.designer.agentId, fixture.conversations[1].id)
    runIds.push(revokeRun.id)
    assert.equal(revokeRun.status, 'completed')
    const updated = await pipeline.prisma.agent.findUniqueOrThrow({ where: { id: fixture.scope.agentId } })
    assert.equal(updated.toolPolicy?.browser_open, false)
    assert.equal(updated.voiceName, 'Puck')
    await page.getByText(REVOKED_ANSWER, { exact: true }).waitFor({ timeout: 30_000 })
    await page.reload()
    await page.getByText(REVOKED_ANSWER, { exact: true }).waitFor({ timeout: 30_000 })
    await page.screenshot({ path: resolve(screenshots, 'desktop-revoked.png'), fullPage: true })
    await writeFile(resolve(screenshots, 'verification.json'), JSON.stringify({
      runIds, recoveries, result: 'passed', scriptedInference: true,
    }, null, 2))
    console.log('Designer browser evaluation passed: private schema lookup, grants, voice, output recovery and revoke.')
  } catch (error) {
    if (page) {
      await page.screenshot({ path: resolve(screenshots, 'failure.png'), fullPage: true }).catch(() => {})
      await writeFile(resolve(screenshots, 'failure.txt'), await page.locator('body').innerText()).catch(() => {})
    }
    await writeFile(resolve(screenshots, 'servers.log'),
      `${apiServer?.output() ?? ''}\n${adminServer?.output() ?? ''}`)
    throw error
  } finally {
    for (const context of contexts) await context.close()
    await browser?.close()
    await stopProcess(adminServer)
    await stopProcess(apiServer)
    if (fixture) await cleanupScope(pipeline.prisma, pipeline.pool, fixture.scope, runIds)
    await pipeline.stop()
    await model.close()
  }
}

await main()
