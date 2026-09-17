import { createChecks } from '../../navigation/lib/expect.mjs'
import { createSpreadsheet } from '../lib/seed.mjs'
import {
  address,
  cellCentre,
  focusGrid,
  longPressDrag,
  openSpreadsheet,
  shot,
  until,
} from '../lib/grid.mjs'

/**
 * Selecting a range with a finger.
 *
 * IronCalc's own `usePointer` ignores non-mouse pointers, so on a phone a drag
 * across the grid selects one cell and scrolls the sheet — measured in Spike
 * D, and the reason `useTouchSelection` exists at all. The gesture is
 * long-press, then drag, and its timing is the whole mechanism: a stationary
 * hold is what leaves the browser's scroll uncommitted, so the `touchmove`
 * that follows can still be prevented.
 *
 * What this case has to show, in a `hasTouch` context on a 390×844 viewport:
 * the range follows the finger, the two corner handles are drawn, and the
 * sheet **does not scroll** while it happens.
 */
export const run = async ({ browser, contextFor, seed }) => {
  const checks = createChecks('phone-touch')
  const page = await createSpreadsheet({
    spaceId: seed.spaceId,
    title: `Phone touch ${Date.now()}`,
    token: seed.ownerToken,
  })
  const [ada] = seed.people

  const context = await contextFor(browser, ada, {
    hasTouch: true,
    isMobile: true,
    viewport: { height: 844, width: 390 },
  })
  const phone = await context.newPage()
  const errors = []
  phone.on('pageerror', (error) => errors.push(String(error)))

  try {
    await openSpreadsheet(phone, { pageId: page.id, spaceId: seed.spaceId })
    await focusGrid(phone)

    const from = await cellCentre(phone, 'B2')
    const to = await cellCentre(phone, 'C4')
    const scrollBefore = await phone.evaluate(
      () => document.querySelector('.ic-worksheet-sheet-container')?.scrollTop ?? -1,
    )

    await longPressDrag(phone, from, to)

    const handles = await until('both corner handles to be drawn', async () => {
      const count = await phone.locator('[data-testid^="spreadsheet-touch-handle-"]').count()
      return count === 2 ? count : null
    })
    checks.equal('two corner handles', handles, 2)

    // The anchor is where the finger went down; the widget's address box shows
    // the range's anchor cell, which is what the long press selected.
    const anchor = await address(phone)
    checks.equal('the range is anchored at row 2', anchor.row, 2)
    checks.equal('and at column B', anchor.column, 2)

    // The handles bracket the dragged range: one at B2's top-left, one past
    // C4's bottom-right. Measured against the cells rather than asserted as
    // pixels, so a different row height cannot make this pass by luck.
    const boxes = await phone.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="spreadsheet-touch-handle-"]')].map((node) => {
        const rect = node.getBoundingClientRect()
        return { name: node.getAttribute('data-testid'), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }))
    const start = boxes.find((entry) => entry.name?.endsWith('start'))
    const end = boxes.find((entry) => entry.name?.endsWith('end'))
    checks.ok('the start handle sits above and left of the finger\'s origin',
      Boolean(start) && start.x < from.x && start.y < from.y, JSON.stringify(start))
    checks.ok('the end handle sits below and right of where it stopped',
      Boolean(end) && end.x > to.x && end.y > to.y, JSON.stringify(end))

    const scrollAfter = await phone.evaluate(
      () => document.querySelector('.ic-worksheet-sheet-container')?.scrollTop ?? -1,
    )
    checks.equal('the sheet did not scroll under the finger', scrollAfter, scrollBefore)

    // And the page itself is still where it was: the three `user-select`
    // declarations on the pane are what stop iOS answering a long press with
    // its own text selection, which on the first spike run painted a highlight
    // across the whole chrome.
    const selected = await phone.evaluate(() => (window.getSelection()?.toString() ?? '').length)
    checks.equal('no stray text selection', selected, 0)

    await shot(phone, 'phone-touch-range')
    checks.ok('no page errors', errors.length === 0, errors.join(' | '))
  } finally {
    await context.close()
  }
  checks.close()
  return checks.checks
}
