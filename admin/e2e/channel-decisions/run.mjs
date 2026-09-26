import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT, adminMode } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

// Drive a room's Details › How agents respond through the real panel. The
// fixture substitutes only storage; API permissions, classification and
// worker execution have their own tests.
const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/channel-decisions')
const admin = await startAdmin({ reuseExisting: false })
const browser = await launchBrowser()
const errors = []
const at = (page) => decodeURIComponent(new URL(page.url()).searchParams.get('at') ?? '')
const writeCount = (page) => page.evaluate(() => window.__channelDecisionsFixture.writes.length)
/** Press Save and wait for that save to land, never for a banner an earlier one left. */
const saveAndLand = async (page, button) => {
  const before = await writeCount(page)
  await button.click()
  await page.waitForFunction((count) => window.__channelDecisionsFixture.writes.length > count, before)
}
try {
  const html = await (await fetch(ADMIN_URL)).text()
  if (adminMode() === 'dev') assert.ok(html.includes('@vite/client'), 'verification must use the worktree dev server')
  await mkdir(screenshots, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${ADMIN_URL}/e2e/channel-decisions/index.html`, { timeout: 120_000, waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Details', exact: true }).waitFor({ timeout: 120_000 })
  const responsesTab = page.getByRole('tab', { name: 'How agents respond', exact: true })
  const open = async () => {
    if (await responsesTab.count() === 0) await page.getByRole('button', { name: 'Details', exact: true }).click()
    await responsesTab.click()
  }

  await open()
  await page.waitForFunction(() => new URLSearchParams(
    new URL(`http://x${decodeURIComponent(new URLSearchParams(location.search).get('at') ?? '')}`).search,
  ).get('section') === 'responses')
  const address = new URL(`http://x${at(page)}`)
  assert.equal(address.pathname.endsWith('/info'), true, 'Details is its route')
  assert.equal(address.searchParams.get('tab'), 'messages', 'the conversation tab survives opening Details')
  assert.equal(
    await page.evaluate(() => window.__channelDecisionsFixture.actions.at(-1)),
    'REPLACE',
    'a section switch replaces the entry, never pushes one',
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await responsesTab.waitFor()
  assert.equal(await responsesTab.getAttribute('aria-selected'), 'true', 'the section survives a reload')

  const enable = page.getByRole('checkbox', { name: 'Use these decisions in this channel' })
  assert.equal(await enable.isChecked(), false)
  await enable.check()
  await page.getByLabel('Channel guidance').fill('Keep the conversation useful. Record settled decisions once.')
  await page.getByLabel('Minimum confidence (%)').fill('85')
  await page.getByText('Acknowledgements (4)', { exact: true }).click()
  const reaction = page.getByRole('group', { name: 'Reaction 1', exact: true })
  await reaction.getByLabel('When to use it').fill('Rozumím aktualizaci a není potřeba odpověď.')
  await page.getByText('Acknowledgements (4)', { exact: true }).click()
  await page.getByRole('button', { name: 'Add decision', exact: true }).click()
  const decision = page.getByRole('region', { name: 'Decision 1', exact: true })
  await decision.getByLabel('Decision name').fill('decision-log')
  await decision.getByLabel('What should be decided?').fill('What stage has this product decision reached?')
  const outcome = (number) => decision.getByRole('group', { name: `Outcome ${number}`, exact: true })
  await outcome(1).getByLabel('Outcome name').fill('confirmed')
  await outcome(1).getByLabel('When to choose this outcome').fill('The participants have settled a decision.')
  const agentId = await page.evaluate(() => window.__channelDecisionsFixture.agentId)
  await outcome(1).getByLabel('Next action').selectOption(agentId)
  await outcome(1).getByLabel('Work for the agent').fill('Update the decision log with the decision and its reasoning.')
  for (const [index, name, description] of [
    [3, 'proposed', 'A possible decision is being discussed.'],
    [4, 'superseded', 'A newer decision replaces an earlier one.'],
  ]) {
    await decision.getByRole('button', { name: 'Add outcome', exact: true }).click()
    await outcome(index).getByLabel('Outcome name').fill(name)
    await outcome(index).getByLabel('When to choose this outcome').fill(description)
  }
  // Invalid enums must never reach the API, and the error stays by its field.
  await outcome(4).getByLabel('Outcome name').fill('confirmed')
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await save.click()
  await page.getByRole('alert').filter({ hasText: 'Option IDs must be unique' }).waitFor()
  assert.equal(await page.evaluate(() => window.__channelDecisionsFixture.writes.length), 0)
  await outcome(4).getByLabel('Outcome name').fill('superseded')
  await saveAndLand(page, save)
  await page.getByRole('status').filter({ hasText: 'Saved.' }).waitFor()
  const saved = await page.evaluate(() => window.__channelDecisionsFixture.saved())
  assert.equal(saved.topic, 'Weekly product decisions')
  assert.equal(saved.decisionPolicy.minimumProbability, 0.85)
  assert.deepEqual(saved.decisionPolicy.questions[0].options.map((option) => option.id), [
    'confirmed', 'unrelated', 'proposed', 'superseded',
  ])
  assert.equal(saved.decisionPolicy.questions[0].options[0].followUp.agentId, agentId)
  assert.equal(saved.decisionPolicy.questions[0].options[1].followUp, undefined)
  assert.equal('topic' in (await page.evaluate(() => window.__channelDecisionsFixture.writes.at(-1))), false,
    'saving decisions sends the policy and nothing of the room')

  assert.equal(await outcome(1).getByLabel('Work for the agent').inputValue(),
    'Update the decision log with the decision and its reasoning.')
  await page.getByLabel('Channel guidance').fill('My unfinished channel guidance')
  await page.evaluate(() => window.__channelDecisionsFixture.refresh({ topic: 'A refreshed topic' }))
  assert.equal(await page.getByLabel('Channel guidance').inputValue(), 'My unfinished channel guidance')
  await page.evaluate(() => {
    const fixture = window.__channelDecisionsFixture
    fixture.refresh({ decisionPolicy: { ...fixture.saved().decisionPolicy, instructions: 'Updated by another editor' } })
  })
  await page.getByRole('button', { name: 'Load latest decisions', exact: true }).click()
  assert.equal(await page.getByLabel('Channel guidance').inputValue(), 'Updated by another editor')
  await enable.uncheck()
  await page.evaluate(() => window.__channelDecisionsFixture.failNextSave())
  await save.click()
  await page.getByRole('alert').filter({ hasText: 'Unable to save channel. Try again.' }).waitFor()
  assert.equal(await enable.isChecked(), false)
  await saveAndLand(page, save)
  assert.equal(await page.evaluate(() => window.__channelDecisionsFixture.saved().decisionPolicy.enabled), false)
  assert.equal(await page.evaluate(() => window.__channelDecisionsFixture.saved().topic), 'A refreshed topic',
    'saving decisions must not overwrite channel metadata refreshed during editing')

  // General has its own Save, and a metadata-only save never replaces the policy.
  await page.getByRole('tab', { name: 'General', exact: true }).click()
  await page.getByLabel('Topic', { exact: true }).fill('A metadata-only edit')
  await saveAndLand(page, page.getByRole('button', { name: 'Save', exact: true }))
  assert.equal(await page.evaluate(() => 'decisionPolicy' in window.__channelDecisionsFixture.writes.at(-1)), false,
    'metadata-only saves must not replace the policy')

  await open()
  await page.getByLabel('Channel guidance').scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(screenshots, 'desktop-channel-decisions.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Channel guidance').scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(screenshots, 'phone-channel-decisions.png') })
  assert.ok(await page.getByTestId('conversation-details').evaluate((panel) => panel.scrollWidth <= panel.clientWidth + 1),
    'Details must not overflow horizontally on a phone')
  await outcome(1).getByLabel('Work for the agent').scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(screenshots, 'phone-decision-outcomes.png') })

  // Somebody who may not change the room reads the policy, every control
  // disabled, and is told who can change it.
  await page.evaluate(() => window.__channelDecisionsFixture.refresh({ viewerCanManage: false }))
  await page.getByText('Only members of this channel, or an organisation owner or admin, can change how its agents respond.').waitFor()
  assert.equal(await enable.isDisabled(), true, 'a viewer cannot change the decisions')
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true)
  assert.deepEqual(errors, [], 'the settings flow must not throw browser errors')
  console.log(`Channel decision settings passed. Screenshots: ${screenshots}`)
} catch (error) {
  console.error('Channel decisions browser errors:', errors)
  console.error(admin.output())
  throw error
} finally {
  await browser.close()
  await stopProcess(admin)
}
