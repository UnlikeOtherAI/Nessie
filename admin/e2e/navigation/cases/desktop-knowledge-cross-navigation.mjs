// Every pinned Knowledge destination must remain reachable from every other
// one. Each root folder opens its real page before the next hop, proving that
// the route and the nested page state do not overwrite each other.
//
// Dashboards used to be one of the destinations here, because they were filed
// under Knowledge. They live in projects now, and their own cross-navigation
// is `desktop-project-dashboard-tile`.
//
// The hops used to be driven through the Knowledge sidebar's `#kb-my-docs` and
// `#kb-spaces` sections. That sidebar is gone: Documents is a Finder and its
// first column *is* the root. The rule this case guards is unchanged — only
// the surface it is asserted on moved.
import { createChecks } from '../lib/expect.mjs'
import { gotoPath, shot } from '../lib/page.mjs'
import { seedKnowledgeNavigation } from '../lib/seed.mjs'

const pathOf = (destination) =>
  `/knowledge-base/spaces/${encodeURIComponent(destination.id)}`

// A root row is addressed by the space it opens, never by its label: the
// personal row is titled "My Documents" while the space itself is named
// "My Docs", and a case that matched on text would pin that disagreement.
const rootRow = (page, destination) =>
  page.locator(`[data-finder-row="${destination.id}"]`).first()

const openDestination = async (page, checks, destination, label) => {
  await rootRow(page, destination).click()
  await page.waitForURL(new RegExp(`${pathOf(destination).replaceAll('/', '\\/')}$`, 'u'))

  // The folder column beside the root lists the space's own pages. A document
  // opens on a double click, not the single one that selects it — a folder and
  // a root row open on one, an item waits, so a selection can be extended
  // without opening every document on the way.
  const pageRow = page.locator(`[data-finder-row="${destination.page.id}"]`).first()
  await pageRow.waitFor()
  await pageRow.dblclick()
  const reader = page.locator('.kb-reader h1').filter({ hasText: destination.page.title })
  await reader.waitFor()

  checks.equal(`${label}: route`, new URL(page.url()).pathname, pathOf(destination))
  checks.ok(`${label}: page detail rendered`, await reader.count() > 0)
}

export const desktopKnowledgeCrossNavigation = {
  name: 'desktop-knowledge-cross-navigation',
  run: async ({ page, seed }) => {
    const checks = createChecks('desktop-knowledge-cross-navigation')
    const destinations = await seedKnowledgeNavigation(seed.token, seed.project.id)
    page.setDefaultNavigationTimeout(120_000)
    await gotoPath(page, '/knowledge-base')
    // The root column is the screen now, so waiting for one seeded row is
    // waiting for the whole surface.
    for (const destination of destinations) {
      await rootRow(page, destination).waitFor({ timeout: 60_000 })
    }

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
