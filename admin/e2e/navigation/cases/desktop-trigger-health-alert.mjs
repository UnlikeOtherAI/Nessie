// A durable trigger-health alert has one destination: the broken schedule's
// own screen, where the classified failure and its Reauthorize control sit.
//
// That screen is a route now (`/admin/automations/triggers/:triggerId`) rather
// than a column browser's selected row behind `?trigger=`, so the trigger is
// named by the screen's `h1`, reached from a row of Automations' Schedules &
// triggers tab, and left through the shared "Back to Automations" doorway.
import { createChecks } from '../lib/expect.mjs'
import { gotoPath, pushPath, shot } from '../lib/page.mjs'
import { seedTriggerHealthAlert } from '../lib/seed.mjs'

export const desktopTriggerHealthAlert = {
  name: 'desktop-trigger-health-alert',
  run: async ({ page, seed }) => {
    const checks = createChecks('desktop-trigger-health-alert')
    const health = await seedTriggerHealthAlert(seed)
    const detailHeading = page.getByRole('heading', { level: 1, name: health.title, exact: true })
    await page.context().addInitScript((token) => {
      localStorage.setItem('nessie.admin.token-mode', JSON.stringify({ mode: 'renewable', token }))
      localStorage.setItem('nessie.admin.token', token)
    }, health.token)

    // The trigger is its own history entry now, not a `replace`d `?trigger=`
    // selection on the list, so browser Back walks the path in reverse:
    // list → the trigger it came from → Channels. That is what every other
    // detail route in the section does, and nothing is superseded on the way.
    await gotoPath(page, '/channels')
    await pushPath(page, '/admin/automations')
    await page.waitForURL(/\/admin\/automations$/u)
    const triggerRow = page.getByRole('row').filter({
      has: page.getByText(health.title, { exact: true }),
    })
    await triggerRow.waitFor()
    await triggerRow.click()
    await page.waitForURL(new RegExp(`/admin/automations/triggers/${health.triggerId}$`, 'u'))
    await detailHeading.waitFor()
    // The header renders a hidden measuring copy of its lanes, so every control
    // this case presses is taken from the visible one.
    await page
      .getByRole('button', { name: 'Back to Automations', exact: true })
      .filter({ visible: true })
      .first()
      .click()
    await page.waitForURL(/\/admin\/automations$/u)
    await Promise.all([
      page.waitForURL(new RegExp(`/admin/automations/triggers/${health.triggerId}$`, 'u')),
      page.goBack(),
    ])
    const browserBackReopenedTheTrigger =
      new RegExp(`/admin/automations/triggers/${health.triggerId}$`, 'u').test(page.url())
    await Promise.all([
      page.waitForURL(/\/admin\/automations$/u),
      page.goBack(),
    ])
    await Promise.all([
      page.waitForURL(/\/channels(?:\/[^/?]+)?$/u),
      page.goBack(),
    ])
    const browserBackReachedChannels = /\/channels(?:\/[^/?]+)?$/u.test(page.url())

    await gotoPath(page, '/channels')
    await page.getByRole('button', { name: 'Alerts', exact: true }).click()
    await page.getByText('A scheduled task stopped running', { exact: true }).first().click()
    await page.waitForURL(new RegExp(`/admin/automations/triggers/${health.triggerId}$`, 'u'))
    await detailHeading.waitFor()
    await page.getByText('This schedule has stopped', { exact: true }).waitFor()
    const reauthorize = page
      .getByRole('button', { name: 'Reauthorize', exact: true })
      .filter({ visible: true })
      .first()
    await reauthorize.waitFor()
    await page.reload()
    await detailHeading.waitFor()
    await page.getByText('This schedule has stopped', { exact: true }).waitFor()
    await reauthorize.waitFor()

    checks.ok('the alert opens its exact broken trigger', await detailHeading.isVisible())
    checks.ok('the selected trigger exposes its health remedy', await reauthorize.isVisible())
    checks.ok('browser Back returns to the trigger it came from', browserBackReopenedTheTrigger)
    checks.ok('browser Back keeps walking out to Channels', browserBackReachedChannels)
    const frames = [await shot(page, 'desktop-trigger-health-alert', '00-recovery-control')]
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'desktop',
}
