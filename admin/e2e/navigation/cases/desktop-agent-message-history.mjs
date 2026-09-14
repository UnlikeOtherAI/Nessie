// The agent Messages tab has opaque, viewer-bound cursors. A person can walk
// both directions, then choose another agent without sending the first
// agent's URL cursor to that second agent.
import { createChecks } from '../lib/expect.mjs'
import { gotoPath, pushPath, shot } from '../lib/page.mjs'
import { seedAgentMessageHistory } from '../lib/seed.mjs'

const listPath = (agentId) => `/agents/${agentId}?agentTab=messages`

export const desktopAgentMessageHistory = {
  name: 'desktop-agent-message-history',
  run: async ({ page, seed }) => {
    const checks = createChecks('desktop-agent-message-history')
    const agents = await seedAgentMessageHistory(seed)
    await gotoPath(page, listPath(agents.first.id))
    await page.getByText('25 visible messages on this page').waitFor()

    const nextResponse = page.waitForResponse((candidate) => {
      const url = new URL(candidate.url())
      return url.pathname === `/api/agents/${agents.first.id}/messages`
        && url.searchParams.get('direction') === 'forward'
        && url.searchParams.has('cursor')
        && candidate.ok()
    })
    await page.getByRole('button', { name: 'Next page' }).click()
    const firstResponse = await nextResponse
    await page.getByText('5 visible messages on this page').waitFor()
    const firstSearch = new URL(page.url()).search

    await page.getByRole('button', { name: 'Previous page' }).click()
    await page.getByText('25 visible messages on this page').waitFor()
    const previousRestored = await page.getByText('25 visible messages on this page').count() === 1
    const frames = [await shot(page, 'desktop-agent-message-history', '00-first-page-restored')]

    const secondResponse = page.waitForResponse((candidate) => {
      const url = new URL(candidate.url())
      return url.pathname === `/api/agents/${agents.second.id}/messages` && candidate.ok()
    })
    await pushPath(page, `/agents/${agents.second.id}${firstSearch}`)
    const response = await secondResponse
    await page.getByText('Agent pagination proof 30').waitFor({ state: 'hidden' })
    const secondSearch = new URL(response.url()).searchParams

    checks.ok('next request carries an opaque cursor', new URL(firstResponse.url()).searchParams.has('cursor'))
    checks.ok('Previous returns to the adjacent full page', previousRestored)
    checks.ok('the second agent request never reuses the first agent cursor', !secondSearch.has('cursor'))
    checks.equal('the second agent starts at the first cursor direction', secondSearch.get('direction'), 'forward')
    checks.equal('the second agent does not render the first agent messages', await page.getByText('Agent pagination proof 30').count(), 0)
    frames.push(await shot(page, 'desktop-agent-message-history', '01-second-agent'))
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'desktop',
}
