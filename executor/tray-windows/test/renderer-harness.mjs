// Browser-level proof for the tray renderer. It serves the real tray HTML at
// localhost:5455, but intercepts that one preview path so it never competes
// with Nessie's running admin server. The Tauri bridge is deliberately mocked:
// this proves renderer wiring only; Rust tests cover the native commands.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const html = await readFile(join(here, '../ui/index.html'), 'utf8')
const output = join(here, '../../../.artifacts/tray-renderer-preview.png')
await mkdir(dirname(output), { recursive: true })

const bridge = `<script>
window.__trayCalls = [];
window.__TAURI__ = { core: { invoke: async (command, args = {}) => {
  window.__trayCalls.push({ command, args });
  if (command === 'executor_pairing_backends') return [
    ['https://api.nessie.works', 'Nessie cloud'],
    ['http://127.0.0.1:5454', 'Local development API (127.0.0.1:5454)'],
    ['http://localhost:5454', 'Local development API (localhost:5454)'],
  ];
  if (command === 'executor_view') return { kind: 'reachable', executors: [] };
  if (command === 'executor_pair') throw 'The invitation belongs to a different Nessie backend. Select the backend that created it; pairing never falls back to another origin.';
  return undefined;
}}, event: { listen: async () => undefined } };
</script>`

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const browser = await chromium.launch({ executablePath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 320 } })
  page.setDefaultTimeout(5_000)
  await page.route('http://localhost:5455/__tray-preview', (route) => route.fulfill({
    body: html.replace('<head>', `<head>${bridge}`), contentType: 'text/html', status: 200,
  }))
  await page.goto('http://localhost:5455/__tray-preview', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#backend option:nth-child(3)', { state: 'attached' })
  assert.equal(await page.locator('#backend option').count(), 3)
  await page.click('#pair')
  await page.selectOption('#backend', 'http://localhost:5454')
  await page.locator('#open-nessie').evaluate((button) => button.click())
  assert.deepEqual(await page.evaluate(() => window.__trayCalls.find((call) => call.command === 'executor_open_nessie')), {
    command: 'executor_open_nessie', args: { apiBaseUrl: 'http://localhost:5454' },
  })
  await page.fill('#invitation', 'pair --api https://api.nessie.works --enrollment id --challenge value')
  await page.locator('#pair-form button[type="submit"]').click()
  assert.deepEqual(await page.evaluate(() => window.__trayCalls.find((call) => call.command === 'executor_pair')), {
    command: 'executor_pair', args: {
      invitation: 'pair --api https://api.nessie.works --enrollment id --challenge value',
      selectedApiBaseUrl: 'http://localhost:5454',
    },
  })
  const mismatch = await page.evaluate(() => String(document.querySelector('#headline')?.textContent))
  assert.match(mismatch, /different Nessie backend/)
  await page.screenshot({ path: output, timeout: 5_000 })
  process.stdout.write(`Renderer fixture passed; screenshot: ${output}\n`)
} finally {
  await browser.close()
}
