import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { REPO_ROOT } from '../navigation/lib/config.mjs'

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/model-subscription-deepseek')
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { height: 844, width: 390 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})

try {
  await page.goto('http://localhost:5455/e2e/model-subscription-deepseek/index.html')
  await page.waitForTimeout(250)
  if (!await page.getByRole('button', { name: 'Link DeepSeek API' }).count()) {
    throw new Error(`DeepSeek fixture did not render: ${errors.join(' | ')}\n${await page.locator('body').innerText()}`)
  }
  await page.getByRole('button', { name: 'Link DeepSeek API' }).waitFor()
  await page.getByRole('button', { name: 'Link DeepSeek API' }).click()
  await page.getByText('own DeepSeek API balance').waitFor()
  await page.getByRole('button', { name: 'Cancel' }).click()

  await page.locator('#deepseek-agent-model').click()
  await page.getByText('Your subscriptions').waitFor()
  await page.getByText('DeepSeek API', { exact: true }).waitFor()
  await page.getByText('DeepSeek Flash', { exact: true }).waitFor()
  assert.deepEqual(errors, [], errors.join(' | '))

  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'phone-deepseek-connection.png') })
  console.log(`personal DeepSeek subscription verification passed: ${screenshots}`)
} finally {
  await context.close()
  await browser.close()
}
