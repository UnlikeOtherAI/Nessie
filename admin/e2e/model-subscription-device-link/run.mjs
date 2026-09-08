import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { REPO_ROOT } from '../navigation/lib/config.mjs'

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/model-subscription-device-link')
const browser = await launchBrowser()
const context = await browser.newContext({ hasTouch: true, viewport: { height: 844, width: 390 } })
const page = await context.newPage()

try {
  await page.goto('http://localhost:5455/e2e/model-subscription-device-link/index.html')
  await page.getByText('ABCD-1234').waitFor()
  await page.getByRole('button', { name: 'Copy code' }).click()
  await page.getByRole('button', { name: 'Copied' }).waitFor()

  const viewport = page.viewportSize()
  const code = await page.getByText('ABCD-1234').boundingBox()
  const copy = await page.getByRole('button', { name: 'Copied' }).boundingBox()
  assert.ok(viewport && code && copy, 'device code and copy action are measurable')
  assert.ok(code.x >= 0 && code.x + code.width <= viewport.width, 'device code stays on-screen')
  assert.ok(copy.x >= 0 && copy.x + copy.width <= viewport.width, 'copy action stays on-screen')
  assert.ok(code.x + code.width <= copy.x || copy.x + copy.width <= code.x, 'code and copy action do not overlap')

  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'phone-device-link.png') })
  console.log(`personal subscription device-link verification passed: ${screenshots}`)
} finally {
  await context.close()
  await browser.close()
}
