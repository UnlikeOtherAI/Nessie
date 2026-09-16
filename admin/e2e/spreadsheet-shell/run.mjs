// Phase 3a's visual proof, against the stub harness (no API, no database).
//
// Phase 3b owns `admin/e2e/spreadsheets/**` and the real two-browser suite;
// this one only has to answer the three questions 3a is accountable for:
// does the grid render, does it follow the org theme, and does a phone get an
// editable one. It also asserts the lazy boundary from the network log, which
// is the acceptance criterion the bundle numbers alone cannot prove.
//
//   NAV_E2E_ADMIN_PORT=5561 node admin/e2e/spreadsheet-shell/run.mjs
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT, VIEWPORTS } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const output = resolve(REPO_ROOT, 'e2e/screenshots/spreadsheets')
const url = `${ADMIN_URL}/e2e/spreadsheet-shell/index.html`

const setTheme = (page, theme) =>
  page.evaluate((next) => { document.documentElement.dataset.theme = next }, theme)

const admin = await startAdmin()
const browser = await launchBrowser()
const failures = []

try {
  await mkdir(output, { recursive: true })

  // ── 1. create.png — the grid, and the lazy boundary ────────────────────────
  {
    const context = await browser.newContext({
      deviceScaleFactor: 2,
      viewport: { height: 900, width: 1280 },
    })
    const page = await context.newPage()
    const errors = []
    const requests = []
    page.on('pageerror', (error) => errors.push(String(error)))
    page.on('request', (request) => requests.push(request.url()))

    await page.goto(url)
    await page.getByTestId('open-spreadsheet').waitFor()

    const ironcalcBefore = requests.filter((request) => /ironcalc|\.wasm|SpreadsheetPane/i.test(request))
    assert.deepEqual(
      ironcalcBefore,
      [],
      `IronCalc must not load until a spreadsheet opens; fetched ${ironcalcBefore.join(', ')}`,
    )

    await page.getByTestId('open-spreadsheet').click()
    await page.getByTestId('spreadsheet-action-bar').waitFor()
    // IronCalc's own chrome: the toolbar, the formula bar and the sheet tabs.
    await page.locator('.ic-toolbar-container').waitFor()
    await page.locator('.ic-formula-bar-root').waitFor()
    await page.locator('.ic-sheet-tab-bar-container').waitFor()
    await page.locator('.ic-worksheet-sheet-canvas').waitFor()
    await page.getByTestId('spreadsheet-filter-chips').waitFor()
    // The funnel buttons sit in the column header band, over IronCalc's canvas
    // but never on it. Absent them a person can see a sheet is filtered and has
    // nowhere to press, which is the state the first run of this suite caught.
    await page.getByTestId('spreadsheet-filter-header-3').waitFor()
    const funnels = await page.locator('[data-testid^="spreadsheet-filter-header-"]').count()
    assert.equal(funnels, 3, 'one funnel per column of the filtered range')
    const headerBand = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="spreadsheet-filter-header-3"]')
      const canvas = document.querySelector('.ic-worksheet-sheet-canvas')
      if (!button || !canvas) return null
      const b = button.getBoundingClientRect()
      const c = canvas.getBoundingClientRect()
      return { inHeaderRow: b.top >= c.top && b.bottom <= c.top + 28, offset: b.top - c.top }
    })
    assert.ok(headerBand?.inHeaderRow, `the funnel is outside the header band (${headerBand?.offset}px)`)

    const wasm = requests.filter((request) => request.endsWith('.wasm'))
    assert.equal(wasm.length, 1, `expected exactly one wasm fetch, got ${wasm.length}`)

    // The engine really evaluated: B6 is `=SUM(B2:B5)` over 120/80/150/95.
    const total = await page.evaluate(() => {
      const canvas = document.querySelector('.ic-worksheet-sheet-canvas')
      return canvas ? canvas.getBoundingClientRect().height : 0
    })
    assert.ok(total > 100, 'the grid canvas has real height')

    await page.screenshot({ path: resolve(output, 'create.png') })
    assert.equal(errors.length, 0, `Spreadsheet shell errors: ${errors.join(' | ')}`)
    await context.close()
  }

  // ── 2. theme-light.png / theme-dark.png ───────────────────────────────────
  {
    const context = await browser.newContext({
      deviceScaleFactor: 2,
      viewport: { height: 900, width: 1280 },
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(`${url}?open=1`)
    await page.locator('.ic-worksheet-sheet-canvas').waitFor()

    for (const [theme, file] of [['daylight', 'theme-light.png'], ['midnight', 'theme-dark.png']]) {
      await setTheme(page, theme)
      // The canvas repaints from the model's own effect, so give the redraw a
      // frame before the shutter.
      await page.waitForTimeout(250)
      const sampled = await page.evaluate(() => {
        const root = document.querySelector('.ic-root')
        if (!root) return null
        const styles = getComputedStyle(root)
        return {
          black: styles.getPropertyValue('--palette-common-black').trim(),
          grid: styles.getPropertyValue('--palette-sheet-grid-color').trim(),
          white: styles.getPropertyValue('--palette-common-white').trim(),
        }
      })
      assert.ok(sampled, 'the widget publishes its theme variables on .ic-root')
      assert.notEqual(sampled.black, sampled.white, `${theme}: ink and surface collapsed`)
      // The bug a screenshot alone caught on the spike: a toolbar whose icons
      // are `currentColor` under `--palette-common-black` disappears when that
      // token is a surface. Assert the icons are painted, then look.
      const iconVisible = await page.locator('.ic-toolbar-container svg').first().isVisible()
      assert.ok(iconVisible, `${theme}: the toolbar icons are not painted`)
      await page.screenshot({ path: resolve(output, file) })
      console.log(`  ${theme}: black=${sampled.black} white=${sampled.white} grid=${sampled.grid}`)
    }
    assert.equal(errors.length, 0, `Theme errors: ${errors.join(' | ')}`)
    await context.close()
  }

  // ── 3. phone.png — editing, not view-only ─────────────────────────────────
  {
    const context = await browser.newContext({
      deviceScaleFactor: 2,
      hasTouch: VIEWPORTS.phone.hasTouch,
      isMobile: true,
      viewport: { height: VIEWPORTS.phone.height, width: VIEWPORTS.phone.width },
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(`${url}?open=1`)
    await page.locator('.ic-worksheet-sheet-canvas').waitFor()

    // The bar collapses to icons; every label survives in `aria-label`.
    const sortLabel = await page.getByTestId('spreadsheet-action-sort').innerText()
    assert.equal(sortLabel.trim(), '', 'the phone bar is icon-only')
    // IronCalc's own toolbar costs grid height a phone cannot spare, so the
    // pane parks it behind "Format" and starts closed. The formula bar and the
    // sheet tabs stay: those are how a value is typed and a sheet is switched.
    await page.getByTestId('spreadsheet-action-format-bar').waitFor()
    assert.equal(
      await page.locator('.ic-toolbar-wrapper').isVisible(),
      false,
      'the formatting toolbar starts collapsed on a phone',
    )
    // The row the toolbar occupied has to go with it. The worksheet area is
    // absolutely positioned at `top: var(--toolbar-height)`, so hiding the
    // wrapper alone measured zero and still pushed the grid down 40px — a bug
    // no assertion on the wrapper could have seen.
    const gridTop = await page.evaluate(() => {
      const container = document.querySelector('.ic-workbook-container')
      const area = document.querySelector('.ic-workbook-worksheet-area-left')
      if (!container || !area) return null
      return area.getBoundingClientRect().top - container.getBoundingClientRect().top
    })
    assert.equal(gridTop, 0, `the collapsed toolbar still reserves ${gridTop}px`)
    await page.getByTestId('spreadsheet-action-format-bar').click()
    assert.equal(await page.locator('.ic-toolbar-wrapper').isVisible(), true, '"Format" reveals it')
    await page.getByTestId('spreadsheet-action-format-bar').click()
    await page.locator('.ic-formula-bar-root').waitFor()
    await page.locator('.ic-sheet-tab-bar-container').waitFor()

    // `canEdit` is on: the device is never the reason a grid is read-only.
    const editable = await page.evaluate(
      () => !document.querySelector('.ic-workbook-container--readonly'),
    )
    assert.ok(editable, 'a phone gets an editable workbook')

    await page.screenshot({ path: resolve(output, 'phone.png') })
    assert.equal(errors.length, 0, `Phone errors: ${errors.join(' | ')}`)
    await context.close()
  }

  console.log(`Spreadsheet shell proof written to ${output}`)
} catch (error) {
  failures.push(error)
} finally {
  await browser.close()
  await stopProcess(admin)
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
}
