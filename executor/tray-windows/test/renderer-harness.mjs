// Both native hosts render this exact document. Only native IPC is replaced.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const ui = join(root, 'packages/executor-console')
const output = join(root, '.artifacts/executor-console')
await mkdir(output, { recursive: true })
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined)
const browser = await chromium.launch({ executablePath, headless: true })
try {
  for (const host of ['windows', 'macos']) {
    const context = await browser.newContext({ viewport: { width: 640, height: 680 } })
    await context.addInitScript((host) => {
      window.calls = []
      window.pairStatus = 'idle'
      window.paired = []
      window.policies = {}
      window.enabled = false
      const invoke = async (command, args = {}) => {
        window.calls.push({ command, args })
        const id = args.executorId
        if (command === 'executor_view') return { kind: 'reachable', executors: window.paired }
        if (command === 'executor_choose_folder') return '/Users/person/Work'
        if (command === 'executor_pairing_start') window.pairStatus = 'waiting'
        if (command === 'executor_pairing_cancel') window.pairStatus = 'cancelled'
        if (command === 'executor_pairing_confirm') {
          window.pairStatus = 'paired'
          const executorId = `team-${window.paired.length}`
          window.paired.push({ executorId, daemonStatus: 'running' })
          window.policies[executorId] = { mode: 'all', allowlist: [], denylist: [] }
        }
        if (command.startsWith('executor_pairing_')) return {
          status: id ? 'paired' : window.pairStatus, code: '01234567',
          expiresAt: new Date(Date.now() + 590000).toISOString(), claimDigest: 'displayed-claim',
          fingerprint: 'sha256:0123456789abcdef', machineName: 'My computer',
          organizationName: 'UnlikeOtherAI', teamName: id === 'team-1' ? 'Research' : 'Platform',
          apiBaseUrl: 'https://api.nessie.works',
        }
        if (command === 'executor_configure') window.policies[id] = args.configurationInput.commandPolicy ?? window.policies[id]
        if (['executor_describe', 'executor_console_describe', 'executor_configure'].includes(command)) return {
          executorId: id, apiBaseUrl: 'https://api.nessie.works', commandPolicy: window.policies[id],
          policy: { operations: ['file.read'], permittedPrograms: [], revision: 1 },
          reach: { folders: [{ name: 'work', path: '/Users/person/Work' }] },
        }
        if (command === 'executor_autostart') return { enabled: window.enabled, note: 'Start at login' }
        if (command === 'executor_set_autostart') window.enabled = args.enabled
        return null
      }
      if (host === 'windows') window.__TAURI__ = { core: { invoke }, event: { listen: async () => undefined } }
      else window.webkit = { messageHandlers: { executor: { postMessage: ({ command, args }) => invoke(command, args) } } }
    }, host)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.setDefaultTimeout(12000)
    await page.route('http://localhost:5875/**', async (route) => {
      const file = new URL(route.request().url()).pathname.slice(1) || 'index.html'
      assert.ok(['index.html', 'style.css', 'native.js', 'main.js', 'pairing.js', 'permissions.js'].includes(file))
      await route.fulfill({ body: await readFile(join(ui, file)), contentType: file.endsWith('.js')
        ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' })
    })
    await page.goto('http://localhost:5875/')
    await page.getByRole('button', { name: 'Add team', exact: true }).click()
    await page.getByRole('button', { name: 'Get pairing code' }).click()
    await page.waitForFunction(() => document.getElementById('pairing-code').textContent === '01234567')
    assert.equal(await page.locator('#pairing-code').evaluate((node) => getComputedStyle(node).color), 'rgb(0, 0, 0)')
    await page.getByRole('button', { name: 'Copy pairing code' }).click()
    assert.deepEqual(await page.evaluate(() => window.calls.find((call) => call.command === 'executor_copy_code').args), { code: '01234567' })
    await page.screenshot({ path: join(output, `${host}-code.png`), fullPage: true })
    await page.evaluate(() => { window.pairStatus = 'confirmation' })
    await page.getByRole('button', { name: 'Confirm and connect' }).click()
    await page.waitForSelector('.connection-row')
    await page.getByRole('button', { name: 'Add team', exact: true }).click()
    await page.getByRole('button', { name: 'Get pairing code' }).click()
    await page.evaluate(() => { window.pairStatus = 'confirmation' })
    await page.getByRole('button', { name: 'Confirm and connect' }).click()
    await page.waitForFunction(() => document.querySelectorAll('.connection-row').length === 2)
    await page.screenshot({ path: join(output, `${host}-teams.png`), fullPage: true })
    await page.locator('[data-tab="commands"]').click()
    await page.locator('#command-mode').selectOption('allowlist')
    await page.locator('#command-allowlist').fill('git *')
    await page.locator('#command-denylist').fill('git push *')
    await page.getByRole('button', { name: 'Save command permissions' }).click()
    await page.waitForFunction(() => window.policies['team-0'].mode === 'allowlist')
    assert.deepEqual(await page.evaluate(() => window.policies['team-1']), { mode: 'all', allowlist: [], denylist: [] })
    await page.locator('#connection').selectOption('team-1')
    await page.waitForFunction(() => document.getElementById('command-mode').value === 'all')
    await page.screenshot({ path: join(output, `${host}-commands.png`), fullPage: true })
    await page.locator('[data-tab="folders"]').click()
    assert.match(await page.locator('#reach-folders').textContent(), /Work/)
    await page.screenshot({ path: join(output, `${host}-folders.png`), fullPage: true })
    await page.locator('[data-tab="settings"]').click()
    await page.locator('#autostart').check()
    await page.waitForFunction(() => window.enabled)
    await page.screenshot({ path: join(output, `${host}-settings.png`), fullPage: true })
    assert.deepEqual(errors, [])
    await context.close()
  }
  process.stdout.write(`Shared Windows/macOS console passed. Screenshots: ${output}\n`)
} finally { await browser.close() }
