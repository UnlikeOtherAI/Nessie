// A Dashboard is a Knowledge detail, but its split-layout sidebar is also the
// doorway back to spaces. Selecting My Docs must replace the dashboard outlet,
// not merely update the Knowledge provider behind it.
import { createChecks } from '../lib/expect.mjs'
import { gotoPath, shot } from '../lib/page.mjs'

export const desktopDashboardExit = {
  name: 'desktop-dashboard-exit',
  run: async ({ page }) => {
    const checks = createChecks('desktop-dashboard-exit')
    // The first visit asks Vite to transform the full authenticated shell.
    // Leave the interaction timeouts strict, but allow that cold navigation
    // to complete on a developer machine already running other worktrees.
    page.setDefaultNavigationTimeout(120_000)

    // Opening Knowledge once provisions the signed-in person's My Docs space,
    // which gives this case a real sidebar row to follow out of Dashboards.
    await gotoPath(page, '/knowledge-base')
    await page.waitForSelector('#kb-my-docs button.admin-sb-item', { timeout: 60_000 })
    await page.click('a[href="/dashboards"]')
    await page.waitForURL(/\/dashboards$/u)
    await page.waitForSelector('[data-testid="dashboards-page"]')
    const frames = [await shot(page, 'desktop-dashboard-exit', '00-dashboard')]

    await page.click('#kb-my-docs button.admin-sb-item')
    await page.waitForURL(/\/knowledge-base\/spaces\/[^/]+$/u)
    await page.waitForSelector('[data-testid="dashboards-page"]', { state: 'detached' })

    checks.ok(
      'My Docs leaves the dashboard route',
      /\/knowledge-base\/spaces\/[^/]+$/u.test(page.url()),
      page.url(),
    )
    checks.ok(
      'the dashboard empty state is gone',
      await page.$('[data-testid="dashboards-page"]') === null,
    )
    const framesAfter = await shot(page, 'desktop-dashboard-exit', '01-my-docs')
    frames.push(framesAfter)
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'desktop',
}
