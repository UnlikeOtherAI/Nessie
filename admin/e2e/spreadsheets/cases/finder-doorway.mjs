import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChecks } from '../../navigation/lib/expect.mjs'
import { legacyXlsBytes, serverCsv, serverXlsx, uploadFileNode } from '../lib/seed.mjs'
import {
  closeMenu,
  contextMenuLabels,
  finderRows,
  newMenuLabels,
  openFinder,
  pickNewMenuItem,
} from '../lib/finder.mjs'
import {
  commit,
  focusGrid,
  formulaBarText,
  gotoCell,
  shot,
  typeDraft,
  until,
} from '../lib/grid.mjs'

/**
 * **Rule zero for this capability**: a person makes a spreadsheet, and reaches
 * it, without ever typing an address.
 *
 * Every other case in this suite opens `?pageId=…`. That proves the pane
 * works; it says nothing about whether the feature exists, and for a while it
 * did not — the Finder replaced the workspace the old "New spreadsheet" button
 * lived on, and the five green cases stayed green with no doorway anywhere in
 * the product.
 *
 * So this one clicks: the toolbar's New menu, the title dialog, the grid the
 * dialog lands on, and then back out to the folder to find the row it made —
 * with the value it typed read back from the **server**, not from the browser
 * that wrote it.
 */
export const run = async ({ contextFor, browser, seed }) => {
  const checks = createChecks('finder-doorway')
  const [ada] = seed.people
  const context = await contextFor(browser, ada)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const title = `Finder doorway ${Date.now()}`

  try {
    await openFinder(page, { spaceId: seed.spaceId })
    await shot(page, 'finder-doorway-1-finder')

    // ── The toolbar's New menu ────────────────────────────────────────────
    const offered = await newMenuLabels(page)
    checks.ok(
      'New offers a spreadsheet',
      offered.some((label) => label.trim() === 'Spreadsheet'),
      offered.join(' | '),
    )
    checks.ok(
      'and offers to build one from a file',
      offered.some((label) => label.trim() === 'Spreadsheet from a file…'),
      offered.join(' | '),
    )
    await shot(page, 'finder-doorway-2-new-menu')

    await pickNewMenuItem(page, 'Spreadsheet')
    const dialog = page.getByTestId('spreadsheet-create-dialog')
    await dialog.waitFor({ timeout: 15_000 })
    await dialog.getByRole('textbox').fill(title)
    await shot(page, 'finder-doorway-3-title')
    await page.getByTestId('spreadsheet-create-submit').click()

    // ── It lands in the grid, not back in the list ────────────────────────
    await page.getByTestId('spreadsheet-action-bar').waitFor({ timeout: 90_000 })
    await page.locator('.ic-worksheet-sheet-canvas').waitFor({ timeout: 90_000 })
    await page.locator('.ic-formula-bar-address').first().waitFor({ timeout: 90_000 })
    checks.ok(
      'creating one opens it',
      await page.getByText(title, { exact: true }).first().isVisible(),
      page.url(),
    )
    // The columns are still there beside it: this is a Finder with a preview,
    // not a screen that replaced the place the person was standing in.
    checks.ok(
      'the folder it was made in is still on screen',
      (await page.locator('[data-finder-row]').count()) > 0,
    )
    await shot(page, 'finder-doorway-4-opened')

    // ── A real edit, read back from the server ────────────────────────────
    await focusGrid(page)
    await gotoCell(page, 'B2')
    await typeDraft(page, '1234')
    await commit(page)
    const rows = await finderRows(page)
    const made = rows.find((row) => row.title.startsWith(title))
    checks.ok('the new row is in the folder', Boolean(made), JSON.stringify(rows))
    checks.equal('and it is a spreadsheet, not a document', made?.kind, 'spreadsheet')

    if (made) {
      const csv = await until('the server to hold the typed value', async () => {
        const text = await serverCsv(made.id, seed.ownerToken)
        return text.includes('1234') ? text : null
      })
      checks.ok('the value reached the server', csv.includes('1234'), csv.slice(0, 120))
    }

    // ── The folder's own background menu offers it too ────────────────────
    const background = page.locator('.finder-drop-body').first()
    const backgroundItems = await contextMenuLabels(page, background)
    checks.ok(
      'a folder’s background menu offers New spreadsheet',
      backgroundItems.some((item) => item.label === 'New spreadsheet'),
      backgroundItems.map((item) => item.label).join(' | '),
    )
    await shot(page, 'finder-doorway-5-background-menu')
    await closeMenu(page)

    // ── The row's own menu: no second "Edit", and nothing to convert ──────
    if (made) {
      const row = page.locator(`[data-finder-row="${made.id}"]`)
      const rowItems = await contextMenuLabels(page, row)
      const labels = rowItems.map((item) => item.label)
      checks.ok('a spreadsheet row opens and nothing else claims to edit it',
        labels.includes('Open') && !labels.includes('Edit'), labels.join(' | '))
      checks.ok('it keeps its versions', labels.includes('Version history'), labels.join(' | '))
      checks.ok('and never offers to convert itself',
        !labels.includes('Open as spreadsheet'), labels.join(' | '))
      await shot(page, 'finder-doorway-6-row-menu')
      await closeMenu(page)
    }

    // ── An uploaded workbook, and the one that cannot be opened ───────────
    if (made) {
      const xlsx = await serverXlsx(made.id, seed.ownerToken)
      const uploaded = await uploadFileNode({
        bytes: xlsx,
        filename: 'Uploaded book.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        spaceId: seed.spaceId,
        token: seed.ownerToken,
      })
      const legacy = await uploadFileNode({
        bytes: legacyXlsBytes(),
        filename: 'Old book.xls',
        mime: 'application/vnd.ms-excel',
        spaceId: seed.spaceId,
        token: seed.ownerToken,
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator(`[data-finder-row="${uploaded.id}"]`).waitFor({ timeout: 30_000 })

      const xlsxItems = await contextMenuLabels(page, page.locator(`[data-finder-row="${uploaded.id}"]`))
      const convert = xlsxItems.find((item) => item.label === 'Open as spreadsheet')
      checks.ok('an uploaded .xlsx offers to open as a spreadsheet',
        Boolean(convert), xlsxItems.map((item) => item.label).join(' | '))
      checks.equal('and it is offered, not greyed', convert?.disabled, false)
      await shot(page, 'finder-doorway-7-convert')
      await closeMenu(page)

      const xlsItems = await contextMenuLabels(page, page.locator(`[data-finder-row="${legacy.id}"]`))
      const refused = xlsItems.find((item) => item.label === 'Open as spreadsheet')
      // Shown and greyed, never missing: an `.xls` that simply had no doorway
      // would read as a broken file rather than a format we cannot open.
      checks.ok('an .xls is refused rather than silently absent', Boolean(refused),
        xlsItems.map((item) => item.label).join(' | '))
      checks.equal('it is disabled', refused?.disabled, true)
      checks.ok('and it says why', (refused?.reason ?? '').includes('.xlsx'), refused?.reason ?? '')
      await shot(page, 'finder-doorway-8-xls-refused')
      await closeMenu(page)

      // The conversion itself: a new spreadsheet page beside the file, with
      // the file left alone — converting is additive.
      await page.locator(`[data-finder-row="${uploaded.id}"]`).click({ button: 'right' })
      await page.getByRole('menu').first()
        .getByRole('menuitem', { name: 'Open as spreadsheet', exact: true }).click()
      await page.getByTestId('spreadsheet-action-bar').waitFor({ timeout: 90_000 })
      // The route answers 202 and the worker parses, so the page opens on
      // "Loading the grid…". It has to *finish* — a doorway that lands on a
      // permanent spinner is not a doorway.
      const parsed = await page.locator('.ic-worksheet-sheet-canvas')
        .waitFor({ timeout: 90_000 }).then(() => true, (error) => String(error))
      checks.ok('the converted workbook finishes loading', parsed === true, String(parsed).slice(0, 200))
      // And it holds what the file held. The doorway used to open the page on
      // the `202`, before the worker had put anything in it, and the grid then
      // stayed empty for good.
      await focusGrid(page)
      await gotoCell(page, 'B2')
      const converted = await formulaBarText(page)
      checks.ok('and it holds the value the file held', converted.includes('1234'),
        JSON.stringify(converted))
      const after = await finderRows(page)
      checks.ok('the uploaded file is still there',
        after.some((row) => row.id === uploaded.id && row.kind === 'file'),
        JSON.stringify(after.map((row) => `${row.kind}:${row.title}`)))
      checks.ok('and a spreadsheet was built beside it',
        after.filter((row) => row.kind === 'spreadsheet').length >= 2,
        JSON.stringify(after.map((row) => `${row.kind}:${row.title}`)))
      await shot(page, 'finder-doorway-9-converted')
    }

    // ── Import: the same bytes, as a workbook rather than a file node ─────
    if (made) {
      const directory = await mkdtemp(join(tmpdir(), 'finder-doorway-'))
      const path = join(directory, 'Imported book.xlsx')
      await writeFile(path, await serverXlsx(made.id, seed.ownerToken))

      await page.getByRole('button', { name: 'New', exact: true }).click()
      await page.getByRole('menu').first()
        .getByRole('menuitem', { name: 'Spreadsheet from a file…', exact: true }).click()
      const dialog = page.getByTestId('spreadsheet-import-dialog')
      await dialog.waitFor({ timeout: 15_000 })

      // The refusal first: an `.xls` never reaches the wire.
      const legacyPath = join(directory, 'Old.xls')
      await writeFile(legacyPath, legacyXlsBytes())
      await page.locator('input[type=file]').last().setInputFiles(legacyPath)
      await page.waitForTimeout(400)
      checks.ok('an .xls is refused in the dialog, with the reason',
        (await dialog.innerText()).includes('.xlsx'), (await dialog.innerText()).slice(0, 200))
      await shot(page, 'finder-doorway-10-import-xls')

      await page.locator('input[type=file]').last().setInputFiles(path)
      await page.getByTestId('spreadsheet-import-open').waitFor({ timeout: 90_000 })
      await shot(page, 'finder-doorway-11-import-done')
      await page.getByTestId('spreadsheet-import-open').click()
      await page.getByTestId('spreadsheet-action-bar').waitFor({ timeout: 90_000 })
      await page.locator('.ic-worksheet-sheet-canvas').waitFor({ timeout: 90_000 })
      await focusGrid(page)
      await gotoCell(page, 'B2')
      const imported = await formulaBarText(page)
      checks.ok('an imported workbook opens with its contents', imported.includes('1234'),
        JSON.stringify(imported))
      await shot(page, 'finder-doorway-12-import-opened')
    }

    checks.ok('no page errors', errors.length === 0, errors.join(' | '))
  } finally {
    await context.close()
  }
  checks.close()
  return checks.checks
}
