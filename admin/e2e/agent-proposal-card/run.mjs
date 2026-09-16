import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * The Agent Designer's proposal card, in the product's own card renderer.
 *
 * Two promises, and they pull against each other, which is why the card has a
 * fold at all: the whole tool and app selection has to be ON the card, because
 * approving the card is what approves that list — and it has to stay readable
 * while somebody decides whether the name and the placement are right.
 */

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/agent-proposal-card')
const closedPath = resolve(screenshots, 'proposal-closed.png')
const openPath = resolve(screenshots, 'proposal-open.png')
const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ viewport: { height: 900, width: 900 } })
  const page = await context.newPage()
  await page.goto(`${ADMIN_URL}/e2e/agent-proposal-card/index.html`)

  await page.getByText('Sales agent', { exact: true }).waitFor()
  await page.getByText('sales researcher', { exact: true }).waitFor()
  await page.getByText('KiloMayo → Sales → #sales').waitFor()

  // The model is a dropdown on the card, with the recommendation preselected,
  // rather than a question asked in prose.
  const model = page.getByLabel('Model *')
  await model.waitFor()
  assert.equal(await model.inputValue(), 'anthropic/claude-opus-5')

  // Closed on arrival: the tool words exist in the DOM but nobody has to read
  // them to decide.
  const details = page.locator('details.agent-card-details')
  await details.waitFor()
  assert.equal(await details.evaluate((node) => node.open), false)
  assert.equal(await page.getByText('send_message', { exact: true }).isVisible(), false)

  for (const label of ['Accept', 'Edit', 'Discard']) {
    await page.getByRole('button', { name: label, exact: true }).waitFor()
  }
  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ fullPage: true, path: closedPath })

  await page.getByText('What he can reach').click()
  await page.getByText('send_message', { exact: true }).waitFor()
  await page.getByText('Sales Portal', { exact: true }).waitFor()
  assert.equal(await details.evaluate((node) => node.open), true)
  // Opening the fold must not have pressed anything: the card is still open
  // and the summary click never reached the card's own click target.
  assert.equal(await page.getByRole('button', { name: 'Accept', exact: true }).isEnabled(), true)
  await page.screenshot({ fullPage: true, path: openPath })

  await context.close()
  console.log(`Agent proposal card proofs passed: ${closedPath}, ${openPath}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
