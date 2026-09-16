// Driving the Documents Finder the way a person does — no test-only hook in
// `admin/src`, and no URL that names the thing being opened.
//
// Rule zero is the whole reason this file exists: every other case in this
// suite reaches a spreadsheet by its address, which proves the pane works and
// proves nothing at all about whether anybody can get to one. These helpers
// click what is on the screen.
import { ADMIN_URL } from '../../navigation/lib/config.mjs'

/** The Finder, open on a space, with its rows loaded. */
export const openFinder = async (page, { spaceId }) => {
  await page.goto(`${ADMIN_URL}/knowledge-base/spaces/${spaceId}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.getByRole('button', { name: 'New', exact: true }).waitFor({ timeout: 60_000 })
}

/** Open the toolbar's New menu and read the answers it offers. */
export const newMenuLabels = async (page) => {
  await page.getByRole('button', { name: 'New', exact: true }).click()
  const menu = page.getByRole('menu').first()
  await menu.waitFor({ timeout: 10_000 })
  return menu.getByRole('menuitem').allInnerTexts()
}

/** Pick one row of the open New menu, by the label a person reads. */
export const pickNewMenuItem = async (page, label) => {
  await page.getByRole('menu').first().getByRole('menuitem', { name: label, exact: true }).click()
}

/** The Finder's rows, as `{ id, kind, title }`. */
export const finderRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-finder-row][data-finder-variant="item"]')].map((node) => ({
      id: node.getAttribute('data-finder-row'),
      kind: node.getAttribute('data-finder-kind'),
      title: node.textContent?.trim() ?? '',
    })))

/** Right-click a row, or the column's empty background, and read the menu. */
export const contextMenuLabels = async (page, target) => {
  await target.click({ button: 'right' })
  const menu = page.getByRole('menu').first()
  await menu.waitFor({ timeout: 10_000 })
  const items = await menu.getByRole('menuitem').all()
  const labels = []
  for (const item of items) {
    labels.push({
      disabled: (await item.getAttribute('aria-disabled')) === 'true',
      label: (await item.innerText()).trim(),
      reason: (await item.getAttribute('title')) ?? '',
    })
  }
  return labels
}

export const closeMenu = async (page) => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(120)
}
