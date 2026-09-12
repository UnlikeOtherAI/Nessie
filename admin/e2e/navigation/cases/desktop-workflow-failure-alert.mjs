// A failed-run bell link is a durable reader state, not an owner-only pane:
// both an administrator and a channel-entitled member can open it cold,
// reload it, and use the run column's one Back doorway.
import { createChecks } from '../lib/expect.mjs'
import { gotoPath, shot } from '../lib/page.mjs'
import { seedWorkflowFailureAlert } from '../lib/seed.mjs'

const proveColdLink = async (page, runId, screenshot) => {
  const runTitle = `Run ${runId.slice(0, 8)}`
  const path = `/agents/workflows?failedRuns=1&run=${runId}`
  const heading = page.getByRole('heading', { level: 2, name: runTitle, exact: true })

  await gotoPath(page, path)
  await heading.waitFor()
  await page.reload()
  await heading.waitFor()
  const opened = await heading.isVisible()
  const frame = screenshot ? await shot(page, 'desktop-workflow-failure-alert', screenshot) : undefined
  await page.getByRole('button', { name: `Back from ${runTitle}`, exact: true }).click()
  await page.waitForURL(/\/agents\/workflows\?failedRuns=1$/u)
  await heading.waitFor({ state: 'hidden' })

  return { backClosed: true, frame, opened }
}

export const desktopWorkflowFailureAlert = {
  name: 'desktop-workflow-failure-alert',
  run: async ({ page, seed }) => {
    const checks = createChecks('desktop-workflow-failure-alert')
    const fixture = await seedWorkflowFailureAlert(seed)

    const admin = await proveColdLink(page, fixture.runId)
    checks.ok('an administrator opens the exact failed run cold', admin.opened)
    checks.ok('administrator Back leaves the failed-run detail', admin.backClosed)

    await page.evaluate((token) => {
      window.localStorage.setItem('nessie.admin.token', token)
    }, fixture.readerToken)
    const reader = await proveColdLink(page, fixture.runId, '00-reader-failed-run')
    checks.ok('a channel-entitled reader opens the exact failed run cold', reader.opened)
    checks.ok('reader Back leaves the failed-run detail', reader.backClosed)

    const frames = reader.frame ? [reader.frame] : []
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'desktop',
}
