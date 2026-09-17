// Driving IronCalc's grid the way a person does, with no test-only hook in
// `admin/src`.
//
// Three facts make that possible, and all three were found by reading the
// widget rather than by guessing:
//
//  - `.ic-worksheet-cell-outline` is a real positioned div over the **selected
//    cell**, so selecting a cell and measuring that box is exact geometry. It
//    beats reconstructing row heights from the canvas, which is what the Spike
//    D prototype had to do, and it is also why Playwright cannot click the
//    canvas without `force` — the outline covers it.
//  - `.ic-formula-bar-address` renders the selected cell's reference, so the
//    harness can always read where it is instead of assuming.
//  - the grid takes the arrow keys, so navigation needs no coordinates at all:
//    read the address, press the difference, assert the address.
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { ADMIN_URL, REPO_ROOT } from '../../navigation/lib/config.mjs'

export const SCREENSHOT_DIR = resolve(REPO_ROOT, 'e2e', 'screenshots', 'spreadsheets')

export const shot = async (page, name) => {
  await mkdir(SCREENSHOT_DIR, { recursive: true })
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path })
  return path
}

const COLUMN = (label) => {
  let index = 0
  for (const character of label) index = index * 26 + (character.charCodeAt(0) - 64)
  return index
}

const parseA1 = (text) => {
  const match = /([A-Z]{1,3})([0-9]+)/.exec(text ?? '')
  if (!match) return null
  return { column: COLUMN(match[1]), row: Number(match[2]) }
}

/** Where the widget says the selection is. */
export const address = async (page) => {
  const text = await page.locator('.ic-formula-bar-address').first().textContent()
  const cell = parseA1(text)
  if (!cell) throw new Error(`the formula bar shows no cell reference (got "${text}")`)
  return cell
}

/** The cell's content as the formula bar renders it — how a second browser
 *  reads a value it did not write. */
export const formulaBarText = async (page) =>
  (await page.locator('.ic-formula-bar-formula-container').first().innerText()).trim()

export const openSpreadsheet = async (page, { pageId, spaceId }) => {
  await page.goto(`${ADMIN_URL}/knowledge-base/spaces/${spaceId}?pageId=${pageId}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.getByTestId('spreadsheet-action-bar').waitFor({ timeout: 90_000 })
  await page.locator('.ic-worksheet-sheet-canvas').waitFor({ timeout: 90_000 })
  await page.locator('.ic-formula-bar-address').first().waitFor({ timeout: 90_000 })
}

/**
 * Put the keyboard into the grid without changing the selection more than
 * once. The outline div covers the canvas, so a plain Playwright click is
 * refused as "intercepted" — `page.mouse` dispatches at viewport coordinates
 * and lands like a finger would.
 */
export const focusGrid = async (page) => {
  const canvas = await page.locator('.ic-worksheet-sheet-canvas').boundingBox()
  await page.mouse.click(canvas.x + 45, canvas.y + 40)
  await page.waitForTimeout(80)
}

/** Arrow-key navigation, verified against the address box rather than assumed. */
export const gotoCell = async (page, a1) => {
  const target = parseA1(a1)
  if (!target) throw new Error(`not a cell reference: ${a1}`)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const at = await address(page)
    if (at.row === target.row && at.column === target.column) return
    const down = target.row - at.row
    const right = target.column - at.column
    for (let step = 0; step < Math.abs(down); step += 1) {
      await page.keyboard.press(down > 0 ? 'ArrowDown' : 'ArrowUp')
    }
    for (let step = 0; step < Math.abs(right); step += 1) {
      await page.keyboard.press(right > 0 ? 'ArrowRight' : 'ArrowLeft')
    }
    await page.waitForTimeout(60)
  }
  const at = await address(page)
  if (at.row !== target.row || at.column !== target.column) {
    throw new Error(`could not reach ${a1}; the grid stopped at row ${at.row} column ${at.column}`)
  }
}

/** The selected cell's box in viewport coordinates — exact, from the widget's
 *  own outline div. */
export const cellBox = async (page, a1) => {
  await gotoCell(page, a1)
  const box = await page.locator('.ic-worksheet-cell-outline').boundingBox()
  if (!box || box.width < 1 || box.height < 1) {
    throw new Error(`the cell outline for ${a1} has no box`)
  }
  return box
}

export const cellCentre = async (page, a1) => {
  const box = await cellBox(page, a1)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Type into the selected cell **without committing**: this is what a peer
 *  should see as a draft. */
export const typeDraft = async (page, text) => {
  await page.keyboard.type(text, { delay: 60 })
}

export const commit = async (page) => {
  await page.keyboard.press('Enter')
  await page.waitForTimeout(120)
}

/** Poll until `check` is true, so a case never sleeps a fixed amount and calls
 *  it evidence. */
export const until = async (label, check, { timeoutMs = 20_000, everyMs = 150 } = {}) => {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await check()
    if (last) return last
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((done) => { setTimeout(done, everyMs) })
  }
}

/** The peers this pane is drawing, read off the overlay it renders. */
export const peersOnScreen = (page) =>
  page.evaluate(() => {
    const read = (selector) => [...document.querySelectorAll(selector)]
    return {
      drafts: read('[data-testid="spreadsheet-peer-draft"]').map((node) => node.textContent?.trim() ?? ''),
      ranges: read('[data-testid="spreadsheet-peer-range"]').map((node) => {
        const box = node.getBoundingClientRect()
        return { height: box.height, left: box.left, top: box.top, width: box.width }
      }),
      strip: read('[data-testid="spreadsheet-presence-strip"] [title]').map(
        (node) => node.getAttribute('title') ?? '',
      ),
      tags: read('[data-testid="spreadsheet-peer-tag"]').map((node) => node.textContent?.trim() ?? ''),
    }
  })

/**
 * A single-finger long press and drag, dispatched through CDP.
 *
 * Playwright's `touchscreen` can tap and nothing else, and the gesture under
 * test is defined by its *timing*: a stationary hold past 350 ms is what makes
 * WebKit and Chromium still honour `preventDefault()` on the `touchmove` that
 * follows, which is what stops the sheet scrolling under the finger. A
 * synthesised mouse drag would prove none of that.
 */
export const longPressDrag = async (page, from, to, { holdMs = 600, steps = 8 } = {}) => {
  const cdp = await page.context().newCDPSession(page)
  const touch = (type, point) =>
    cdp.send('Input.dispatchTouchEvent', {
      touchPoints: type === 'touchEnd' ? [] : [{ x: point.x, y: point.y, id: 1 }],
      type,
    })
  await touch('touchStart', from)
  await page.waitForTimeout(holdMs)
  for (let step = 1; step <= steps; step += 1) {
    await touch('touchMove', {
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
    })
    await page.waitForTimeout(40)
  }
  await touch('touchEnd', to)
  await cdp.detach()
}
