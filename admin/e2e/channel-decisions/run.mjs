import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT, adminMode } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

// Drive the production settings dialog. The fixture substitutes only storage;
// API permissions, classification and worker execution have their own tests.
const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/channel-decisions')
const admin = await startAdmin({ reuseExisting: false })
const browser = await launchBrowser()
try {
  const html = await (await fetch(ADMIN_URL)).text()
  if (adminMode() === 'dev') assert.ok(html.includes('@vite/client'), 'verification must use the worktree dev server')
  await mkdir(screenshots, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${ADMIN_URL}/e2e/channel-decisions/index.html`)
  const open = async () => {
    await page.getByRole('button', { name: 'Channel settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Agent decisions', exact: true }).click()
  }
  await open()
  assert.equal(await page.getByRole('checkbox', { name: 'Use Jev for this channel' }).isChecked(), false)
  await page.getByRole('checkbox', { name: 'Use Jev for this channel' }).check()
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
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Option IDs must be unique' }).waitFor()
  assert.equal(await page.evaluate(() => window.__channelDecisionsFixture.writes.length), 0)
  await outcome(4).getByLabel('Outcome name').fill('superseded')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  const saved = await page.evaluate(() => window.__channelDecisionsFixture.saved())
  assert.equal(saved.topic, 'Weekly product decisions')
  assert.equal(saved.decisionPolicy.minimumProbability, 0.85)
  assert.deepEqual(saved.decisionPolicy.questions[0].options.map((option) => option.id), [
    'confirmed', 'unrelated', 'proposed', 'superseded',
  ])
  assert.equal(saved.decisionPolicy.questions[0].options[0].followUp.agentId, agentId)
  assert.equal(saved.decisionPolicy.questions[0].options[1].followUp, undefined)

  await open()
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
  await page.getByLabel('Use Jev for this channel').uncheck()
  await page.evaluate(() => window.__channelDecisionsFixture.failNextSave())
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Unable to save channel. Try again.' }).waitFor()
  assert.equal(await page.getByLabel('Use Jev for this channel').isChecked(), false)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => window.__channelDecisionsFixture.saved().decisionPolicy.enabled), false)
  assert.equal(await page.evaluate(() => window.__channelDecisionsFixture.saved().topic), 'A refreshed topic',
    'saving decisions must not overwrite channel metadata refreshed during editing')

  await open()
  await page.getByRole('tab', { name: 'Channel', exact: true }).click()
  await page.getByLabel('Topic', { exact: true }).fill('A metadata-only edit')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => 'decisionPolicy' in window.__channelDecisionsFixture.writes.at(-1)), false,
    'metadata-only saves must not replace the policy')
  await open()
  await page.getByLabel('Channel guidance').scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(screenshots, 'desktop-channel-decisions.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Channel guidance').scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(screenshots, 'phone-channel-decisions.png') })
  assert.ok(await page.getByRole('dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1),
    'settings must not overflow horizontally on a phone')
  await outcome(1).getByLabel('Work for the agent').scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(screenshots, 'phone-decision-outcomes.png') })
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.evaluate(() => window.__channelDecisionsFixture.refresh({ viewerCanManage: false }))
  await page.getByRole('button', { name: 'Channel settings', exact: true }).click()
  assert.equal(await page.getByRole('dialog').count(), 0, 'a viewer cannot reach edit controls')
  assert.deepEqual(errors, [], 'the settings flow must not throw browser errors')
  console.log(`Channel decision settings passed. Screenshots: ${screenshots}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
