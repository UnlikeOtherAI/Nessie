#!/usr/bin/env node
// A durable UI check for a connected Linear source. Provider credentials,
// webhooks and worker behaviour are server tests; this owns the person's
// settings and board doorways, plus failure recovery at the HTTP boundary.

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ADMIN_PORT } from '../navigation/lib/config.mjs'
import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { createConnectedBoardSourceFixtures, ids, sourceName } from './fixtures.mjs'

const adminUrl = `http://localhost:${ADMIN_PORT}`
const sourceSettingsPath = `/projects/${ids.project}/settings?section=sources&source=${ids.source}`
const watcherSettingsPath = `/projects/${ids.project}/boards/${ids.board}/settings?tab=watchers`
const screenshotRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'e2e', 'screenshots', 'connected-board-sources',
)

const screenshot = async (page, name) => {
  if (process.env.CONNECTED_BOARD_SOURCES_SCREENSHOTS !== '1') return
  await mkdir(screenshotRoot, { recursive: true })
  await page.screenshot({ path: resolve(screenshotRoot, `${name}.png`), fullPage: true })
}

const assertTouchTarget = async (locator, label) => {
  const box = await locator.boundingBox()
  assert.ok(box, `${label} is visible`)
  assert.ok(box.height >= 44, `${label} is at least 44px high (was ${box.height}px)`)
  return box
}

// The sync row is the first row of the board's Configure menu. On a narrow
// header Configure can collapse into More, whose popover draws the menu's
// rows directly — either way the row is one press away.
const openConfigure = async (page) => {
  const configure = page.getByRole('button', { name: 'Configure' })
  const more = page.getByRole('button', { name: 'More page actions' })
  // The overflow controller measures before it partitions, so wait for
  // whichever doorway the header settled on.
  await configure.or(more).first().waitFor()
  if (await configure.count() > 0) {
    await configure.click()
    return
  }
  await more.click()
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
    const sourceChooser = page.getByRole('button', { name: `Linear · ${sourceName}` })
    await sourceChooser.waitFor()
    await assertTouchTarget(sourceChooser, 'source chooser')
    await assertTouchTarget(page.getByLabel('Category for Triage'), 'state selector')
    await assertTouchTarget(page.getByLabel('Target for Priority'), 'field selector')
    await assertTouchTarget(page.getByLabel('Nessie identity for Alex Linear'), 'person selector')
    await screenshot(page, 'desktop-source-settings')

    fixtures.holdNextMapping()
    const category = page.getByLabel('Category for Triage')
    await category.selectOption('in_progress')
    await waitForMappingRequest(fixtures)
    assert.equal(await category.isDisabled(), true, 'mapping controls lock while saving')
    const rejectedMutation = fixtures.calls.filter((call) => call.pathname.endsWith('/mappings')).at(-1)
    const inProgressDefaults = rejectedMutation.body.stateMapping.filter(
      (entry) => entry.category === 'in_progress' && entry.isDefaultForCategory,
    )
    assert.deepEqual(
      inProgressDefaults.map((entry) => entry.externalStateId),
      ['started'],
      'moving a default clears it before another category can be chosen',
    )
    await fixtures.rejectHeldMapping()
    await page.getByRole('alert').filter({ hasText: 'UnlikeOtherAI QA rejected this mapping.' }).waitFor()
    assert.equal(await category.inputValue(), 'todo', 'a rejected mapping restores the saved choice')

    await category.selectOption('in_progress')
    await page.getByText('Saved.').waitFor()
    const mutation = fixtures.calls.filter((call) => call.pathname.endsWith('/mappings')).at(-1)
    const agentLink = mutation.body.identityLinks.find((link) => link.externalUserId === 'linear-agent')
    assert.equal(agentLink.agentId, ids.agent, 'saving a person mapping preserves an agent link')

    await page.goto(`${adminUrl}/projects/${ids.project}/board?board=${ids.board}`)
    await openConfigure(page)
    const syncRow = page.getByRole('menuitem', { name: /Sync/ })
    await syncRow.waitFor()
    await assertTouchTarget(syncRow, 'sync source row')
    // The freshness sentence the board's status strip used to carry now rides
    // under the row's label.
    assert.match(await syncRow.textContent(), new RegExp(`Linear ${sourceName} · synced`), 'the row names the source and its freshness')
    await syncRow.click()
    await page.waitForTimeout(50)
    assert.ok(fixtures.calls.some((call) => call.pathname.endsWith('/sync') && call.method === 'POST'), 'sync uses the source action endpoint')

    await page.goto(`${adminUrl}/projects/${ids.project}/board?board=${ids.localBoard}`)
    await page.getByText('To do', { exact: true }).waitFor()
    await openConfigure(page)
    await page.waitForTimeout(50)
    assert.equal(await page.getByRole('menuitem', { name: /Sync/ }).count(), 0, 'a local-only board shows no sync row')
    assert.ok(
      fixtures.calls.some(
        (call) => call.pathname === `/api/projects/${ids.project}/sources` && call.search === `?boardId=${ids.localBoard}`,
      ),
      'the menu asks the server for the selected board’s sources',
    )
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
    await screenshot(page, 'phone-source-settings')
    await page.goto(`${adminUrl}/projects/${ids.project}/board?board=${ids.board}`)
    await openConfigure(page)
    const syncRow = page.getByRole('menuitem', { name: /Sync/ })
    await syncRow.waitFor()
    const syncBox = await syncRow.boundingBox()
    assert.ok(syncBox && syncBox.x >= 0 && syncBox.x + syncBox.width <= 390, 'phone sync row stays within the viewport')
    await assertTouchTarget(syncRow, 'phone sync source row')
    await screenshot(page, 'phone-configure-sync')
    assert.deepEqual(errors, [], `phone page errors: ${errors.join('; ')}`)
  } finally {
    await close()
    await context.close()
  }
}

const exerciseWatcherSave = async (browser, fixtures) => {
  const { close, context, errors, page } = await open(browser, 'desktop', fixtures)
  try {
    await page.goto(`${adminUrl}${watcherSettingsPath}`)
    const recipient = page.getByLabel('Tell')
    await recipient.waitFor()
    // Watchers are people; an agent is set up to start work from a column.
    await page.getByTestId('watchers-agents-moved').filter({ hasText: 'Start work with an agent' }).waitFor()
    await recipient.fill('watcher')
    const person = page.getByRole('button', { name: 'UnlikeOtherAI QA watcher qa-watcher@example.test' })
    await person.waitFor()
    assert.equal(
      await page.getByRole('button', { name: 'UnlikeOtherAI QA watcher agent' }).count(),
      0,
      'the address bar offers people only, never the agent of the same name',
    )
    await person.click()
    assert.equal(
      await page.getByRole('button', { name: 'UnlikeOtherAI QA backup' }).count(),
      0,
      'watcher suggestions close after a choice while another option remains',
    )
    await page.keyboard.press('Enter')
    const save = page.getByRole('button', { name: 'Save watchers' })
    await save.click()
    await page.waitForTimeout(50)
    const call = fixtures.calls.filter((entry) => entry.pathname.endsWith('/watchers') && entry.method === 'PUT').at(-1)
    assert.deepEqual(call.body.watchers, [{ id: ids.watcher, kind: 'user' }], 'Save remains reachable and submits only the chosen watcher')
    assert.deepEqual(errors, [], `watcher page errors: ${errors.join('; ')}`)
  } finally {
    await close()
    await context.close()
  }
}

const main = async () => {
  const fixtures = createConnectedBoardSourceFixtures()
  // One browser per exercise: a failure in one leaves no aborted page for the
  // next to inherit, and a constrained Chromium (single-process) survives
  // only its first context.
  const withBrowser = async (exercise) => {
    const browser = await launchBrowser()
    try {
      await exercise(browser, fixtures)
    } finally {
      await browser.close()
    }
  }
  await withBrowser(exerciseDesktop)
  await withBrowser(exercisePhone)
  await withBrowser(exerciseWatcherSave)
  assert.deepEqual(fixtures.unhandled, [], `unhandled fixture requests: ${JSON.stringify(fixtures.unhandled)}`)
  console.log('Connected board source UI evaluation passed.')
}

await main()
