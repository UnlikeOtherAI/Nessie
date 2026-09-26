import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, API_URL } from '../navigation/lib/config.mjs'
import { assertFreshServersAvailable, startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'
import { seedFixture, tokenFor, waitForRun } from './fixture.mjs'
import { startMockModelServer } from './mock-server.mjs'
import { openGallery } from './viewports.mjs'

// Dedicated migrated DATABASE_URL required. Uses real auth, API, Postgres and
// conversation creation; only inference is scripted. No external model spend.
assert.ok(process.env.DATABASE_URL, 'Set DATABASE_URL to a dedicated migrated test database')
process.env.NESSIE_DB_URL = process.env.DATABASE_URL
process.env.NESSIE_AUTH_SECRET = 'agent-suggestions-browser-e2e-secret'
process.env.NESSIE_MODEL_API_KEY = 'mock-token'
process.env.NESSIE_MODEL_PROVIDER = 'openai'
process.env.OPENAI_API_KEY = 'mock-token'
await assertFreshServersAvailable()
const screenshots = resolve('..', 'e2e', 'screenshots', 'agent-suggestions')
await mkdir(screenshots, { recursive: true })
const questions = [
  'Jak připravíme další verzi cenové stránky?',
  'Co ještě zbývá ověřit před zveřejněním?',
  'Které připomínky k textu mám vyřešit jako první?',
]
const plan = { echoLatencyMs: 0, suggestionQuestions: questions, suggestionCalls: 0 }
const model = await startMockModelServer(plan)
process.env.NESSIE_MODEL_BASE_URL = `${model.url}/v1`
const { issueSessionToken } = await import('../../../api/src/auth/session.ts')
const { ensurePersonalAssistantBootstrap } = await import('../../../api/src/services/personal-assistant.ts')
const { cleanupScope, seedScope, startMockPipeline } = await import('../../../worker/test-harness/pipeline.ts')
const pipeline = await startMockPipeline({ workers: 1 })
const fixture = await seedFixture(pipeline, seedScope, ensurePersonalAssistantBootstrap)
const token = tokenFor(issueSessionToken, fixture.owner, fixture.scope)
const runIds = []
let apiServer, adminServer, browser, gallery
try {
  await pipeline.prisma.message.create({ data: {
    threadId: fixture.dmThread.id, userId: fixture.owner.id, role: 'user',
    content: 'pls pomoz mi s další verzí cenový stránky, nwm co udělat nejdřív',
  } })
  apiServer = await startApi({ reuseExisting: false })
  adminServer = await startAdmin({ reuseExisting: false })
  const adminHtml = await (await fetch(ADMIN_URL)).text()
  assert.ok(adminHtml.includes('@vite/client'), 'visual proof uses this worktree’s dev server')
  browser = await launchBrowser()
  gallery = await openGallery(browser, { screenshots, token })
  const path = `/channels/${fixture.dmRoom.id}`
  await gallery.capture('personalized', async (page) => {
    await page.goto(`${ADMIN_URL}${path}`, { waitUntil: 'domcontentloaded' })
    const home = page.getByTestId('agent-session-home')
    await home.getByRole('button', { name: questions[0], exact: true }).waitFor({ timeout: 60_000 })
    for (const question of questions) {
      const button = home.getByRole('button', { name: question, exact: true })
      assert.ok(await button.isVisible())
      const bounds = await button.boundingBox()
      assert.ok(bounds.width > 200 && bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width)
    }
  })
  assert.equal(plan.suggestionCalls, 1, 'all three viewport visits share one inference')
  const page = gallery.pages.phone
  await page.reload({ waitUntil: 'domcontentloaded' })
  const button = page.getByTestId('agent-session-home').getByRole('button', { name: questions[0], exact: true })
  await button.waitFor()
  assert.equal(plan.suggestionCalls, 1, 'reload uses durable cache')
  const started = page.waitForResponse((response) => response.request().method() === 'POST'
    && response.url().endsWith(`/agents/${fixture.agent.id}/conversations`))
  await button.click()
  const response = await started
  assert.equal(response.status(), 201)
  const result = (await response.json()).data
  assert.equal(result.message.content, questions[0], 'button sends the exact displayed question')
  assert.equal(result.conversation.channel.id, fixture.dmRoom.id, 'the new conversation retains its private audience')
  await page.waitForURL(`**/threads/${result.conversation.id}`)
  await page.locator('form.admin-compose:visible').waitFor()
  await page.screenshot({ path: resolve(screenshots, 'phone-started.png') })
  const run = await waitForRun(pipeline, { agentId: fixture.agent.id, threadId: result.conversation.id })
  runIds.push(run.id)
  await pipeline.waitForTerminalRuns(runIds, 60_000)
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await page.getByTestId('agent-session-home').getByRole('button', { name: questions[0], exact: true }).waitFor()
  assert.equal(plan.suggestionCalls, 1, 'new conversation and completion respect cooldown')
  const outsider = tokenFor(issueSessionToken, fixture.outsider, fixture.scope)
  const denied = await fetch(`${API_URL}/api/agents/${fixture.agent.id}/conversation-suggestions?channelId=${fixture.dmRoom.id}`, {
    headers: { authorization: `Bearer ${outsider}` },
  })
  assert.equal(denied.status, 404)
  console.log('[agent-suggestions e2e] PASS: generated prompts, desktop/tablet/phone, cache, tap, private destination, Back, outsider')
} catch (error) {
  for (const [name, page] of Object.entries(gallery?.pages ?? {})) {
    await page.screenshot({ path: resolve(screenshots, `failure-${name}.png`) }).catch(() => {})
    console.error(`[${name}] ${page.url()} ${(await page.locator('body').innerText()).slice(0, 1500)}`)
  }
  console.error(apiServer?.output().slice(-3000) ?? '')
  throw error
} finally {
  if (gallery) await gallery.close()
  if (browser) await browser.close()
  if (adminServer) await stopProcess(adminServer)
  if (apiServer) await stopProcess(apiServer)
  await pipeline.prisma.user.delete({ where: { id: fixture.outsider.id } }).catch(() => {})
  await cleanupScope(pipeline.prisma, pipeline.pool, fixture.scope, runIds).catch(() => {})
  await pipeline.stop()
  await model.close()
}
