import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * A control is drawn only for somebody the server would let use it.
 *
 * `POST`/`DELETE /api/agents/:agentId/bindings` require the organisation owner
 * role on top of channel membership, while adding a person is any member. The
 * popup drew the agent Add and Remove for everybody, so an ordinary member had
 * two buttons whose only outcome was 403 `POLICY_DENIED` — the control nobody
 * can use that Rule zero names.
 */

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/project-usability/channel-agent-controls')
const memberPath = resolve(screenshots, 'member-has-no-agent-controls.png')
const ownerPath = resolve(screenshots, 'owner-has-agent-controls.png')
const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ viewport: { height: 820, width: 760 } })
  const page = await context.newPage()
  await page.goto(`${ADMIN_URL}/e2e/channel-agent-controls/index.html`)

  const agentAdd = page.getByTestId('channel-agent-add')
  const agentRemove = page.getByTestId('channel-agent-remove')

  // A channel member who is not an organisation owner.
  await page.getByText('Sales agent', { exact: true }).waitFor()
  assert.equal(await agentAdd.count(), 0, 'a non-owner must not be offered an agent Add')
  assert.equal(await agentRemove.count(), 0, 'a non-owner must not be offered an agent Remove')

  // The rows and the wider permissions beside them are untouched: the agents
  // are still listed, copying one is still offered, and adding a PERSON — which
  // really is any member of the channel — still works.
  await page.getByText('Support agent', { exact: true }).waitFor()
  assert.ok(await page.getByTitle('Create a copy you own').count() > 0)
  await page.getByText('Colleague', { exact: true }).waitFor()
  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ fullPage: true, path: memberPath })

  // The same popup for an organisation owner.
  await page.evaluate(() => {
    window.__channelAgentControlsFixture.setCanManageAgents(true)
  })
  await agentAdd.first().waitFor()
  await agentRemove.first().waitFor()
  assert.equal(await agentAdd.count(), 1)
  assert.equal(await agentRemove.count(), 1)
  await page.screenshot({ fullPage: true, path: ownerPath })

  await context.close()
  console.log(`Channel agent control proofs passed: ${memberPath}, ${ownerPath}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
