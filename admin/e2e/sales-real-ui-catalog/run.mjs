import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const root = 'http://localhost:5455'
const board = process.env.NESSIE_UI_BOARD_PATH
const taskTitle = process.env.NESSIE_UI_TASK_TITLE
const stepTitle = process.env.NESSIE_UI_CHECKLIST_STEP
if (!board || !taskTitle || !stepTitle) {
  throw new Error('Set NESSIE_UI_BOARD_PATH, NESSIE_UI_TASK_TITLE, and NESSIE_UI_CHECKLIST_STEP.')
}
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
try {
  await page.goto(`${root}/login`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /dev login/i }).click()
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20_000 })
  await page.goto(`${root}${board}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'New task', exact: true }).first().waitFor({ timeout: 25_000 })
  await page.getByText(taskTitle, { exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('tab', { name: 'Checklist', exact: true }).click()
  const checklist = dialog.getByTestId('task-checklist')
  await checklist.waitFor({ timeout: 20_000 })
  const result = checklist.getByLabel(`Result for ${stepTitle}`)
  const complete = checklist.getByLabel(`Complete ${stepTitle}`)
  if (await complete.isChecked()) {
    const [toggleResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/checklist/steps/') && response.request().method() === 'PATCH', { timeout: 20_000 }),
      complete.click(),
    ])
    assert.equal(toggleResponse.status(), 200)
    await expectChecked(complete, false)
  }
  const [completionResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/checklist/steps/') && response.request().method() === 'PATCH', { timeout: 20_000 }),
    complete.click(),
  ])
  assert.equal(completionResponse.status(), 200)
  await expectChecked(complete, true)
  await result.fill('Saved result 1')
  const [savedResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/checklist/steps/') && response.request().method() === 'PATCH', { timeout: 20_000 }),
    checklist.getByRole('button', { name: 'Save result', exact: true }).click(),
  ])
  assert.equal(savedResponse.status(), 200)
  await checklist.getByText('Saved.', { exact: true }).waitFor({ timeout: 20_000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'New task', exact: true }).first().waitFor({ timeout: 25_000 })
  await page.getByText(taskTitle, { exact: true }).first().click()
  const reopened = page.getByRole('dialog')
  await reopened.getByRole('tab', { name: 'Checklist', exact: true }).click()
  const restored = reopened.getByTestId('task-checklist')
  await restored.waitFor({ timeout: 20_000 })
  assert.equal(await restored.getByLabel(`Result for ${stepTitle}`).inputValue(), 'Saved result 1')
  assert.equal(await restored.getByLabel(`Complete ${stepTitle}`).isChecked(), true)
  await restored.getByLabel(`Result for ${stepTitle}`).fill('')
  const [clearedResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/checklist/steps/') && response.request().method() === 'PATCH', { timeout: 20_000 }),
    restored.getByRole('button', { name: 'Save result', exact: true }).click(),
  ])
  assert.equal(clearedResponse.status(), 200)
  await restored.getByText('Saved.', { exact: true }).waitFor({ timeout: 20_000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'New task', exact: true }).first().waitFor({ timeout: 25_000 })
  await page.getByText(taskTitle, { exact: true }).first().click()
  const finalDialog = page.getByRole('dialog')
  await finalDialog.getByRole('tab', { name: 'Checklist', exact: true }).click()
  const finalChecklist = finalDialog.getByTestId('task-checklist')
  await finalChecklist.waitFor({ timeout: 20_000 })
  assert.equal(await finalChecklist.getByLabel(`Result for ${stepTitle}`).inputValue(), '')
  assert.equal(await finalChecklist.getByLabel(`Complete ${stepTitle}`).isChecked(), true)
  await page.screenshot({ fullPage: true, path: 'local-checklist-cleared-reload.png' })
  console.log('CHECKLIST_PERSISTENCE=PASS')
} finally { await browser.close() }

async function expectChecked(locator, expected) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await locator.isChecked() === expected) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(await locator.isChecked(), expected)
}
