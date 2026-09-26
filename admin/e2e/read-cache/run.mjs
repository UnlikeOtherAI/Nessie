import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'
import { channels, createReadCacheFixtures, ids } from './fixtures.mjs'

const output = resolve(REPO_ROOT, 'e2e/screenshots/read-cache')
const admin = await startAdmin({ reuseExisting: false })
const browser = await launchBrowser()
try {
  assert.ok((await fetch(ADMIN_URL).then((response) => response.text())).includes('@vite/client'))
  await mkdir(output, { recursive: true })
  for (const name of ['desktop', 'phone']) {
    const fixture = createReadCacheFixtures()
    const context = await openViewportContext(browser, { name, route: fixture.respond, token: 'read-cache-fixture' })
    const { page, errors } = await context.newPage()
    await page.routeWebSocket('**/api/activity*', (ws) => ws.onMessage(() => {}))
    const go = (path) => page.goto(`${ADMIN_URL}${path}`, { timeout: 120_000, waitUntil: 'domcontentloaded' })
    try {
      await go(`/projects/${ids.project}/board`)
      await page.getByText('Saved delivery ticket', { exact: true }).waitFor({ timeout: 120_000 })
      console.log(`read-cache: ${name} initial board rendered`)
      await page.waitForFunction(() => localStorage.getItem('nessie.read-cache.v1')?.includes('Saved delivery ticket'))
      fixture.hold()
      fixture.update()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByText('Saved delivery ticket', { exact: true }).waitFor()
      assert.ok(fixture.pending.some((path) => path.endsWith('/tasks')), 'board refresh is blocked on the network')
      assert.equal(await page.locator('[data-skeleton="board"]').count(), 0)
      await page.screenshot({ path: resolve(output, `${name}-cached-board.png`) })
      fixture.release()
      await page.getByText('Updated delivery ticket', { exact: true }).waitFor()
      await page.screenshot({ path: resolve(output, `${name}-updated-board.png`) })
      console.log(`read-cache: ${name} saved board and background replacement verified`)

      await go(`/channels/${channels[0].id}`)
      await page.getByText('General saved message', { exact: true }).waitFor()
      // Use the app's actual router for warm back/forward navigation.
      await page.evaluate(async (id) => {
        const { router } = await import('/src/router.tsx')
        await router.navigate(`/channels/${id}`)
      }, channels[1].id)
      await page.getByText('Planning saved message', { exact: true }).waitFor()
      fixture.hold()
      const before = fixture.calls.filter((path) => path.endsWith('/messages')).length
      await page.evaluate(async (id) => {
        const { router } = await import('/src/router.tsx')
        await router.navigate(`/channels/${id}`)
      }, channels[0].id)
      await page.getByText('General saved message', { exact: true }).waitFor()
      assert.equal(fixture.calls.filter((path) => path.endsWith('/messages')).length, before,
        'revisiting a fresh conversation requires no duplicate history request')
      await page.screenshot({ path: resolve(output, `${name}-warm-channel.png`) })
      fixture.release()

      await go(`/projects/${ids.project}/board`)
      await page.getByText('Updated delivery ticket', { exact: true }).waitFor()
      await page.waitForFunction(() => localStorage.getItem('nessie.read-cache.v1')?.includes('Updated delivery ticket'))
      fixture.switchUser()
      fixture.hold()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByText('Loading boards…', { exact: true }).waitFor()
      assert.equal(await page.getByText('Updated delivery ticket', { exact: true }).count(), 0,
        'a different authenticated person cannot see the prior snapshot')
      fixture.release()
      await page.getByText('Updated delivery ticket', { exact: true }).waitFor()
      assert.deepEqual(errors, [])
      console.log(`read-cache: ${name} reload, background refresh, warm channel and account isolation passed`)
    } catch (error) {
      fixture.release()
      await page.screenshot({ path: resolve(output, `${name}-failure.png`) })
      console.error({ errors, pending: fixture.pending, recentCalls: fixture.calls.slice(-25) })
      throw error
    } finally { await context.close() }
  }
} finally {
  await browser.close()
  await stopProcess(admin)
}
