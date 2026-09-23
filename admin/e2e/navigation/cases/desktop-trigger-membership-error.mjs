// Removing an agent from a scheduled channel is a durable stop, not a quiet
// skipped fire. The trigger list and detail screen must explain the repair,
// withhold runnable affordances, and refuse Resume until the roster is fixed.
import { createChecks } from '../lib/expect.mjs'
import { gotoPath, shot } from '../lib/page.mjs'
import { seedTriggerMembershipError } from '../lib/seed-trigger-membership.mjs'

export const desktopTriggerMembershipError = {
  name: 'desktop-trigger-membership-error',
  run: async ({ page, seed }) => {
    const checks = createChecks('desktop-trigger-membership-error')
    const membership = await seedTriggerMembershipError(seed)
    await page.context().addInitScript((token) => {
      localStorage.setItem('nessie.admin.token-mode', JSON.stringify({ mode: 'renewable', token }))
      localStorage.setItem('nessie.admin.token', token)
    }, membership.token)

    await gotoPath(page, '/agents/triggers')
    const triggerRow = page.getByRole('row').filter({
      has: page.getByText(membership.title, { exact: true }),
    })
    await triggerRow.waitFor()
    const rowText = await triggerRow.textContent()
    const nextRunCell = triggerRow.getByRole('cell').nth(4)
    checks.ok(
      'the list names the missing agent membership',
      /agent is no longer in its target channel/iu.test(rowText ?? ''),
    )
    checks.equal('the stopped schedule has no runnable next time', await nextRunCell.textContent(), '—')

    await triggerRow.click()
    await page.waitForURL(new RegExp(`/agents/triggers/${membership.triggerId}$`, 'u'))
    await page.getByText('This schedule has stopped', { exact: true }).waitFor()
    const repair = page
      .getByRole('status')
      .filter({ hasText: 'This schedule has stopped' })
      .getByText(/The agent is no longer in its target channel\. Add the agent back/iu)
    await repair.waitFor()
    const resume = page
      .getByRole('button', { name: 'Resume', exact: true })
      .filter({ visible: true })
      .first()
    await resume.waitFor()

    checks.equal(
      'Run now is withheld while membership is broken',
      await page.getByRole('button', { name: 'Run now', exact: true }).count(),
      0,
    )
    checks.equal(
      'Next run is withheld while membership is broken',
      await page.locator('dt').filter({ hasText: /^Next run$/u }).count(),
      0,
    )
    await resume.click()
    const blocked = page.locator('#admin-shell-main').getByText(
      'Add the agent back to the target channel before resuming.',
      { exact: true },
    )
    await blocked.waitFor()
    checks.ok('Resume explains the still-missing repair', await blocked.isVisible())

    const frames = [await shot(page, 'desktop-trigger-membership-error', '00-stopped-schedule')]
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'desktop',
}
