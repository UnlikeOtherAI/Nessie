import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = resolve(here, 'fixture.tsx').replaceAll('\\', '/')
const screenshotPath = resolve(REPO_ROOT, 'e2e/screenshots/executors/windows-companion.png')
const failureScreenshotPath = resolve(REPO_ROOT, 'e2e/screenshots/executors/windows-companion-failure.png')
const executorId = '00000000-0000-4000-8000-000000000701'

const admin = await startAdmin()
const browser = await launchBrowser()
let page
try {
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    viewport: { height: 900, width: 1280 },
  })
  await context.addInitScript(({ activeExecutorId }) => {
    let callbackId = 0
    const callbacks = new Map()
    window.__nessieDesktopPlatform = 'windows'
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => undefined,
    }
    window.__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        if (command === 'executor_companion_status') {
          return {
            availability: 'available',
            executors: [{
              daemonStatus: 'running',
              executorId: activeExecutorId,
              operationKeys: ['file.list', 'file.read', 'file.write', 'workspace.review', 'sandbox.stop'],
              workspaceConfigured: true,
              workspaceLabel: 'Nessie',
            }],
            platform: 'windows',
            reason: 'This signed Windows release can run the local executor companion.',
          }
        }
        if (command === 'plugin:window|is_maximized' || command === 'plugin:window|is_fullscreen') return false
        if (command === 'plugin:event|listen') return 1
        return null
      },
      metadata: {
        currentWebview: { label: 'main', windowLabel: 'main' },
        currentWindow: { label: 'main' },
      },
      transformCallback: (callback) => {
        callbackId += 1
        callbacks.set(callbackId, callback)
        return callbackId
      },
      unregisterCallback: (id) => callbacks.delete(id),
    }
  }, { activeExecutorId: executorId })

  page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${ADMIN_URL}/agents/executors`)
  await page.setContent(`<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import "/@fs/${fixturePath}"</script></body></html>`)
  await page.getByRole('heading', { name: 'Nessie Desktop companion' }).waitFor()

  const text = await page.locator('body').innerText()
  for (const expected of [
    'Local daemon: running · Folder: Nessie',
    'Change folder',
    'Save local policy',
    'Forget pairing on this computer',
    'permanently deletes local draft copies',
  ]) {
    if (!text.includes(expected)) throw new Error(`Executor companion visual is missing: ${expected}`)
  }
  if (text.includes('C:\\') || text.includes('/Users/')) {
    throw new Error('Executor companion visual disclosed a full local path.')
  }
  if (errors.length > 0) throw new Error(`Executor companion page errors: ${errors.join(' | ')}`)

  await mkdir(dirname(screenshotPath), { recursive: true })
  await page.screenshot({ fullPage: true, path: screenshotPath })
  console.log(`Executor companion visual passed: ${screenshotPath}`)
  await context.close()
} catch (error) {
  if (page) {
    await mkdir(dirname(failureScreenshotPath), { recursive: true })
    await page.screenshot({ fullPage: true, path: failureScreenshotPath }).catch(() => undefined)
    console.error(`Executor companion failure screenshot: ${failureScreenshotPath}`)
  }
  throw error
} finally {
  await browser.close()
  await stopProcess(admin)
}
