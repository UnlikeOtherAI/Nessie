import assert from 'node:assert/strict'

/**
 * The research-brief suite's `/apps/deep-water` walks beyond the happy cancel:
 * an owner's cancel DeepWater accepted and then could not carry out, the same
 * for an owner who may not read the research, and a readiness verdict the
 * admin could not read.
 */

const RUNS = '/api/integrations/products/deep-water/research-runs'
const RUNNING = '50000000-0000-4000-8000-000000000006'
const HIDDEN = '50000000-0000-4000-8000-000000000009'
const CANCEL_UNREACHED = 'DeepWater couldn’t be reached, so this research wasn’t cancelled. Try again in a few minutes.'

const cancels = (page, id) => page.evaluate((path) =>
  window.__research.calls.filter((call) => call.method === 'POST' && call.path === path), `${RUNS}/${id}/cancel`)

/** Turn off, confirmed, and refused by the open research. */
const turnOff = async (page) => {
  const controls = page.getByTestId('deep-water-team-controls')
  await controls.getByRole('button', { name: 'Turn off DeepWater' }).click()
  const confirm = page.getByRole('dialog', { name: 'Turn off DeepWater for this team?' })
  await confirm.getByRole('button', { name: 'Turn off' }).click()
  await confirm.waitFor({ state: 'detached' })
  const blocking = controls.getByTestId('deep-water-open-research')
  await blocking.waitFor()
  return blocking
}

const standing = (blocking) => blocking.getAttribute('data-standing')

/**
 * Accepted, then refused: DeepWater could not be asked to stop the research.
 * The hero says so with the reason and offers Cancel again — also after the
 * change is tried again and refused by the same research — without a reload.
 */
export const walkHeroCancelRefused = async (page, snap) => {
  const blocking = await turnOff(page)
  await blocking.getByRole('button', { name: 'Cancel this research' }).click()
  await blocking.getByText('Cancel requested for the research started by an agent.', { exact: false }).waitFor()

  await page.evaluate((id) => window.__research.cancelRefused(id), RUNNING)
  await blocking.getByTestId('deep-water-cancel-failure').getByText(CANCEL_UNREACHED).waitFor()
  assert.equal(await standing(blocking), 'cancel_failed')
  await snap(page, '16c-hero-cancel-refused.png')

  const again = await turnOff(page)
  await again.getByRole('button', { name: 'Cancel again' }).waitFor()
  assert.equal(await standing(again), 'cancel_failed', 'a refusal since the cancel does not hide that it failed')
  await again.getByRole('button', { name: 'Cancel again' }).click()
  await again.getByText('Cancel requested for the research started by an agent.', { exact: false }).waitFor()
  assert.equal(await again.getByRole('button').count(), 0, 'the newer cancel is on its way')
  const [first, second] = await cancels(page, RUNNING)
  assert.ok(first && second, 'the research was cancelled twice')
  assert.notEqual(second.body.actionId, first.body.actionId, 'a cancel after a failed one is a new action')

  await page.evaluate((id) => window.__research.cancelSettles(id), RUNNING)
  await again.getByText('The research started by an agent has stopped. You can try again now.').waitFor()
}

/**
 * An owner who may not read the research sees only that the change is still
 * refused after their cancel: they are offered Cancel again then, and a newer
 * cancel replaces the one they cannot see.
 */
export const walkHeroCancelUnseen = async (page, snap) => {
  const blocking = await turnOff(page)
  await blocking.getByText('is being researched', { exact: false }).waitFor()
  await blocking.getByRole('button', { name: 'Cancel this research' }).click()
  await blocking.getByText('Cancel requested for the research started by', { exact: false }).waitFor()
  assert.equal(await blocking.getByRole('button').count(), 0)

  const again = await turnOff(page)
  await again.getByText('the cancel may not have gone through', { exact: false }).waitFor()
  assert.equal(await standing(again), 'cancel_unconfirmed')
  await snap(page, '16d-hero-cancel-unseen.png')
  await again.getByRole('button', { name: 'Cancel again' }).click()
  await again.getByText('Cancel requested for the research started by', { exact: false }).waitFor()
  assert.equal(await standing(again), 'cancel_requested')
  assert.equal((await cancels(page, HIDDEN)).length, 2)
}

/**
 * A verdict outside the contract (an admin older than its API) is said as
 * that, with Try again: the hero offers no change, and the composer's button
 * opens the same words — never "DeepWater is off" or "unavailable".
 */
export const walkReadinessUnread = async (hero, thread, snap) => {
  const controls = hero.getByTestId('deep-water-team-controls')
  await controls.getByTestId('research-readiness-unread').getByText('couldn’t be loaded', { exact: false }).waitFor()
  assert.deepEqual(await controls.getByRole('button').allInnerTexts(), ['Try again'])
  await snap(hero, '14c-hero-readiness-unread.png')

  const button = thread.getByTestId('composer-research-button')
  await button.click()
  const dialog = thread.getByTestId('research-brief-dialog')
  await dialog.getByTestId('research-readiness-unread').waitFor()
  assert.equal(await button.getAttribute('title'), 'Research with DeepWater', 'no reason is claimed')
  assert.equal(await dialog.getByTestId('research-readiness').count(), 0)
  assert.doesNotMatch(await dialog.innerText(), /\boff\b|isn’t available/)
}
