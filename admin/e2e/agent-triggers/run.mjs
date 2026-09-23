import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * The Triggers editor, rendered (docs/plans/2026-09-23-ticket-driven-agents/
 * verification.md). A pure fixture over a stubbed ApiClient: the real
 * `TriggerEditorDialog` and `TriggerTypePicker`, no database.
 *
 * What it pins today is the T0 truth (docs/standards/ticket-work.md →
 * "Nothing is half-exposed"): `ticket_changed` and `document_changed` are in
 * the API's trigger-type enum, but nothing may create one yet, so the picker
 * offers exactly the five released types — in that order — and names neither
 * new one anywhere in the dialog. A create still posts the type that was
 * picked. T1 releases `ticket_changed` and extends this suite over each of its
 * configuration states. Both widths are screenshotted under
 * e2e/screenshots/agent-triggers/.
 */

const SHOTS = resolve(REPO_ROOT, 'e2e/screenshots/agent-triggers')
const RELEASED = ['manual', 'scheduled', 'interval', 'webhook', 'event']
const RELEASED_LABELS = ['Manual', 'Schedule', 'Interval', 'Webhook', 'Event']
const UNRELEASED = /ticket_changed|document_changed|ticket change|document change/i
const VIEWPORTS = [
  { name: 'desktop', options: { viewport: { height: 800, width: 1280 } } },
  { name: 'phone', options: { hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } } },
]

const openDialog = async (browser, options) => {
  const context = await browser.newContext(options)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${ADMIN_URL}/e2e/agent-triggers/index.html`)
  const dialog = page.getByRole('dialog', { name: 'Create a trigger' })
  await dialog.waitFor()
  // Screenshot it once its open motion has played out, not mid-fade.
  await dialog.evaluate((panel) => Promise.all(panel.getAnimations().map((animation) => animation.finished)))
  return { context, dialog, errors, page }
}

const assertOffersOnlyReleasedTypes = async (dialog, label) => {
  const picker = dialog.getByRole('group', { name: 'Trigger type' })
  await picker.waitFor()
  const radios = picker.locator('input[type="radio"]')
  assert.deepEqual(
    await radios.evaluateAll((nodes) => nodes.map((node) => node.value)),
    RELEASED,
    `${label}: the picker offers the five released types, in order`,
  )
  for (const text of RELEASED_LABELS) {
    assert.ok(
      await picker.getByText(text, { exact: true }).isVisible(),
      `${label}: "${text}" is shown`,
    )
  }
  // The markup, not just the painted text: a hidden option or an attribute
  // naming either type would be the half-exposure this suite exists to catch.
  assert.doesNotMatch(await dialog.evaluate((node) => node.outerHTML), UNRELEASED,
    `${label}: neither unreleased type is named anywhere in the dialog`)
  assert.equal(await radios.nth(0).isChecked(), true, `${label}: a new trigger starts as manual`)
}

const admin = await startAdmin()
const browser = await launchBrowser()
try {
  await mkdir(SHOTS, { recursive: true })

  for (const { name, options } of VIEWPORTS) {
    const { context, dialog, errors, page } = await openDialog(browser, options)
    await assertOffersOnlyReleasedTypes(dialog, name)
    const { inner, scroll } = await page.evaluate(() => ({
      inner: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
    }))
    assert.ok(scroll <= inner, `${name}: the page scrolls sideways (${scroll} > ${inner})`)
    const width = options.viewport.width
    await page.screenshot({ path: resolve(SHOTS, `create-${width}.png`) })

    // The picker still posts what was picked, through the create the Triggers
    // page uses; the stub answers it and records the body.
    if (name === 'desktop') {
      await dialog.getByLabel('Trigger name').fill('Check the board')
      await dialog.getByText('Webhook', { exact: true }).click()
      assert.equal(await dialog.locator('input[type="radio"][value="webhook"]').isChecked(), true)
      await dialog.getByRole('button', { name: 'Create trigger', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      const posted = await page.evaluate(() => window.__agentTriggersFixture.posted)
      assert.equal(posted.length, 1, 'one create was posted')
      assert.equal(posted[0].path, '/api/agents/60000000-0000-4000-8000-000000000001/triggers')
      assert.equal(posted[0].body.type, 'webhook')
      assert.equal(posted[0].body.name, 'Check the board')
      assert.equal(posted[0].body.targetChannelId, '60000000-0000-4000-8000-000000000002')
    }

    assert.deepEqual(errors, [], `${name}: no page errors`)
    await context.close()
  }

  console.log(`Agent triggers proofs passed; screenshots: ${SHOTS}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
