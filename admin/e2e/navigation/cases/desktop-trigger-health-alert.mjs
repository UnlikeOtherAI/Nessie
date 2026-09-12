// A durable trigger-health alert has one destination: the broken schedule's
// detail column, where the classified failure and its Reauthorize control sit.
import { createChecks } from '../lib/expect.mjs'
import { gotoPath, shot } from '../lib/page.mjs'
import { seedTriggerHealthAlert } from '../lib/seed.mjs'

export const desktopTriggerHealthAlert = {
  name: 'desktop-trigger-health-alert',
  run: async ({ page, seed }) => {
    const checks = createChecks('desktop-trigger-health-alert')
    const health = await seedTriggerHealthAlert(seed)

    await gotoPath(page, '/channels')
    await page.getByRole('button', { name: 'Alerts', exact: true }).click()
    await page.getByText('A scheduled task stopped running', { exact: true }).first().click()
    await page.waitForURL(new RegExp(`/agents/triggers\\?trigger=${health.triggerId}$`, 'u'))
    const detailHeading = page.getByRole('heading', { level: 2, name: health.title, exact: true })
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
    const frames = [await shot(page, 'desktop-trigger-health-alert', '00-recovery-control')]
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'desktop',
}
