// Visual check for the shared page header's action buttons: one board per
// theme, each with the five action shapes a real screen produces.
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const outDir = resolve(REPO_ROOT, 'e2e/screenshots/page-header')

const admin = await startAdmin()
const browser = await launchBrowser()
let page
try {
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { height: 1000, width: 1280 } })
  page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  // The fixture mounts the header alone: the app shell's own API calls are
  // not part of what it proves, and no API runs beside it.
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().includes('/api/')) {
      errors.push(`${response.status()} ${response.url()}`)
    }
  })
  await page.goto(`${ADMIN_URL}/e2e/page-header/index.html`)
  await page.getByRole('button', { name: 'New task' }).first().waitFor()
  await page.waitForTimeout(600)
  if (errors.length > 0) throw new Error(`Page header fixture errors: ${errors.join(' | ')}`)

  await mkdir(outDir, { recursive: true })
  for (const theme of ['sandstone', 'space-white', 'nebula', 'daylight', 'midnight', 'ocean']) {
    const board = page.locator(`[data-theme-board="${theme}"]`)
    await board.screenshot({ path: resolve(outDir, `${theme}.png`) })
  }
  await page.screenshot({ fullPage: true, path: resolve(outDir, 'all-themes.png') })

  // Hover and open states: the two the role classes have to survive.
  const sandstone = page.locator('[data-theme-board="sandstone"]')
  await sandstone.getByRole('button', { name: 'Members (1)' }).hover()
  await sandstone.locator('.admin-page-header').first().screenshot({ path: resolve(outDir, 'hover-secondary.png') })
  await sandstone.getByRole('button', { name: 'Configure' }).click()
  await page.waitForTimeout(200)
  await page.locator('body').screenshot({ path: resolve(outDir, 'menu-open.png') })
  console.log(`Page header visuals written to ${outDir}`)
  await context.close()
} finally {
  await browser.close()
  await stopProcess(admin)
}
