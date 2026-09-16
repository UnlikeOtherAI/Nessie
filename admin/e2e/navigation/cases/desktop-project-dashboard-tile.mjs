// A project's dashboards are live tiles on its Overview, and tapping one opens
// it full screen with a Back that returns to where the reader actually was.
//
// This replaced `desktop-dashboard-exit`, which guarded the organisation-wide
// `/dashboards` page inside Knowledge — the surface this change retired.
//
// What it proves that a unit test cannot: the tile renders the real
// `DashboardCanvas` rather than a placeholder (a widget's own data request
// crosses the wire for it), the scaled canvas is clipped to the tile instead of
// growing to its unscaled height, and the route the tile opens is the project's
// own with the ledger behind it.
import { createChecks } from '../lib/expect.mjs'
import { gotoPath, shot } from '../lib/page.mjs'
import { call, seedDashboardWorkspace } from '../lib/seed.mjs'

export const desktopProjectDashboardTile = {
  name: 'desktop-project-dashboard-tile',
  run: async ({ page, seed }) => {
    const checks = createChecks('desktop-project-dashboard-tile')
    // The first visit asks Vite to transform the full authenticated shell.
    page.setDefaultNavigationTimeout(120_000)

    const channel = seed.channels[0]
    const { dashboard } = await seedDashboardWorkspace({
      channel,
      projectId: seed.project.id,
      token: seed.token,
    })

    // The tile renders the live dashboard, so a widget's data is fetched for it.
    const widgetData = page.waitForResponse((response) =>
      response.request().method() === 'GET'
      && /\/api\/dashboard-widgets\/[^/]+\/data/u.test(response.url()),
    )
    await gotoPath(page, `/projects/${seed.project.id}`)
    const tile = page.locator('.project-nav-tile[data-dashboard="true"]')
      .filter({ hasText: dashboard.title })
    await tile.waitFor({ state: 'visible', timeout: 60_000 })
    await widgetData
    checks.ok('the Overview tile loads real widget data', true)

    // The scaled canvas is out of flow, so the tile stays a card in its row
    // rather than growing to the canvas's full unscaled height.
    const box = await tile.boundingBox()
    checks.ok(
      'the live tile is a card, not a column',
      box !== null && box.height < 400,
      box === null ? 'no box' : `${Math.round(box.height)}px tall`,
    )

    // The whole dashboard is fitted inside the card rather than cropped to it:
    // a card that shows the top-left corner of a dashboard is not a picture of
    // that dashboard.
    const fitted = await page.evaluate(() => {
      const frame = document.querySelector(
        '.project-nav-tile[data-dashboard="true"] .scaled-dashboard',
      )
      const canvas = frame?.querySelector('.scaled-dashboard-canvas')
      if (!frame || !canvas) return null
      const outer = frame.getBoundingClientRect()
      const inner = canvas.getBoundingClientRect()
      return {
        inside: inner.width <= outer.width + 1 && inner.height <= outer.height + 1,
        size: `${Math.round(inner.width)}x${Math.round(inner.height)} in `
          + `${Math.round(outer.width)}x${Math.round(outer.height)}`,
      }
    })
    checks.ok(
      'the whole dashboard fits inside the card',
      fitted?.inside === true,
      fitted?.size ?? 'no frame',
    )
    const frames = [await shot(page, 'desktop-project-dashboard-tile', '00-overview')]

    await tile.getByRole('button', { name: `Open ${dashboard.title}` }).click()

    // It grows out of the tile: one transform animation on the arriving
    // screen, on the stack's own curve. Polled from the moment of the click
    // rather than sampled afterwards — the run lasts 260 ms and then leaves
    // `getAnimations()` when the spent rectangle cancels it, so a single read
    // taken later finds nothing and proves nothing.
    const expanded = await page.waitForFunction(() => {
      const surface = document.querySelector('[data-testid="dashboard-detail"]')
      const running = (surface?.getAnimations() ?? [])
        .find((animation) => animation.effect?.getTiming?.().duration === 260)
      if (!running) return null
      return (running.effect?.getKeyframes?.() ?? [])
        .flatMap((frame) => Object.keys(frame))
        .join(',')
    }, { timeout: 60_000 })
      .then((handle) => handle.jsonValue())
      .catch(() => null)
    checks.ok(
      'the dashboard grows out of the tile it was opened from',
      typeof expanded === 'string' && expanded.includes('transform'),
      String(expanded),
    )

    await page.waitForURL(
      new RegExp(`/projects/${seed.project.id}/dashboards/${dashboard.id}$`, 'u'),
    )
    await page.waitForSelector('[data-testid="dashboard-detail"]', { timeout: 60_000 })
    checks.ok('the tile opens the dashboard full screen', true)
    frames.push(await shot(page, 'desktop-project-dashboard-tile', '01-full-screen'))

    // The rectangle is spent on arrival: Chrome restores a history entry's
    // state on reload, and replaying the zoom out of a tile that is not on
    // screen would be worse than no animation at all.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="dashboard-detail"]', { timeout: 60_000 })
    await page.waitForTimeout(1_000)
    const replayed = await page.evaluate(() =>
      document.querySelector('[data-testid="dashboard-detail"]')?.getAnimations().length ?? -1)
    checks.equal('a reload does not replay the expand', replayed, 0)

    // `parent: 'origin'`: Back returns to the Overview it was opened from,
    // not to the project's Dashboards list.
    await page.goBack()
    await page.waitForURL(new RegExp(`/projects/${seed.project.id}$`, 'u'))
    checks.ok('Back returns to the Overview it was opened from', true, page.url())

    // The project's own list is the owning surface, and it holds the same one.
    // Wait for the row rather than the container: the container is the search
    // field and the buttons, which render before the list has resolved.
    await gotoPath(page, `/projects/${seed.project.id}/dashboards`)
    const row = page.locator('[data-testid="project-dashboards"] li')
      .filter({ hasText: dashboard.title })
    await row.first().waitFor({ state: 'visible', timeout: 60_000 })
    const listed = await page.locator('[data-testid="project-dashboards"] li').count()
    checks.ok('the project lists its own dashboards', listed >= 1, `${listed} row(s)`)

    // Only this project's. A dashboard in another project is not in this list.
    const other = await call('/api/projects', { token: seed.token })
    checks.ok(
      'the list is scoped to one project',
      (await call(`/api/dashboards?projectId=${seed.project.id}`, { token: seed.token }))
        .every((row) => row.projectId === seed.project.id),
      `${other.length} project(s) in the organisation`,
    )
    frames.push(await shot(page, 'desktop-project-dashboard-tile', '02-dashboards-list'))

    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'desktop',
}
