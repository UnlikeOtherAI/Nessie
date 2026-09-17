// Visual check for the shared page header's action buttons: one board per
// theme, each with the five action shapes a real screen produces.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const outDir = resolve(REPO_ROOT, 'e2e/screenshots/page-header')

// The geometry the tokens promise, per pointer kind. The compact geometry is
// the fine-pointer case; a coarse pointer restores the touch geometry so a
// finger keeps its 44px target (docs/standards/design-system.md).
const pinGeometry = async (page, { actionHeight, barHeight, label, toggleHeight }) => {
  const header = page.locator('[data-theme-board="sandstone"] header').first()
  const barBox = await header.locator('> div').first().boundingBox()
  assert.ok(barBox, `${label}: the bar row renders`)
  assert.ok(
    Math.abs(barBox.height - barHeight) < 1,
    `${label}: the bar is ${barHeight}px high (was ${barBox.height}px)`,
  )
  const action = page.getByRole('button', { name: 'New task' }).first()
  const actionBox = await action.boundingBox()
  assert.ok(actionBox, `${label}: an action renders`)
  assert.ok(
    Math.abs(actionBox.height - actionHeight) < 1,
    `${label}: an action is ${actionHeight}px high (was ${actionBox.height}px)`,
  )
  // The unlayered button reset beats a text-* utility, so the size must come
  // from the .admin-page-action rule — measure it, never assume it applied.
  const fontSize = await action.evaluate((element) => getComputedStyle(element).fontSize)
  assert.equal(fontSize, '12px', `${label}: the action label renders at the token size (was ${fontSize})`)
  const toggle = page.locator('.admin-page-toggle').first()
  const toggleBox = await toggle.boundingBox()
  assert.ok(toggleBox, `${label}: a toggle renders`)
  assert.ok(
    Math.abs(toggleBox.height - toggleHeight) < 1,
    `${label}: a toggle is ${toggleHeight}px high (was ${toggleBox.height}px)`,
  )
  console.log(
    `${label}: bar=${barBox.height}px action=${actionBox.height}px toggle=${toggleBox.height}px font=${fontSize}`,
  )
}

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
  await pinGeometry(page, { actionHeight: 31, barHeight: 35, label: 'fine pointer', toggleHeight: 22 })
  for (const theme of ['sandstone', 'nebula', 'daylight', 'midnight', 'ocean', 'graphite']) {
    const board = page.locator(`[data-theme-board="${theme}"]`)
    await board.screenshot({ path: resolve(outDir, `${theme}.png`) })
  }
  await page.screenshot({ fullPage: true, path: resolve(outDir, 'all-themes.png') })

  // Hover and open states: the two the role classes have to survive.
  const sandstone = page.locator('[data-theme-board="sandstone"]')
  await sandstone.getByRole('button', { name: 'Members (1)' }).hover()
  await sandstone.locator('header').first().screenshot({ path: resolve(outDir, 'hover-secondary.png') })
  // A disabled action must not repaint under the pointer: the dimming is the
  // only cue saying it cannot be pressed.
  const disabledEdit = sandstone.getByRole('button', { name: 'Edit' })
  await disabledEdit.hover({ force: true })
  await sandstone.locator('header').nth(2).screenshot({ path: resolve(outDir, 'hover-disabled.png') })
  await sandstone.getByRole('button', { name: 'Configure' }).click()
  await page.waitForTimeout(200)
  // The Configure menu pins the new row kinds: a `detail` sub-line under the
  // Sync row, separators between groups, and a non-interactive footnote.
  const syncRow = page.getByRole('menuitem', { name: /Sync/ })
  await syncRow.waitFor()
  const syncBox = await syncRow.boundingBox()
  if (!syncBox || syncBox.height < 44) {
    throw new Error(`the sync row keeps its 44px target (was ${syncBox?.height}px)`)
  }
  // A separator is aria-hidden by design, so count the DOM role rather than
  // the accessibility tree.
  if ((await page.locator('[role="separator"]').count()) !== 2) {
    throw new Error('the menu draws its two separators')
  }
  if ((await page.getByRole('menuitem', { name: /500 most recently/ }).count()) !== 0) {
    throw new Error('the footnote is not a menuitem')
  }
  await page.getByText('Showing the 500 most recently updated cards.').waitFor()
  await page.locator('body').screenshot({ path: resolve(outDir, 'menu-open.png') })
  await sandstone.getByRole('button', { name: 'Configure' }).click()

  // A narrow header must still offer every action through More: the overflow
  // controller measures the same boxes the bar renders, so the tokenised
  // geometry has to hold at the widths where actions collapse.
  await page.setViewportSize({ height: 1000, width: 400 })
  const moreButton = sandstone.getByRole('button', { name: 'More page actions' }).first()
  await moreButton.waitFor()
  await moreButton.click()
  await page.waitForTimeout(200)
  await page.locator('body').screenshot({ path: resolve(outDir, 'narrow-more-open.png') })
  console.log(`Page header visuals written to ${outDir}`)
  await context.close()

  // A coarse pointer keeps the touch geometry: the bar and its actions stay
  // at the sizes that give a finger its 44px target.
  const touchContext = await browser.newContext({
    deviceScaleFactor: 2,
    hasTouch: true,
    viewport: { height: 1024, width: 768 },
  })
  const touchPage = await touchContext.newPage()
  await touchPage.goto(`${ADMIN_URL}/e2e/page-header/index.html`)
  await touchPage.getByRole('button', { name: 'New task' }).first().waitFor()
  await touchPage.waitForTimeout(600)
  await pinGeometry(touchPage, { actionHeight: 44, barHeight: 50, label: 'coarse pointer', toggleHeight: 32 })
  const touchSandstone = touchPage.locator('[data-theme-board="sandstone"]')
  await touchSandstone.locator('header').first().screenshot({ path: resolve(outDir, 'coarse-pointer.png') })
  await touchContext.close()

  // At phone width the actions collapse into More, and the trigger that
  // remains is still a 44px target for a finger.
  const phoneContext = await browser.newContext({
    deviceScaleFactor: 2,
    hasTouch: true,
    viewport: { height: 844, width: 390 },
  })
  const phonePage = await phoneContext.newPage()
  await phonePage.goto(`${ADMIN_URL}/e2e/page-header/index.html`)
  const phoneMore = phonePage.getByRole('button', { name: 'More page actions' }).first()
  await phoneMore.waitFor()
  const phoneMoreBox = await phoneMore.boundingBox()
  assert.ok(phoneMoreBox && phoneMoreBox.height >= 44, `phone: the More trigger keeps a 44px target (was ${phoneMoreBox?.height}px)`)
  console.log(`phone coarse pointer: more=${phoneMoreBox.height}px`)
  await phonePage.locator('[data-theme-board="sandstone"] header').first().screenshot({ path: resolve(outDir, 'phone-coarse.png') })
  await phoneContext.close()
} finally {
  await browser.close()
  await stopProcess(admin)
}
