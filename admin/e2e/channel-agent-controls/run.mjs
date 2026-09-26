import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * A control is usable only by somebody the server would let use it, and is
 * shown to somebody who could with more standing — disabled, saying who can.
 *
 * `POST`/`DELETE /api/agents/:agentId/bindings` require organisation OWNER or
 * ADMIN standing, while adding a person is any member of the channel. The old
 * members popup drew the agent Add and Remove for everybody, so an ordinary
 * member had two buttons whose only outcome was 403 `POLICY_DENIED`; it then
 * hid them. Details › Agents shows them disabled with the reason (plan R9).
 *
 * Channel membership is deliberately NOT part of the agent authority. An
 * organisation admin administering a room they never joined keeps the agent
 * controls, because management is not participation and placing an agent must
 * not silently make them a member. The third case below is that person: the
 * agent controls live, and adding a person — a membership standing here — not.
 */

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/project-usability/channel-agent-controls')
const memberPath = resolve(screenshots, 'member-sees-agent-controls-disabled.png')
const ownerPath = resolve(screenshots, 'owner-has-agent-controls.png')
const adminNonMemberPath = resolve(screenshots, 'admin-non-member-has-agent-controls.png')
const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ viewport: { height: 900, width: 760 } })
  const page = await context.newPage()
  await page.goto(`${ADMIN_URL}/e2e/channel-agent-controls/index.html`)

  const agentAdd = page.getByTestId('channel-agent-add')
  const agentRemove = page.getByTestId('channel-agent-remove')
  const reason = page.getByText('Only an organisation owner or admin can add or remove agents here.', { exact: true })
  const addPeople = page.getByRole('button', { name: 'Add people', exact: true })

  // A channel member who is not an organisation owner or admin.
  await page.getByText('Sales agent', { exact: true }).waitFor()
  assert.equal(await agentAdd.count(), 1, 'the agent Add is shown to a member')
  assert.equal(await agentAdd.isDisabled(), true, 'but disabled: only an owner or admin may place an agent')
  assert.equal(await agentRemove.isDisabled(), true, 'and so is its Remove')
  await reason.waitFor()
  assert.equal(
    await agentAdd.getAttribute('title'),
    'Only an organisation owner or admin can add or remove agents here',
    'the disabled control says who can use it',
  )

  // The rows and the wider permissions beside them are untouched: the agents
  // are still listed, copying one is still offered, and adding a PERSON — which
  // really is any member of the channel — still works.
  await page.getByText('Support agent', { exact: true }).waitFor()
  assert.ok(await page.getByTitle('Create a copy you own').count() > 0)
  await page.getByText('Colleague', { exact: true }).waitFor()
  assert.equal(await addPeople.isEnabled(), true, 'a member may add a person')
  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ fullPage: true, path: memberPath })

  // The same sections for an organisation owner.
  await page.evaluate(() => {
    window.__channelAgentControlsFixture.setCanManageAgents(true)
  })
  await page.waitForFunction(() => !document.querySelector('[data-testid="channel-agent-add"]')?.hasAttribute('disabled'))
  assert.equal(await agentAdd.isEnabled(), true)
  assert.equal(await agentRemove.isEnabled(), true)
  assert.equal(await reason.count(), 0, 'nobody is told what they can already do')
  await page.screenshot({ fullPage: true, path: ownerPath })

  // An organisation admin who is NOT in this channel. The agent controls stay,
  // because the binding routes take their standing and not their membership;
  // adding a person here does not.
  await page.evaluate(() => {
    window.__channelAgentControlsFixture.setViewerIsMember(false)
  })
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'Add people')?.disabled)
  assert.equal(await agentAdd.isEnabled(), true, 'an admin outside the channel keeps agent Add')
  assert.equal(await agentRemove.isEnabled(), true, 'an admin outside the channel keeps agent Remove')
  assert.equal(await addPeople.isDisabled(), true, 'but adds no person to a room they are not in')
  await page.screenshot({ fullPage: true, path: adminNonMemberPath })

  await context.close()
  console.log(
    `Channel agent control proofs passed: ${memberPath}, ${ownerPath}, ${adminNonMemberPath}`,
  )
} finally {
  await browser.close()
  await stopProcess(admin)
}
