import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const output = resolve(REPO_ROOT, 'e2e/screenshots/agent-sharing')
const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { height: 900, width: 1280 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${ADMIN_URL}/e2e/agent-sharing/index.html`)
  await page.getByTestId('agent-ownership-state').waitFor()
  await page.getByText('Shared', { exact: true }).first().waitFor()
  await page.getByText('Owned by you', { exact: true }).waitFor()
  await mkdir(output, { recursive: true })
  await page.screenshot({ fullPage: true, path: resolve(output, 'owned-shared.png') })
  await page.getByTestId('agent-ownership-action').click()
  await page.getByRole('dialog').getByText('Transfer ownership of Morning Joke to the team?').waitFor()
  await page.screenshot({ fullPage: true, path: resolve(output, 'transfer-confirmation.png') })
  await page.getByRole('dialog').getByRole('button', { name: 'Transfer ownership to team' }).click()
  await page.getByTestId('agent-ownership-action').waitFor()
  assert.equal(errors.length, 0, `Agent-sharing fixture errors: ${errors.join(' | ')}`)
  console.log(`Agent sharing visual proof written to ${output}`)
  await context.close()
} finally {
  await browser.close()
  await stopProcess(admin)
}
