import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { REPO_ROOT } from '../navigation/lib/config.mjs'

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/sales-ui-verification')
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { height: 1100, width: 1280 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
try {
  await page.goto('http://localhost:5455/e2e/sales-ui-verification/index.html')
  await page.waitForTimeout(800)
  assert.deepEqual(errors, [], errors.join(' | '))
  const title = page.getByLabel('Title')
  await title.evaluate((input) => { input.dataset.fixtureIdentity = 'step-title'; return null })
  await title.click()
  await title.pressSequentially('Verify the business and venue')
  assert.equal(await title.evaluate((input) => document.activeElement === input && input.dataset.fixtureIdentity === 'step-title'), true, 'step title keeps focus and its DOM node')
  assert.equal(await title.inputValue(), 'Verify the business and venue')
  const name = page.getByLabel('Name').first()
  await name.fill('Venue research lead')
  await page.getByRole('tab', { name: 'Behavior' }).click()
  await page.getByRole('tab', { name: 'Basics' }).click()
  assert.equal(await name.inputValue(), 'Venue research lead', 'designer keeps the unsent draft across tabs')
  await page.getByRole('tab', { name: 'Create' }).click()
  assert.equal(await page.getByTestId('designer-mode').textContent(), 'create')
  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'designer-tabs.png') })
  await page.getByLabel('Checklist template').selectOption('agent-sales:template-venue')
  await page.getByRole('button', { name: 'Apply checklist' }).click()
  await page.getByLabel('Result for Confirm venue').fill('Venue is available at 10:00.')
  await page.getByRole('button', { name: 'Save result' }).click()
  await page.getByText('Saved.', { exact: true }).waitFor()
  assert.equal(
    await page.getByLabel('Result for Confirm venue').inputValue(),
    'Venue is available at 10:00.',
    'saved result remains visible from the checklist',
  )
  assert.equal(
    await page.evaluate(() => localStorage.getItem('draft:task-checklist:task-sales')),
    null,
    'saved result clears its local draft',
  )
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'task-checklist.png') })
  await page.getByTestId('google-scope-grant').click()
  await page.waitForTimeout(50)
  const request = await page.evaluate(() => JSON.stringify(window.salesConnectionRequest))
  assert.match(request ?? '', /meet\.create/)
  assert.doesNotMatch(request ?? '', /gmail/)
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'meet-capability.png') })
  await page.goto('http://localhost:5455/e2e/sales-ui-verification/index.html?view=calendar')
  await page.getByRole('heading', { name: 'Connect Google Calendar and Meet' }).waitFor()
  await page.getByLabel('See availability').check()
  await page.getByLabel('Manage calendar events').check()
  await page.getByLabel('Create Google Meet links').check()
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'calendar-capabilities.png') })
  await page.getByTestId('connect-google-calendar-meet').click()
  await page.waitForTimeout(50)
  const calendarRequest = await page.evaluate(() => window.name)
  assert.match(calendarRequest, /calendar\.read/)
  assert.match(calendarRequest, /calendar\.freebusy/)
  assert.match(calendarRequest, /calendar\.write/)
  assert.match(calendarRequest, /meet\.create/)
  assert.doesNotMatch(calendarRequest, /gmail/)
  await page.goto('http://localhost:5455/e2e/sales-ui-verification/index.html?view=dialog')
  await page.getByRole('heading', { name: 'Task details' }).waitFor()
  await page.waitForTimeout(300)
  await page.getByRole('tab', { name: 'Checklist', exact: true }).click()
  await page.getByText('This task has no checklist yet.').waitFor()
  assert.match(page.url(), /taskTab=checklist/)
  await page.reload()
  await page.getByText('This task has no checklist yet.').waitFor()
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'task-details.png') })
  assert.deepEqual(errors, [], errors.join(' | '))
  console.log(`sales UI verification passed: ${screenshots}`)
} finally {
  await context.close()
  await browser.close()
}
