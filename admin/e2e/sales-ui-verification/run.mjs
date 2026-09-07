import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { REPO_ROOT } from '../navigation/lib/config.mjs'

const screenshotPath = resolve(REPO_ROOT, 'e2e/screenshots/sales-ui-verification/todo-title-focus.png')
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { height: 900, width: 1280 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
try {
  await page.goto('http://localhost:5455/e2e/sales-ui-verification/index.html')
  await page.waitForTimeout(1_000)
  if (errors.length > 0) throw new Error(errors.join(' | '))
  const title = page.getByLabel('Title')
  await title.fill('Verify the business and venue')
  assert.equal(await title.evaluate((input) => document.activeElement === input), true, 'title keeps focus')
  assert.equal(await title.inputValue(), 'Verify the business and venue')
  if (errors.length > 0) throw new Error(errors.join(' | '))
  await mkdir(dirname(screenshotPath), { recursive: true })
  await page.screenshot({ fullPage: true, path: screenshotPath })
  console.log(`sales UI title-focus fixture passed: ${screenshotPath}`)
} finally {
  await context.close()
  await browser.close()
}
