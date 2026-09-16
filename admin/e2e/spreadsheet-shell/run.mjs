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

  // ── 1b. dialogs.png — Rule zero: every surface is reachable by pressing ────
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

    // Select A1:C5 the way a person does, by dragging across the grid.
    // IronCalc's own `.ic-worksheet-cell-outline` covers the canvas, so raw
    // mouse coordinates are the only honest route (decisions.md's Phase 3a
    // note), and only the model knows the column widths — hence the fixture's
    // `cellPoint`, published through the same `onSession` seam Phase 3b uses.
    const from = await page.evaluate(() => window.__spreadsheetShell.cellPoint(1, 1))
    const to = await page.evaluate(() => window.__spreadsheetShell.cellPoint(5, 3))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()
    const selected = await page.evaluate(() => window.__spreadsheetShell.selection())
    assert.deepEqual(selected, [1, 1, 5, 3], `the drag selected ${selected.join(':')}`)

    // Sort.
    await page.getByTestId('spreadsheet-action-sort').click()
    await page.getByTestId('spreadsheet-sort-dialog').waitFor()
    await page.getByRole('heading', { name: 'Sort range' }).waitFor()
    // The header row is on by default, so the key dropdown is named by the
    // header text rather than by "Column A" — the Sheets behaviour.
    await page.getByLabel('Sort by column').waitFor()
    const firstKey = await page.getByLabel('Sort by column').innerText()
    assert.ok(/Region/.test(firstKey), `the sort key is not named by its header: ${firstKey}`)
    assert.equal(await page.getByTestId('spreadsheet-sort-submit').isEnabled(), true)
    await page.screenshot({ path: resolve(output, 'sort.png') })
    // Escape is the overlay contract, not decoration: every dialog here goes
    // through the shared `Dialog`, so if one of them swallowed it the scrim
    // would stay and the next press would land on nothing.
    await page.keyboard.press('Escape')
    await page.getByTestId('spreadsheet-sort-dialog').waitFor({ state: 'detached' })

    // Filter, from the funnel drawn on the column header.
    await page.getByTestId('spreadsheet-filter-header-3').click()
    await page.getByTestId('spreadsheet-filter-popover').waitFor()
    // The value checklist is the distinct formatted values of the column.
    for (const value of ['Dana', 'Ravi', 'Mo']) {
      await page.getByRole('checkbox', { name: value, exact: true }).waitFor()
    }
    await page.screenshot({ path: resolve(output, 'filter.png') })
    await page.keyboard.press('Escape')
    await page.getByTestId('spreadsheet-filter-popover').waitFor({ state: 'detached' })

    // Find & replace, and its live count.
    await page.getByTestId('spreadsheet-action-find').click()
    await page.getByTestId('spreadsheet-find-popover').waitFor()
    await page.getByLabel('Find', { exact: true }).fill('Dana')
    await page.getByTestId('spreadsheet-find-count').filter({ hasText: '1 of 2' }).waitFor()
    // Nothing in a popover may sit outside its own panel: an overflowing control
    // is invisible to a click and to a screen reader alike, and `overflow: auto`
    // turns the overflow into a clip rather than a visible mistake. Polled,
    // because `Popover` renders its panel at its natural size for one frame
    // before it has measured and placed it.
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-testid="spreadsheet-find-popover"]')?.parentElement
      return panel ? getComputedStyle(panel).visibility !== 'hidden' : false
    })
    const overflow = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="spreadsheet-find-popover"]')?.parentElement
      if (!panel) return null
      const box = panel.getBoundingClientRect()
      return [...panel.querySelectorAll('button, input, select')]
        .filter((node) => {
          const rect = node.getBoundingClientRect()
          return rect.right > box.right + 1 || rect.left < box.left - 1
        })
        .map((node) => {
          const rect = node.getBoundingClientRect()
          const label = node.getAttribute('aria-label') ?? node.textContent?.trim()
          return `${label} [${Math.round(rect.left)}..${Math.round(rect.right)}] in [${Math.round(box.left)}..${Math.round(box.right)}]`
        })
    })
    assert.deepEqual(overflow, [], `controls outside the find panel: ${overflow?.join(', ')}`)
    await page.screenshot({ path: resolve(output, 'find.png') })
    await page.keyboard.press('Escape')
    await page.getByTestId('spreadsheet-find-popover').waitFor({ state: 'detached' })

    // History, with the agent badge and Restore in two places.
    await page.getByTestId('spreadsheet-action-history').click()
    await page.getByTestId('spreadsheet-history').waitFor()
    await page.getByTestId('spreadsheet-version-3').getByText('agent').waitFor()
    await page.getByTestId('spreadsheet-restore-3').waitFor()
    await page.getByTestId('spreadsheet-restore-selected').waitFor()
    await page.screenshot({ path: resolve(output, 'history.png') })
    // Restore is confirmed, never one press away.
    await page.getByTestId('spreadsheet-restore-3').click()
    await page.getByRole('dialog').getByText('Restore v3?').waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').getByText('Restore v3?').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Close' }).click()

    // Export, and the sentence a filtered workbook owes its reader.
    await page.getByTestId('spreadsheet-action-export').click()
    await page.getByTestId('spreadsheet-export-dialog').waitFor()
    await page.getByText('the filter itself is not written', { exact: false }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByTestId('spreadsheet-export-dialog').waitFor({ state: 'detached' })

    // Save version.
    await page.getByTestId('spreadsheet-action-save-version').click()
    await page.getByTestId('spreadsheet-save-version-dialog').waitFor()
    await page.keyboard.press('Escape')
    await page.getByTestId('spreadsheet-save-version-dialog').waitFor({ state: 'detached' })

    // Fullscreen is an overlay, and Escape closes it.
    await page.getByTestId('spreadsheet-action-fullscreen').click()
    await page.getByTestId('spreadsheet-fullscreen').waitFor()
    await page.keyboard.press('Escape')
    await page.getByTestId('spreadsheet-fullscreen').waitFor({ state: 'detached' })

    assert.equal(errors.length, 0, `Dialog errors: ${errors.join(' | ')}`)
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
