import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { assertFreshServersAvailable, startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const executorId = '33333333-3333-4333-8333-333333333333'
const output = resolve(REPO_ROOT, 'e2e/screenshots/executor-attention')
await assertFreshServersAvailable()
const admin = await startAdmin({ reuseExisting: false })
const browser = await launchBrowser()
try {
  const served = await fetch(ADMIN_URL).then((response) => response.text())
  assert.ok(served.includes('@vite/client'), 'Attention evaluation must run this worktree’s live Vite source')
  await mkdir(output, { recursive: true })
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ hasTouch: width === 390, viewport: { width, height: 900 } })
    let mode = 'review'
    let attentionRequests = 0
    await context.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/workflow-runs') return route.fulfill({ json: { data: [] } })
      if (path === '/api/executors/attention') {
        attentionRequests += 1
        if (mode === 'denied') return route.fulfill({
          status: 403, json: { error: { code: 'FORBIDDEN', message: 'Access changed' } },
        })
        return route.fulfill({ json: { data: mode === 'review'
          ? { total: 1, executors: [{ executorId, policyRevision: 8 }] }
          : { total: 0, executors: [] } } })
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
    const count = page.getByTestId('nav-executors-attention-count')
    const review = page.getByRole('link', { name: '1 change to review for Office Mac', exact: true })
    await review.waitFor()
    assert.equal(await count.locator('[aria-hidden="true"]').innerText(), '1')
    assert.equal(await page.getByRole('link', { name: /Executors.*1 change to review/ }).count(), 1)
    assert.equal(await page.getByRole('link', { name: /change to review for Studio PC/ }).count(), 0)
    assert.equal(attentionRequests, 1, 'Sidebar and table share one summary fetch')
    await page.screenshot({ path: resolve(output, `review-${width}.png`), fullPage: true })
    if (width === 390) {
      assert.ok((await review.boundingBox()).height >= 44, 'Touch review doorway remains reachable')
      await review.tap()
    }
    else { await review.focus(); await page.keyboard.press('Enter') }
    await page.waitForURL(`**/agents/executors/${executorId}?tab=permissions`)
    mode = 'clear'
    await page.getByRole('button', { name: 'Refresh attention' }).click()
    await count.waitFor({ state: 'detached' })
    assert.equal(await review.count(), 0, 'Resolved or superseded work clears the row badge')
    await page.screenshot({ path: resolve(output, `clear-${width}.png`), fullPage: true })
    mode = 'review'
    await page.getByRole('button', { name: 'Refresh attention' }).click()
    await review.waitFor()
    mode = 'denied'
    await page.getByRole('button', { name: 'Refresh attention' }).click()
    await count.waitFor({ state: 'detached' })
    assert.equal(await review.count(), 0, 'Denied refresh cannot display a previously authorized badge')
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log(`Executor attention flows passed; screenshots: ${output}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
