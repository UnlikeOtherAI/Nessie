import assert from 'node:assert/strict'

/**
 * The research-brief suite's recovery walks: what a person gets back when an
 * answer is lost, when DeepWater is turned off under an open form, when the
 * sign-in an agent's brief runs on has changed, and when their team's
 * DeepWater needs updating.
 */

const RUNS = '/api/integrations/products/deep-water/research-runs'
const AGENT_DRAFT = '50000000-0000-4000-8000-000000000002'

const posts = (page, path) => page.evaluate((target) =>
  window.__research.calls.filter((call) => call.method === 'POST' && call.path === target), path)

/**
 * Opening a brief whose answer was lost after the brief was opened: the form
 * never says the request didn't arrive, and pressing the button again — even
 * after closing the dialog — sends the same key, so the same brief opens and
 * no second one is paid for.
 */
export const walkLostNewBrief = async (page, snap) => {
  await page.getByTestId('composer-research-button').click()
  const form = page.getByTestId('research-brief-new')
  await form.getByRole('textbox').nth(1).fill('Only the ground floor.')
  await form.getByRole('button', { name: 'Plan with DeepWater' }).click()
  const lost = form.getByRole('alert')
  await lost.getByText('Nessie didn’t answer.', { exact: false }).waitFor()
  assert.doesNotMatch(await lost.innerText(), /didn’t reach/)
  await snap(page, '07b-new-brief-answer-lost.png')

  // Closed and opened again: the draft brings back the words and their key.
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await page.getByTestId('research-brief-new').waitFor({ state: 'detached' })
  await page.getByTestId('composer-research-button').click()
  const again = page.getByTestId('research-brief-new')
  // A stored draft is restored just after the form first draws.
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-testid="research-brief-new"] textarea')[1]?.value === 'Only the ground floor.')
  await again.getByRole('button', { name: 'Plan with DeepWater' }).click()
  await page.getByTestId('research-brief-replying').waitFor()

  const [first, second] = await posts(page, RUNS)
  assert.ok(first && second, 'the brief was asked for twice')
  assert.equal(second.body.actionId, first.body.actionId, 'the same question is resent under the same key')
  // The answer is the brief the lost request opened, not a second one.
  assert.equal(await page.evaluate(() => window.__research.openedBriefs()), 1)
}

/**
 * DeepWater was turned off after the products list was read: the refusal
 * speaks to an owner as an owner, and the dialog gives way to the readiness
 * screen with the owner's way to turn it back on.
 */
export const walkNotReadyNewBrief = async (page, snap) => {
  await page.getByTestId('composer-research-button').click()
  await page.getByTestId('research-brief-new').getByRole('button', { name: 'Plan with DeepWater' }).click()
  const readiness = page.getByTestId('research-readiness')
  await readiness.getByText('DeepWater is off for this team. Turn it on', { exact: false }).waitFor()
  await readiness.getByRole('link', { name: 'Turn on DeepWater' }).waitFor()
  assert.equal(await page.getByTestId('research-brief-new').count(), 0, 'no form offers research the server refuses')
  await snap(page, '13c-not-ready-after-refusal.png')
}

/**
 * The requester of an agent's brief whose sign-in changed: the brief they open
 * from its card asks them to sign in again, with the same Retry the card has.
 */
export const walkAgentBriefSignIn = async (page, snap) => {
  const card = page.locator(`[data-card="${AGENT_DRAFT}"]`)
  await card.getByText('Your sign-in has changed since this research was asked for.', { exact: false }).waitFor()
  await card.getByRole('button', { name: 'View brief' }).click()
  const notice = page.getByTestId('research-brief-dialog').getByTestId('research-brief-sign-in')
  await notice.getByText('the agent can’t carry on with this brief', { exact: false }).waitFor()
  await notice.getByRole('button', { name: 'Sign in again' }).waitFor()
  await snap(page, '11b-agent-brief-sign-in.png')
  await notice.getByRole('button', { name: 'I’ve signed in again — retry' }).click()
  await notice.waitFor({ state: 'detached' })
  const [retry] = await posts(page, `${RUNS}/${AGENT_DRAFT}/deliver`)
  assert.match(retry.body.actionId, /^[0-9a-f-]{36}$/)
}

/**
 * A team whose DeepWater needs updating is on: its owner can update it, or
 * turn it off without updating it first.
 */
export const walkOutdatedTeam = async (page, snap) => {
  const controls = page.getByTestId('deep-water-team-controls')
  await controls.getByText('DeepWater needs updating for this team', { exact: false }).waitFor()
  assert.deepEqual(await controls.getByTestId('deep-water-team-control').allInnerTexts(),
    ['Update DeepWater', 'Turn off DeepWater'])
  await snap(page, '14b-owner-outdated.png')
  await controls.getByRole('button', { name: 'Update DeepWater' }).click()
  await controls.getByText('DeepWater is on for this team.', { exact: false }).waitFor()
  assert.deepEqual(await controls.getByTestId('deep-water-team-control').allInnerTexts(), ['Turn off DeepWater'])
}
