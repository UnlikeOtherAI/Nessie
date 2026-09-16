import { launchBrowser } from './admin/e2e/navigation/lib/browser.mjs'
import { spawn } from 'node:child_process'
const server = spawn(process.execPath, ['../node_modules/vite/bin/vite.js', 'preview', '--port', '5472', '--strictPort', '--host', '127.0.0.1'], { cwd: 'web', detached: true, stdio: 'ignore' })
for (let i = 0; i < 60; i += 1) { try { if ((await fetch('http://127.0.0.1:5472/')).ok) break } catch {} await new Promise(d => setTimeout(d, 500)) }
const browser = await launchBrowser()
const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { height: 1000, width: 1280 } })
await ctx.addInitScript(() => window.localStorage.setItem('nessie-cookie-consent', JSON.stringify({ analytics: false, decided: true })))
const page = await ctx.newPage(); page.setDefaultTimeout(15000)
// Deep links must work, because nginx serves index.html for any path.
for (const path of ['/docs/installation', '/docs/api', '/docs/mcp', '/docs/executors', '/eu', '/terms', '/privacy', '/nonsense']) {
  await page.goto(`http://127.0.0.1:5472${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  const h1 = await page.locator('h1').first().textContent()
  console.log(`${path.padEnd(22)} h1="${h1}"  title="${await page.title()}"`)
}
// The chevron promise: every chevron must open a panel.
await page.goto('http://127.0.0.1:5472/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
const chevrons = await page.locator('.n-nav-chevron').count()
const triggers = await page.locator('.n-nav-menu-trigger').count()
console.log(`chevrons: ${chevrons}, menu triggers: ${triggers}`)
await page.locator('.n-nav-menu-trigger').first().click()
await page.waitForTimeout(500)
console.log('panel open after click:', await page.locator('.n-nav-panel-open').count())
await page.screenshot({ path: process.argv[2] })
await page.goto('http://127.0.0.1:5472/docs/installation', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.screenshot({ path: process.argv[3] })
await browser.close()
try { process.kill(-server.pid, 'SIGTERM') } catch {}
