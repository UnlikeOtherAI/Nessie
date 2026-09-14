// A durable trigger-health alert has one destination: the broken schedule's
// detail column, where the classified failure and its Reauthorize control sit.
import { createChecks } from '../lib/expect.mjs'
import { gotoPath, pushPath, shot } from '../lib/page.mjs'
import { seedTriggerHealthAlert } from '../lib/seed.mjs'

export const desktopTriggerHealthAlert = {
  name: 'desktop-trigger-health-alert',
  run: async ({ page, seed }) => {
    const checks = createChecks('desktop-trigger-health-alert')
    const health = await seedTriggerHealthAlert(seed)
    const detailHeading = page.getByRole('heading', { level: 2, name: health.title, exact: true })
    await page.context().addInitScript((token) => {
      localStorage.setItem('nessie.admin.token-mode', JSON.stringify({ mode: 'renewable', token }))
      localStorage.setItem('nessie.admin.token', token)
    }, health.token)

    // Selection describes the current page state. It must replace the
    // Trigger-list entry, so its own detail Back followed by browser Back
    // returns to Channels instead of reopening a superseded selected row.
    await gotoPath(page, '/channels')
    await pushPath(page, '/agents/triggers')
    await page.waitForURL(/\/agents\/triggers$/u)
    const triggerList = page.getByRole('list', { name: 'Triggers', exact: true })
    const triggerRow = triggerList.getByRole('button').filter({
      has: page.getByText(health.title, { exact: true }),
    })
    await triggerRow.waitFor()
    await triggerRow.click()
    await page.waitForURL(new RegExp(`/agents/triggers\\?trigger=${health.triggerId}$`, 'u'))
    await detailHeading.waitFor()
    await page.getByRole('button', { name: `Back from ${health.title}`, exact: true }).click()
    await page.waitForURL(/\/agents\/triggers$/u)
    await Promise.all([
      page.waitForURL(/\/channels(?:\/[^/?]+)?$/u),
      page.goBack(),
    ])
    const browserBackReturnedToChannels = /\/channels(?:\/[^/?]+)?$/u.test(page.url())

    await gotoPath(page, '/channels')
    await page.getByRole('button', { name: 'Alerts', exact: true }).click()
    await page.getByText('A scheduled task stopped running', { exact: true }).first().click()
    await page.waitForURL(new RegExp(`/agents/triggers\\?trigger=${health.triggerId}$`, 'u'))
    await detailHeading.waitFor()
    await page.getByText('This schedule has stopped', { exact: true }).waitFor()
    const reauthorize = page.getByRole('button', { name: 'Reauthorize', exact: true })
    await reauthorize.waitFor()
    await page.reload()
    await detailHeading.waitFor()
    await page.getByText('This schedule has stopped', { exact: true }).waitFor()
    await reauthorize.waitFor()

    checks.ok('the alert opens its exact broken trigger', await detailHeading.isVisible())
    checks.ok('the selected trigger exposes its health remedy', await reauthorize.isVisible())
    checks.ok('browser Back after detail Back does not reopen the selected trigger', browserBackReturnedToChannels)
    const frames = [await shot(page, 'desktop-trigger-health-alert', '00-recovery-control')]
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'desktop',
}
