import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT, adminMode } from '../navigation/lib/config.mjs'
import { assertFreshServersAvailable, startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const executorId = '33333333-3333-4333-8333-333333333333'
const output = resolve(REPO_ROOT, 'e2e/screenshots/executor-attention')
await assertFreshServersAvailable()
const admin = await startAdmin({ reuseExisting: false })
const browser = await launchBrowser()
try {
  if (adminMode() !== 'preview') {
    const served = await fetch(ADMIN_URL).then((response) => response.text())
    assert.ok(served.includes('@vite/client'), 'Attention evaluation must run this worktree’s live Vite source')
  }
  await mkdir(output, { recursive: true })
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ hasTouch: width === 390, viewport: { width, height: 900 } })
    let attentionRequests = 0
    await context.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/workflow-runs') return route.fulfill({ json: { data: [] } })
      if (path === '/api/executors/attention') {
        attentionRequests += 1
        throw new Error('The retired permissions-review queue must not be requested')
      }
      // Hover/focus prewarms the real detail query; the destination is owned
      // by the detail suite rather than duplicated in this badge fixture.
      if (path.endsWith('/access')) return route.fulfill({ status: 403, json: {
        error: { code: 'FORBIDDEN', message: 'Detail is outside this fixture' },
      } })
      throw new Error(`Unexpected attention fixture request ${path}`)
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(`${ADMIN_URL}/e2e/executor-attention/index.html`)
    const row = page.getByRole('row').filter({ hasText: 'Office Mac' })
    await row.waitFor()
    assert.equal(await page.getByTestId('nav-executors-attention-count').count(), 0)
    assert.equal(await page.getByRole('link', { name: /change to review/ }).count(), 0)
    await page.screenshot({ path: resolve(output, 'inventory-' + width + '.png'), fullPage: true })
    if (width === 390) await row.tap()
    else { await row.focus(); await page.keyboard.press('Enter') }
    await page.waitForURL('**/agents/executors/' + executorId)
    assert.equal(attentionRequests, 0)
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log(`Executor attention flows passed; screenshots: ${output}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
