import assert from 'node:assert/strict'
import { ExecutorAccessViewResponseSchema } from '@nessie/schemas'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { assertFreshServersAvailable, startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const executorId = '33333333-3333-4333-8333-333333333333'
const userId = '11111111-1111-4111-8111-111111111111'
const changeId = '44444444-4444-4444-8444-444444444444'
const timestamp = '2026-09-21T00:00:00.000Z'
const executor = { id: executorId, label: 'Studio Mac', profiles: ['workspace_sandbox'], status: 'offline',
  scope: { kind: 'private', organizationId: '22222222-2222-4222-8222-222222222222' },
  authorizationRevision: 1, createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp }
const revision = { revision: 12, profiles: ['workspace_sandbox'], operationKeys: ['file.read', 'command.run'],
  commandAllowlist: ['git', 'node'], workspaceFolders: ['projects'], reviewStatus: 'pending_review', localPolicyDigest: `sha256:${'a'.repeat(64)}` }
const access = { executorId, canManage: true, effectiveAccess: { privateAssignment: 'admin', projectRole: null, organizationRole: 'owner' },
  privateAssignments: [{ principalKind: 'user', userId, role: 'admin' }], operationGrants: [],
  descriptorRevisions: [revision, { ...revision, revision: 11, workspaceFolders: ['old-folder'] }],
  sessions: [{ id: changeId, createdAt: timestamp, updatedAt: timestamp, profile: 'coding_session', status: 'stopped', originChannelId: userId }] }
const output = resolve(REPO_ROOT, 'e2e/screenshots/executor-detail')
ExecutorAccessViewResponseSchema.parse(access)
await assertFreshServersAvailable()
const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const served = await fetch(ADMIN_URL).then((r) => r.text())
  if (process.env.NAV_E2E_ADMIN_MODE !== 'preview') assert.ok(served.includes('@vite/client'))
  await mkdir(output, { recursive: true })
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ hasTouch: width === 390, viewport: { width, height: 900 } })
    let prepared = null
    const unexpected = []
    await context.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      const respond = (data) => route.fulfill({ json: { data } })
      if (path === '/api/executors') return respond([executor])
      if (path.endsWith('/access')) return respond(access)
      if (path === `/api/executors/${executorId}/agents`) return route.fulfill({ json: { data: [], meta: { total: 0, hasMore: false, prevCursor: null, nextCursor: null } } })
      if (path === `/api/executors/${executorId}/leases`) return respond([])
      if (path === '/api/users') return respond([{ id: userId, displayName: 'Alex' }])
      if (path === '/api/agents') return respond([])
      if (path === '/api/local-inference/hosts') return respond({ hosts: [{
        id: userId, executorId, availability: 'offline', status: 'active', paused: false,
        transport: 'executor', models: [], lastSeenAt: timestamp,
      }], meta: { total: 1 } })
      if (path === '/api/executor-access-changes') {
        prepared = route.request().postDataJSON().change
        return respond({ accessChangeId: changeId, executorId, confirmationToken: 'a'.repeat(43), expiresAt: new Date(Date.now() + 600000).toISOString(), requiresFreshVerification: true })
      }
      if (path === `/api/executor-access-changes/${changeId}`) return respond({
        accessChangeId: changeId, executorId, change: prepared, status: 'pending',
        expiresAt: new Date(Date.now() + 600000).toISOString(), requiresFreshVerification: true, verificationMethod: 'unavailable',
      })
      unexpected.push(path)
      return route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED', message: path } } })
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${ADMIN_URL}/e2e/executor-detail/index.html`)
    await page.getByRole('heading', { name: 'Studio Mac' }).waitFor()
    try { await page.getByRole('button', { name: 'Add agent', exact: true }).waitFor() }
    catch (error) { console.error(await page.locator('body').innerText(), errors, unexpected); throw error }
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.equal(await page.getByText('Your effective access:', { exact: false }).count(), 0)
    assert.equal(await page.getByText('Local Ollama', { exact: true }).count(), 0)
    await page.screenshot({ animations: 'disabled', path: resolve(output, `agents-${width}.png`) })
    await page.getByRole('tab', { name: /^Permissions/ }).click()
    await page.getByText('projects', { exact: false }).waitFor()
    assert.equal(await page.getByText('old-folder', { exact: false }).count(), 0)
    assert.equal(await page.getByText('sha256:', { exact: false }).count(), 0)
    assert.equal(await page.getByText('pending_review', { exact: false }).count(), 0)
    await page.screenshot({ animations: 'disabled', path: resolve(output, `permissions-${width}.png`) })
    await page.getByRole('button', { name: 'Review changes', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Approve machine changes' })
    await review.waitFor()
    await review.getByText('extra identity check', { exact: false }).waitFor()
    assert.equal(await review.getByRole('button', { name: 'Approve changes', exact: true }).isEnabled(), false)
    assert.equal(await review.locator('input[type=password]').count(), 0)
    assert.equal(await review.locator('pre').count(), 0)
    await page.screenshot({ animations: 'disabled', path: resolve(output, `review-${width}.png`) })
    await page.keyboard.press('Escape')
    await page.getByRole('tab', { name: 'Activity', exact: true }).click()
    const conversation = page.getByRole('link', { name: 'Open conversation' })
    await conversation.waitFor()
    const bounds = await conversation.boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, 'Conversation stays visible on phone')
    assert.equal(await page.getByRole('button', { name: /revocation/i }).count(), 0)
    await page.screenshot({ animations: 'disabled', path: resolve(output, `activity-${width}.png`) })
    await page.getByRole('button', { name: 'Machine', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Local models' }).click()
    const models = page.getByRole('dialog', { name: 'Local models', exact: true })
    await models.getByRole('button', { name: 'Disconnect local models' }).click()
    await page.getByRole('dialog', { name: 'Disconnect local models?' }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await models.isVisible(), true, 'Nested confirmation closes before its owning modal')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Machine', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Manage people' }).click()
    await page.getByRole('dialog', { name: 'People who can use this machine' }).getByText('Alex', { exact: true }).first().waitFor()
    await page.screenshot({ animations: 'disabled', path: resolve(output, `people-${width}.png`) })
    await page.keyboard.press('Escape')
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpected, [])
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No page overflow')
    await context.close()
  }
  console.log(`Executor detail flows passed; screenshots: ${output}`)
} finally { await browser.close(); await stopProcess(admin) }
