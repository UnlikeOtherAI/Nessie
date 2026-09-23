// A Knowledge destination is a route screen on a phone; only folders and an
// open document are nested stages beneath it. This catches the failure where
// the destination listing was pushed as a stage first and then covered by a
// second route screen that still painted the root picker.
import { createChecks } from '../lib/expect.mjs'
import { waitForStackSettled } from '../lib/freeze.mjs'
import { gotoPath, shot } from '../lib/page.mjs'
import { seedKnowledgeNavigation } from '../lib/seed.mjs'

const rootRow = (page, destination) =>
  page.locator(`[data-finder-row="${destination.id}"]`).first()

const pageRow = (page, destination) =>
  page.locator(`[data-finder-row="${destination.page.id}"]`).first()

const currentBack = async (page, label) => {
  // `ResponsivePageHeader` has an aria-hidden measurement mirror. Role
  // lookup excludes it; the viewport check distinguishes the current route
  // from retained stack layers with the same accessible label.
  const buttons = page.getByRole('button', { name: label, exact: true })
  const measurements = await buttons.evaluateAll((elements) => elements.map((element, index) => {
    const rect = element.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    return {
      current: rect.width > 0
      && rect.height > 0
      && centerX >= 0
      && centerX <= window.innerWidth
      && centerY >= 0
      && centerY <= window.innerHeight,
      index,
      label: element.getAttribute('aria-label'),
      rect: { height: rect.height, left: rect.left, top: rect.top, width: rect.width },
      viewport: { height: window.innerHeight, width: window.innerWidth },
    }
  }))
  const currentIndexes = measurements.filter(({ current }) => current).map(({ index }) => index)
  if (currentIndexes.length !== 1) {
    throw new Error(
      `expected one on-screen Knowledge Back doorway, found ${currentIndexes.length}: `
      + JSON.stringify(measurements),
    )
  }
  return buttons.nth(currentIndexes[0])
}

const pathOf = (destination) =>
  `/knowledge-base/spaces/${encodeURIComponent(destination.id)}`

export const phoneKnowledgeNavigation = {
  name: 'phone-knowledge-navigation',
  run: async ({ page, seed }) => {
    const checks = createChecks('phone-knowledge-navigation')
    const destinations = await seedKnowledgeNavigation(seed.token, seed.project.id)
    const destination = destinations.find((candidate) => candidate.name === 'Navigation Alpha')
      ?? destinations[0]
    if (!destination) throw new Error('the Knowledge navigation fixture created no destination')

    await gotoPath(page, '/knowledge-base')
    await rootRow(page, destination).waitFor({ timeout: 60_000 })

    const openedAt = Date.now()
    await rootRow(page, destination).click()
    await page.waitForURL(new RegExp(`${pathOf(destination).replaceAll('/', '\\/')}$`, 'u'))
    await pageRow(page, destination).waitFor({ timeout: 5_000 })
    const openDurationMs = Date.now() - openedAt
    await waitForStackSettled(page)

    checks.ok(
      'space listing replaces the root promptly',
      openDurationMs < 5_000,
      `${openDurationMs}ms`,
    )
    checks.ok('space page is visible', await pageRow(page, destination).isVisible())
    checks.equal(
      'space route is not duplicated as a nested column stage',
      await page.locator('[data-phone-navigation-route="stage:knowledge:column:1"]').count(),
      0,
    )

    await pageRow(page, destination).click()
    const reader = page.locator('.kb-reader h1').filter({ hasText: destination.page.title })
    await reader.waitFor()
    await waitForStackSettled(page)
    checks.ok('document opens from the space', await reader.isVisible())

    // The document is a nested stage inside its destination route. Its visible
    // header owns the first doorway; after that stage closes, the destination
    // route owns the second one.
    const documentBackLabel = `Back from ${destination.page.title}`
    const documentBack = await currentBack(page, documentBackLabel)
    checks.equal(
      'document stage uses its own Back doorway',
      await documentBack.getAttribute('aria-label'),
      documentBackLabel,
    )
    await documentBack.click()
    await pageRow(page, destination).waitFor()
    await waitForStackSettled(page)
    checks.ok('document Back restores the space', await pageRow(page, destination).isVisible())

    const spaceBackLabel = `Back from ${destination.name}`
    const spaceBack = await currentBack(page, spaceBackLabel)
    checks.equal(
      'space route uses the same Back doorway',
      await spaceBack.getAttribute('aria-label'),
      spaceBackLabel,
    )
    await spaceBack.click()
    await rootRow(page, destination).waitFor()
    checks.equal('space Back restores the Knowledge root', new URL(page.url()).pathname, '/knowledge-base')

    // A second trip proves the restored root remains interactive rather than
    // being only a retained screenshot underneath the old route.
    await rootRow(page, destination).click()
    await pageRow(page, destination).waitFor({ timeout: 5_000 })
    await waitForStackSettled(page)
    checks.ok('the restored root can open the space again', await pageRow(page, destination).isVisible())

    const frames = [await shot(page, 'phone-knowledge-navigation', '00-reopened-space')]
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'phone',
}
