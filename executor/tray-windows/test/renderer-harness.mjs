// The real tray renderer, with only its Tauri transport replaced by a fixture.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
let html = await readFile(join(here, '../ui/index.html'), 'utf8')
for (const script of ['pairing', 'main']) {
  html = html.replace(`<script src="${script}.js"></script>`, `<script>${await readFile(join(here, `../ui/${script}.js`), 'utf8')}</script>`)
}
const output = join(here, '../../../.artifacts')
await mkdir(output, { recursive: true })
const bridge = `<script>
window.__trayCalls = [];
window.__pairingStatus = 'idle';
window.__TAURI__ = { core: { invoke: async (command, args = {}) => {
  window.__trayCalls.push({ command, args });
  if (command === 'executor_choose_folder') return 'C:/Users/person/Work';
  if (command === 'executor_view') return {kind:'reachable',executors:window.__pairingStatus === 'paired' ? [{executorId:'computer',daemonStatus:'starting'}] : []};
  if (command === 'executor_pairing_start') window.__pairingStatus = 'waiting';
  if (command === 'executor_pairing_cancel') window.__pairingStatus = 'cancelled';
  if (command === 'executor_pairing_confirm') window.__pairingStatus = 'paired';
  if (command.startsWith('executor_pairing_')) return {
    status:window.__pairingStatus, code:'01234567', expiresAt:new Date(Date.now()+590000).toISOString(),
    claimDigest:'sha256:displayed-claim', fingerprint:'sha256:0123456789abcdef',
    machineName:'My computer',organizationName:'UnlikeOtherAI',teamName:'Platform',executorId:'computer'
  };
}}, event:{listen:async()=>undefined}};
</script>`
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const browser = await chromium.launch({ executablePath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 520, height: 480 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(7000)
  await page.route('http://localhost:5455/__tray-preview', (route) => route.fulfill({
    body: html.replace('<head>', `<head>${bridge}`), contentType: 'text/html', status: 200,
  }))
  await page.goto('http://localhost:5455/__tray-preview')
  await page.click('#pair-form button[type="submit"]')
  await page.waitForSelector('#pairing-code span:nth-child(8)')
  assert.equal(await page.locator('#pairing-code').textContent(), '01234567')
  assert.match(await page.locator('#pairing-fingerprint').textContent(), /My computer.*0123456789abcdef/)
  assert.match(await page.locator('#pairing-time').textContent(), /Expires in 9:/)
  await page.screenshot({path:join(output,'tray-pairing-code.png')})
  await page.evaluate(() => { window.__pairingStatus = 'confirmation' })
  await page.waitForSelector('#pairing-confirm:visible')
  assert.equal(await page.locator('#pairing-destination').textContent(), 'UnlikeOtherAI · Platform')
  assert.equal(await page.locator('#pairing-code span').count(), 0)
  await page.screenshot({path:join(output,'tray-pairing-confirm.png')})
  await page.click('#pairing-confirm')
  await page.waitForFunction(() => window.__pairingStatus === 'paired')
  const calls = await page.evaluate(() => window.__trayCalls)
  assert.deepEqual(calls.find(call => call.command === 'executor_pairing_confirm').args, {claimDigest:'sha256:displayed-claim'})
  await page.click('#pair')
  await page.waitForSelector('#pairing-replace:visible')
  assert.match(await page.locator('#pairing-instruction').textContent(), /already paired/)
  await page.click('#pairing-stop')
  assert.equal((await page.evaluate(() => window.__trayCalls)).filter(call => call.command === 'executor_pairing_cancel').length, 0)
  assert.deepEqual(errors, [])
  console.log(`Tray pairing, confirmation and keep-existing flows passed. Screenshots: ${output}`)
} finally { await browser.close() }
