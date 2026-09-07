#!/usr/bin/env node
// A durable UI check for a connected Linear source. Provider credentials,
// webhooks and worker behaviour are server tests; this owns the person's
// settings and board doorways, plus failure recovery at the HTTP boundary.

import assert from 'node:assert/strict'

import { ADMIN_PORT } from '../navigation/lib/config.mjs'
import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { createConnectedBoardSourceFixtures, ids } from './fixtures.mjs'

const adminUrl = `http://localhost:${ADMIN_PORT}`
const sourceSettingsPath = `/projects/${ids.project}/settings?section=sources&source=${ids.source}`

const assertTouchTarget = async (locator, label) => {
  const box = await locator.boundingBox()
  assert.ok(box, `${label} is visible`)
  assert.ok(box.height >= 44, `${label} is at least 44px high (was ${box.height}px)`)
  return box
}

const waitForMappingRequest = async (fixtures) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (fixtures.calls.some((call) => call.pathname.endsWith('/mappings') && call.method === 'PUT')) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('mapping request did not start')
}

const open = async (browser, name, fixtures) => {
  const context = await openViewportContext(browser, {
    name,
    route: fixtures.respond,
    token: 'connected-board-sources-e2e-token',
  })
  const page = await context.newPage()
  return { context, ...page }
}

const exerciseDesktop = async (browser, fixtures) => {
  const { close, context, errors, page } = await open(browser, 'desktop', fixtures)
  try {
    await page.goto(`${adminUrl}${sourceSettingsPath}`)
    await page.getByRole('button', { name: 'Linear · UnlikeOtherAI QA' }).waitFor()
    await assertTouchTarget(page.getByRole('button', { name: 'Linear · UnlikeOtherAI QA' }), 'source chooser')
    await assertTouchTarget(page.getByLabel('Category for Triage'), 'state selector')
    await assertTouchTarget(page.getByLabel('Target for Priority'), 'field selector')
    await assertTouchTarget(page.getByLabel('Nessie identity for Alex Linear'), 'person selector')

    fixtures.holdNextMapping()
    const category = page.getByLabel('Category for Triage')
    await category.selectOption('in_progress')
    await waitForMappingRequest(fixtures)
    assert.equal(await category.isDisabled(), true, 'mapping controls lock while saving')
    await fixtures.rejectHeldMapping()
    await page.getByRole('alert').filter({ hasText: 'UnlikeOtherAI QA rejected this mapping.' }).waitFor()
    assert.equal(await category.inputValue(), 'inbox', 'a rejected mapping restores the saved choice')

    await category.selectOption('in_progress')
    await page.getByText('Saved.').waitFor()
    const mutation = fixtures.calls.filter((call) => call.pathname.endsWith('/mappings')).at(-1)
    const agentLink = mutation.body.identityLinks.find((link) => link.externalUserId === 'linear-agent')
    assert.equal(agentLink.agentId, ids.agent, 'saving a person mapping preserves an agent link')

    await page.goto(`${adminUrl}/projects/${ids.project}/board?board=${ids.board}`)
    const sourceLink = page.locator(`a[href="${sourceSettingsPath}"]`)
    await sourceLink.waitFor()
    await assertTouchTarget(sourceLink, 'source health doorway')
    const sync = page.getByRole('button', { name: 'Sync UnlikeOtherAI QA from Linear now' })
    await assertTouchTarget(sync, 'sync source')
    await sync.click()
    await page.waitForTimeout(50)
    assert.ok(fixtures.calls.some((call) => call.pathname.endsWith('/sync') && call.method === 'POST'), 'sync uses the source action endpoint')
    assert.deepEqual(errors, [], `desktop page errors: ${errors.join('; ')}`)
  } finally {
    await close()
    await context.close()
  }
}

const exercisePhone = async (browser, fixtures) => {
  const { close, context, errors, page } = await open(browser, 'phone', fixtures)
  try {
    await page.goto(`${adminUrl}${sourceSettingsPath}`)
    const stateName = page.getByText('Triage', { exact: true })
    const category = page.getByLabel('Category for Triage')
    await stateName.waitFor()
    const [nameBox, selectBox] = await Promise.all([stateName.boundingBox(), category.boundingBox()])
    assert.ok(nameBox && selectBox, 'phone state row is visible')
    assert.ok(nameBox.y + nameBox.height <= selectBox.y, 'phone mapping controls stack below their label')
    await assertTouchTarget(category, 'phone state selector')
    await assertTouchTarget(page.getByLabel('Target for Priority'), 'phone field selector')
    await assertTouchTarget(page.getByLabel('Nessie identity for Alex Linear'), 'phone person selector')
    assert.deepEqual(errors, [], `phone page errors: ${errors.join('; ')}`)
  } finally {
    await close()
    await context.close()
  }
}

const main = async () => {
  const fixtures = createConnectedBoardSourceFixtures()
  const browser = await launchBrowser()
  try {
    await exerciseDesktop(browser, fixtures)
    await exercisePhone(browser, fixtures)
    assert.deepEqual(fixtures.unhandled, [], `unhandled fixture requests: ${JSON.stringify(fixtures.unhandled)}`)
    console.log('Connected board source UI evaluation passed.')
  } finally {
    await browser.close()
  }
}

await main()
