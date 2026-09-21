import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * An overlay follows the screen it was opened from (docs/navigation/overlays.md,
 * "An overlay belongs to its layer").
 *
 * A pure fixture over a stubbed ApiClient and the real navigation stack. A
 * dialog stays open on a screen that something is pushed over — the retained
 * screen keeps the URL that opened it — and this pins what a person gets:
 * the dialog is not painted, not in the accessibility tree, does not trap
 * focus and is not what Escape or Back acts on; and when its screen is on top
 * again it is back as it was, the same DOM node with the words typed into it.
 * Run at the desktop's `split` layout and the phone's `single` one, plus the
 * phone's nested stage: a dialog opened inside a stage stays up while the
 * stage is on top and follows the stage when a route is pushed over it.
 * Screenshots land in e2e/screenshots/overlay-layer/.
 */

const SHOTS = resolve(REPO_ROOT, 'e2e/screenshots/overlay-layer')
const shot = (name) => resolve(SHOTS, name)

const PROJECT = '10000000-0000-4000-8000-000000000002'
const BOARD = '10000000-0000-4000-8000-000000000003'
const TASK = '10000000-0000-4000-8000-000000000006'
const SETTINGS_PATH = `/projects/${PROJECT}/boards/${BOARD}/settings`
const SETTINGS_ROUTE = 'projects:project-board-settings'
const TYPED = 'Typed before the push'

const open = async (context, query = '') => {
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${ADMIN_URL}/e2e/overlay-layer/index.html${query ? `?${query}` : ''}`)
  await page.bringToFront()
  await page.locator('[data-ready="true"]').waitFor()
  return { errors, page }
}

/** The stack has landed: no slide running, and every animation has finished. */
const settled = async (page, route = null) => {
  // Two frames first: the URL changes before React commits the stack, so a
  // check that ran at once could see the previous, already-settled pose.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.waitForFunction((routeKey) => {
    const viewport = document.querySelector('[data-phone-navigation-viewport]')
    const current = viewport?.querySelector('[data-phone-navigation-layer="current"]')
    return current && !viewport.hasAttribute('data-phone-navigation-phase')
      && !viewport.querySelector('[data-phone-navigation-layer="incoming"], [data-phone-navigation-layer="outgoing"]')
      && (!routeKey || current.getAttribute('data-phone-navigation-route') === routeKey)
      && document.getAnimations().every((animation) => animation.playState !== 'running')
  }, route)
  await page.waitForTimeout(150)
}

const pathname = (page) => page.evaluate(() => `${location.pathname}${location.search}`)

/** What the one Back resolver would do right now — the header Back, Escape, the edge swipe. */
const backAction = (page) => page.evaluate(() => {
  const action = window.overlayLayerFixture.navigation.resolveBackAction()
  return action ? { id: action.kind === 'owner' ? action.id : null, kind: action.kind } : null
})

const closes = (page) => page.evaluate(() => [...window.overlayLayerFixture.closes])

/** Tag the dialog's DOM node, so "back as it was" can mean the same node, not a remount. */
const tagDialog = (page, name) => page.evaluate((dialogName) => {
  const panel = [...document.querySelectorAll('[role="dialog"]')].find((node) =>
    document.getElementById(node.getAttribute('aria-labelledby') ?? '')?.textContent === dialogName)
  window.taggedDialog = panel ?? null
  return Boolean(panel)
}, name)

const taggedDialogState = (page) => page.evaluate(() => {
  const panel = window.taggedDialog
  const slot = panel?.closest('.admin-overlay-slot') ?? null
  return {
    connected: Boolean(panel?.isConnected),
    slotHidden: Boolean(slot?.hidden),
    slotCovered: slot?.getAttribute('data-overlay-covered') ?? null,
  }
})

/** Where Tab lands, as the screen it belongs to. */
const focusOwner = (page) => page.evaluate(() => {
  const active = document.activeElement
  if (!active || active === document.body) return 'body'
  if (active.closest('.admin-overlay-slot')) return 'overlay'
  const layer = active.closest('[data-phone-navigation-layer]')
  return layer ? `layer:${layer.getAttribute('data-phone-navigation-layer')}` : 'elsewhere'
})

const tabLandings = async (page, presses = 6) => {
  const owners = []
  for (let press = 0; press < presses; press += 1) {
    await page.keyboard.press('Tab')
    owners.push(await focusOwner(page))
  }
  return owners
}

/**
 * After the push: the dialog is out of paint, the a11y tree, focus and Back,
 * and neither Escape nor Back reaches it — yet it is still mounted.
 */
const assertCovered = async (page, { backOwner = null, dialogName, closesBefore, label }) => {
  const dialog = page.getByRole('dialog', { name: dialogName })
  assert.equal(await dialog.count(), 0, `${label}: the covered dialog is not in the accessibility tree`)
  const panel = page.locator('[role="dialog"]', { hasText: dialogName })
  assert.equal(await panel.count(), 1, `${label}: but it is still mounted`)
  assert.equal(await panel.boundingBox(), null, `${label}: and not painted`)
  await assert.doesNotReject(panel.waitFor({ state: 'hidden' }))
  const state = await taggedDialogState(page)
  assert.deepEqual(state, { connected: true, slotCovered: 'true', slotHidden: true }, `${label}: its slot is hidden`)
  const tree = await page.locator('body').ariaSnapshot()
  assert.ok(!tree.includes(dialogName), `${label}: the aria snapshot has no "${dialogName}"`)

  const action = await backAction(page)
  assert.ok(!action?.id?.startsWith('overlay:'), `${label}: Back never reaches the covered dialog (${JSON.stringify(action)})`)
  if (backOwner) {
    // KNOWN GAP, pinned on purpose: a nested stage keeps its Back registration
    // while a route is pushed over it (NestedStage registers on `active`
    // alone), so Back on the pushed screen would close the stage beneath it
    // rather than pop the route. Not an overlay's doing; when the stage learns
    // to go dormant under a push, this expectation becomes `route`.
    assert.deepEqual(action, { id: backOwner, kind: 'owner' }, `${label}: known gap — the covered stage still owns Back`)
  } else {
    assert.equal(action?.kind, 'route', `${label}: Back acts on the pushed screen (${JSON.stringify(action)})`)
  }

  const owners = await tabLandings(page)
  assert.ok(!owners.includes('overlay'), `${label}: Tab never enters the covered dialog (${owners})`)
  assert.ok(owners.includes('layer:current'), `${label}: Tab reaches the pushed screen (${owners})`)

  const before = await pathname(page)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  assert.equal(await pathname(page), before, `${label}: Escape leaves the pushed screen where it is`)
  assert.deepEqual(await closes(page), closesBefore, `${label}: Escape did not close the dialog beneath`)
  assert.equal((await taggedDialogState(page)).connected, true, `${label}: the dialog is still mounted after Escape`)
}

/** Back on its screen: the same node, visible, live again. */
const assertRestored = async (page, { dialogName, field, label, value, closesBefore }) => {
  const dialog = page.getByRole('dialog', { name: dialogName })
  await dialog.waitFor({ state: 'visible' })
  const state = await taggedDialogState(page)
  assert.deepEqual(state, { connected: true, slotCovered: null, slotHidden: false }, `${label}: its slot is shown`)
  assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]') === window.taggedDialog
    || [...document.querySelectorAll('[role="dialog"]')].includes(window.taggedDialog)), true,
  `${label}: the same dialog node, never remounted`)
  assert.equal(await dialog.getByRole('textbox', { name: field }).inputValue(), value, `${label}: what was typed is still there`)
  assert.deepEqual(await closes(page), closesBefore, `${label}: the dialog was never closed`)
  const action = await backAction(page)
  assert.equal(action?.kind, 'owner', `${label}: the dialog owns Back again (${JSON.stringify(action)})`)
  assert.match(action.id, /^overlay:/, `${label}: as an overlay`)
  const owners = await tabLandings(page, 4)
  assert.ok(owners.every((owner) => owner === 'overlay'), `${label}: focus is trapped in the dialog again (${owners})`)
}

/** The board's ticket, open with a typed title, then a push from inside it. */
const boardCase = async (context, { name }) => {
  const { errors, page } = await open(context)
  const layout = await page.locator('main[data-layout]').getAttribute('data-layout')
  assert.equal(layout, name === 'desktop' ? 'split' : 'single', 'the stack runs in the layout this viewport gets')
  await page.getByRole('button', { name: 'Open ticket' }).click()
  const dialog = page.getByRole('dialog', { name: 'Task details' })
  await dialog.waitFor()
  const title = dialog.getByRole('textbox', { name: 'Title' })
  await title.fill(TYPED)
  assert.ok(await tagDialog(page, 'Task details'))
  assert.match(await pathname(page), new RegExp(`task=${TASK}`))
  await settled(page)
  await page.screenshot({ path: shot(`${name}-1-before-push.png`) })

  // The push, from inside the dialog, closing nothing.
  await dialog.getByRole('button', { name: 'Open board settings' }).click()
  await page.waitForURL((url) => url.pathname === SETTINGS_PATH)
  await settled(page, SETTINGS_ROUTE)
  await page.locator('[data-phone-navigation-layer="current"]').getByRole('tab', { name: /Labels/ }).waitFor()
  assert.equal(await page.locator('[data-phone-navigation-layer="underlay"] [data-screen="board"]').count(), 1,
    'the board is retained beneath the pushed screen')
  await assertCovered(page, { closesBefore: [], dialogName: 'Task details', label: `${name} board` })
  await page.screenshot({ path: shot(`${name}-2-after-push.png`) })

  // Browser Back: the board is on top again, and so is its ticket.
  await page.goBack()
  await page.waitForURL((url) => url.pathname.endsWith('/board') && url.searchParams.get('task') === TASK)
  await settled(page)
  await assertRestored(page, { closesBefore: [], dialogName: 'Task details', field: 'Title', label: `${name} board`, value: TYPED })
  await page.screenshot({ path: shot(`${name}-3-after-back.png`) })

  if (name === 'desktop') {
    // The desktop top bar's history Back walks the same path: push again,
    // come back through `history.goBack`, which asks the Back registry first.
    await dialog.getByRole('button', { name: 'Open board settings' }).click()
    await page.waitForURL((url) => url.pathname === SETTINGS_PATH)
    await settled(page, SETTINGS_ROUTE)
    assert.equal((await taggedDialogState(page)).slotHidden, true, 'covered on the second push too')
    await page.evaluate(() => window.overlayLayerFixture.navigation.history.goBack())
    await page.waitForURL((url) => url.pathname.endsWith('/board'))
    await settled(page)
    await assertRestored(page, { closesBefore: [], dialogName: 'Task details', field: 'Title', label: 'desktop history Back', value: TYPED })
  }

  // Once live again, Escape closes it as ever.
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  assert.deepEqual(await closes(page), ['task'], 'Escape on the restored dialog closes it')
  assert.deepEqual(errors, [], 'no page errors')
  await page.close()
}

/** The phone's nested stage: a dialog in it stays up; one beneath it does not. */
const stageCase = async (context) => {
  const { errors, page } = await open(context, 'start=stage')
  await page.getByRole('button', { name: 'Open page dialog' }).click()
  await page.getByRole('dialog', { name: 'Page dialog' }).waitFor()
  assert.ok(await tagDialog(page, 'Page dialog'))

  // The stage is pushed over the page from inside the page's dialog: the page
  // dialog follows its page under the stage.
  await page.getByRole('button', { name: 'Open folder stage' }).click()
  await settled(page, 'stage:fixture-folder')
  await page.locator('[data-phone-navigation-layer="current"] [data-screen="stage"]').waitFor()
  assert.equal(await page.getByRole('dialog', { name: 'Page dialog' }).count(), 0, 'the page dialog is covered by the stage')
  assert.equal((await taggedDialogState(page)).slotHidden, true, 'its slot is hidden')
  await page.screenshot({ path: shot('phone-stage-1-page-dialog-covered.png') })

  // A dialog opened inside the stage belongs to the stage, which is on top.
  await page.getByRole('button', { name: 'Open stage dialog' }).click()
  const stageDialog = page.getByRole('dialog', { name: 'Stage dialog' })
  await stageDialog.waitFor({ state: 'visible' })
  await stageDialog.getByRole('textbox', { name: 'Note' }).fill(TYPED)
  assert.ok(await tagDialog(page, 'Stage dialog'))
  await settled(page)
  assert.equal((await taggedDialogState(page)).slotHidden, false, 'the stage dialog is not covered by its own stage')
  const action = await backAction(page)
  assert.equal(action?.kind, 'owner')
  assert.match(action.id, /^overlay:/, 'the stage dialog owns Back while its stage is on top')
  await page.screenshot({ path: shot('phone-stage-2-stage-dialog-open.png') })

  // A route pushed over the stage takes the stage's dialog with it.
  await stageDialog.getByRole('button', { name: 'Open board settings' }).click()
  await page.waitForURL((url) => url.pathname === SETTINGS_PATH)
  await settled(page, SETTINGS_ROUTE)
  await assertCovered(page, {
    backOwner: 'stage:fixture-folder', closesBefore: [], dialogName: 'Stage dialog', label: 'phone stage',
  })
  await page.screenshot({ path: shot('phone-stage-3-after-push.png') })

  await page.goBack()
  await page.waitForURL((url) => url.pathname.endsWith('/docs'))
  await settled(page, 'stage:fixture-folder')
  await page.locator('[data-phone-navigation-layer="current"] [data-screen="stage"]').waitFor()
  await assertRestored(page, { closesBefore: [], dialogName: 'Stage dialog', field: 'Note', label: 'phone stage', value: TYPED })
  assert.equal(await page.getByRole('dialog', { name: 'Page dialog' }).count(), 0, 'the page dialog stays covered under the stage')
  await page.screenshot({ path: shot('phone-stage-4-after-back.png') })
  assert.deepEqual(errors, [], 'no page errors')
  await page.close()
}

await mkdir(SHOTS, { recursive: true })
const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const desktop = await browser.newContext({ viewport: { height: 900, width: 1440 } })
  await desktop.route('**/api/**', (route) =>
    route.fulfill({ body: '{"error":{"message":"not in fixture"}}', contentType: 'application/json', status: 404 }))
  await boardCase(desktop, { name: 'desktop' })
  await desktop.close()

  const phone = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { height: 812, width: 375 } })
  await phone.route('**/api/**', (route) =>
    route.fulfill({ body: '{"error":{"message":"not in fixture"}}', contentType: 'application/json', status: 404 }))
  await boardCase(phone, { name: 'phone' })
  await stageCase(phone)
  await phone.close()

  console.log(`Overlay layer proofs passed: ${SHOTS}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
