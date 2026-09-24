import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const outDir = resolve(REPO_ROOT, 'e2e/screenshots/team-avatar-visual')
const admin = await startAdmin({ reuseExisting: false })
const browser = await launchBrowser()
try {
  await mkdir(outDir, { recursive: true })
  for (const viewport of [
    { height: 800, name: 'desktop', width: 1280 },
    { height: 844, name: 'mobile', width: 390 },
  ]) {
    const context = await browser.newContext({ hasTouch: viewport.name === 'mobile', viewport })
    const page = await context.newPage()
    const relayRequests = []
    page.on('request', (request) => {
      if (request.url().includes('/api/team') && request.url().includes('/avatar')) relayRequests.push(request.url())
    })
    await page.goto(`${ADMIN_URL}/e2e/team-avatar-visual/index.html`)
    const board = page.locator(`[data-board="${viewport.name}"]`)
    await board.waitFor()
    const sources = await board.locator('img').evaluateAll((images) => images.map((image) => image.getAttribute('src')))
    assert.equal(sources.length, 2, `${viewport.name}: selected and dropdown avatars render`)
    assert.equal(sources[0], sources[1], `${viewport.name}: selected and dropdown avatars use the same image`)
    assert.equal(relayRequests.length, 0, `${viewport.name}: selecting a team does not replace the directory image`)
    await board.screenshot({ path: resolve(outDir, `${viewport.name}.png`) })
    await context.close()
  }
  console.log(`Team avatar visuals written to ${outDir}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
