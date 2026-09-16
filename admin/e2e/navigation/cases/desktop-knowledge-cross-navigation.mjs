// Every pinned Knowledge destination must remain reachable from every other
// one. Each space opens its real page before the next hop, proving that the
// route and the nested page state do not overwrite each other.
//
// Dashboards used to be one of the destinations here, because they were filed
// under Knowledge. They live in projects now, and their own cross-navigation
// is `desktop-project-dashboard-tile`.
import { createChecks } from '../lib/expect.mjs'
import { gotoPath, shot } from '../lib/page.mjs'
import { seedKnowledgeNavigation } from '../lib/seed.mjs'

const pathOf = (destination) =>
  `/knowledge-base/spaces/${encodeURIComponent(destination.id)}`

const spaceSection = (page, destination) => destination.section === 'my-docs'
  ? page.locator('#kb-my-docs')
  : page.locator('#kb-spaces')

const openDestination = async (page, checks, destination, label) => {
  const section = spaceSection(page, destination)
  const row = destination.section === 'my-docs'
    ? section.locator('button.admin-sb-item').first()
    : section.locator('button.admin-sb-item').filter({ hasText: destination.name }).first()
  await row.click()
  await page.waitForURL(new RegExp(`${pathOf(destination).replaceAll('/', '\\/')}$`, 'u'))
  const pageRow = section
    .locator('.knowledge-sidebar-tree button')
    .filter({ hasText: destination.page.title })
    .first()
  await pageRow.waitFor()
  await pageRow.click()
  await page.locator('.kb-reader h1').filter({ hasText: destination.page.title }).waitFor()

  checks.equal(`${label}: route`, new URL(page.url()).pathname, pathOf(destination))
  checks.ok(
    `${label}: page detail rendered`,
    await page.locator('.kb-reader h1').filter({ hasText: destination.page.title }).count() > 0,
  )
}

export const desktopKnowledgeCrossNavigation = {
  name: 'desktop-knowledge-cross-navigation',
  run: async ({ page, seed }) => {
    const checks = createChecks('desktop-knowledge-cross-navigation')
    const destinations = await seedKnowledgeNavigation(seed.token, seed.project.id)
    page.setDefaultNavigationTimeout(120_000)
    await gotoPath(page, '/knowledge-base')
    await page.waitForSelector('#kb-my-docs button.admin-sb-item', { timeout: 60_000 })
    await page.waitForSelector('#kb-spaces button.admin-sb-item', { timeout: 60_000 })

    for (const source of destinations) {
      await openDestination(page, checks, source, `enter ${source.name}`)
      for (const target of destinations) {
        if (target.id === source.id) continue
        await openDestination(page, checks, target, `${source.name} → ${target.name}`)
        await openDestination(page, checks, source, `return to ${source.name}`)
      }
    }

    const frames = [await shot(page, 'desktop-knowledge-cross-navigation', '00-final')]
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'desktop',
}
