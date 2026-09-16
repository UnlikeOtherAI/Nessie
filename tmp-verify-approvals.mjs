import { chromium } from 'playwright-core'

const SHOT_DIR = process.env.SHOT_DIR
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true })
const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { height: 900, width: 1440 } })
await context.addInitScript(
  ([key, value]) => { window.localStorage.setItem(key, value) },
  ['nessie.admin.token', process.env.NESSIE_TOKEN],
)
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const base = `http://localhost:${process.env.ADMIN_PORT}`

// 1. The card, in the conversation the agent asked in.
await page.goto(`${base}/channels/a36a2afb-8753-4ad8-8aa5-f0f5011282c9`, { waitUntil: 'domcontentloaded' })
await page.locator('[data-testid="approval-gate"]').first().waitFor({ timeout: 30000 })
await page.waitForTimeout(1200)
await page.screenshot({ path: `${SHOT_DIR}/card.png`, fullPage: false })
const card = page.locator('[data-testid="approval-gate"]').first()
console.log('CARD TEXT:', (await card.innerText()).replace(/\s+/g, ' ').trim())
console.log('OPEN SUBJECT BUTTON:', await page.locator('[data-testid="approval-gate-open-subject"]').count())

// 2. The sidebar no longer offers Approvals anywhere.
const navText = await page.locator('nav, aside').first().innerText().catch(() => '')
console.log('SIDEBAR HAS APPROVALS:', /Approvals/.test(navText))
console.log('PENDING BADGE:', await page.locator('[data-testid="nav-approvals-pending-count"]').count())

// 3. The page itself is gone.
await page.goto(`${base}/approvals`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.screenshot({ path: `${SHOT_DIR}/gone.png`, fullPage: false })
console.log('AT /approvals:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim().slice(0, 220))

console.log('PAGE ERRORS:', errors)
await browser.close()
