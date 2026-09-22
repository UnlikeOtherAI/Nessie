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
 *
 * A third: the Designer's own sentence rides on the card rather than arriving
 * as a second message, so the words and the decision are one thing.
 *
 * A fourth, since 2026-09-22: an agent nobody named a channel for is proposed
 * living "nowhere yet — add it to any channel". The Designer used to make a
 * channel for every new agent, and Accept built a room nobody asked for.
 */

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/agent-proposal-card')
const closedPath = resolve(screenshots, 'proposal-closed.png')
const openPath = resolve(screenshots, 'proposal-open.png')
const unplacedPath = resolve(screenshots, 'proposal-nowhere-yet.png')
const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ viewport: { height: 900, width: 900 } })
  const page = await context.newPage()
  await page.goto(`${ADMIN_URL}/e2e/agent-proposal-card/index.html`)

  const placed = page.getByTestId('placed-proposal')
  await placed.getByText('Sales agent', { exact: true }).waitFor()
  // One message: the Designer's own words are inside this card, above its
  // header, and there is no second bubble repeating them.
  const prose = placed.locator('[data-testid="agent-card"] .agent-card-prose')
  await prose.waitFor()
  assert.match(await prose.innerText(), /Press Accept, or tell me what/)
  await placed.getByText('sales researcher', { exact: true }).waitFor()
  await placed.getByText('KiloMayo → Sales → #sales').waitFor()

  // The model is a dropdown on the card, with the recommendation preselected,
  // rather than a question asked in prose.
  const model = placed.getByLabel('Model *')
  await model.waitFor()
  assert.equal(await model.inputValue(), 'anthropic/claude-opus-5')

  // Closed on arrival: the tool words exist in the DOM but nobody has to read
  // them to decide.
  const details = placed.locator('details.agent-card-details')
  await details.waitFor()
  assert.equal(await details.evaluate((node) => node.open), false)
  assert.equal(await placed.getByText('send_message', { exact: true }).isVisible(), false)

  for (const label of ['Accept', 'Edit', 'Decline']) {
    await placed.getByRole('button', { name: label, exact: true }).waitFor()
  }

  // Nowhere yet is a placement the card states in its own words, in the same
  // field where a named channel goes — not a missing row and not a room the
  // Designer invented.
  const unplaced = page.getByTestId('unplaced-proposal')
  await unplaced.getByText('CTO', { exact: true }).waitFor()
  const placement = unplaced.locator('dl.agent-card-fields')
  await placement.waitFor()
  assert.match(
    (await placement.innerText()).replace(/\s+/g, ' '),
    /Lives in nowhere yet — add it to any channel Who can see it Everyone in the KiloMayo team/,
  )
  assert.doesNotMatch(await placement.innerText(), /#/, 'no channel is proposed for an unplaced agent')
  await unplaced.getByRole('button', { name: 'Accept', exact: true }).waitFor()

  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ fullPage: true, path: closedPath })
  await unplaced.screenshot({ path: unplacedPath })

  await placed.getByText('What the agent can reach').click()
  await placed.getByText('send_message', { exact: true }).waitFor()
  await placed.getByText('Sales Portal', { exact: true }).waitFor()
  assert.equal(await details.evaluate((node) => node.open), true)
  // Opening the fold must not have pressed anything: the card is still open
  // and the summary click never reached the card's own click target.
  assert.equal(await placed.getByRole('button', { name: 'Accept', exact: true }).isEnabled(), true)
  await page.screenshot({ fullPage: true, path: openPath })

  await context.close()
  console.log(`Agent proposal card proofs passed: ${closedPath}, ${openPath}, ${unplacedPath}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
