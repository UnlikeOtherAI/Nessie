import assert from 'node:assert/strict'

import { assertNoSidewaysScroll, openPage, posted, settled, shot } from './helpers.mjs'

/**
 * A ticket trigger's own page, the real `TriggerDetailPage`, over the stubs in
 * `fixture.tsx` and `trigger-page.tsx` (docs/standards/ticket-work-machine-access.md):
 *
 * - an owner edits the trigger while its machine access is live: lowering a
 *   limit says nothing, an edited instruction says, above Save, that saving
 *   pauses the author's access; the PUT posts both, and the page it returns
 *   to says the access is paused and its section reads Suspended;
 * - the trigger's author, a member and not an owner, opens the same page read
 *   through its own id: no Run now, Edit, Pause or Delete, a line saying who
 *   can change it, and its Machine access section working as usual.
 */

const TRIGGER = '60000000-0000-4000-8000-000000000021'
const WARNING = /^Saving pauses Ondrej’s machine access until they re-confirm\.$/

/** A header action: in the header's lane where it fits, else in its overflow menu. */
const headerAction = async (page, label) => {
  const button = page.getByRole('button', { exact: true, name: label })
  if (await button.isVisible().catch(() => false)) return button.click()
  await page.getByRole('button', { name: 'More page actions' }).click()
  return page.getByRole('menuitem', { exact: true, name: label }).click()
}

const openTriggerPage = async (browser, options, viewer, access) => {
  const opened = await openPage(browser, options, `page&viewer=${viewer}&access=${access}`)
  const section = opened.page.getByTestId('machine-access-section')
  await section.getByTestId('machine-access-state').waitFor()
  await settled(opened.page)
  return { ...opened, section }
}

const editWarning = async (browser, { name, options }) => {
  const width = options.viewport.width
  const { context, errors, page, section } = await openTriggerPage(browser, options, 'owner', 'live_other')
  await headerAction(page, 'Edit')
  const dialog = page.getByRole('dialog', { name: 'Edit trigger' })
  await dialog.locator('#ticket-instructions-general').waitFor()
  const warning = dialog.getByTestId('machine-access-edit-warning')
  assert.equal(await warning.count(), 0, `${name}: nothing changed yet, nothing to warn about`)

  // Lowering a limit keeps machine access on; raising one does not.
  await dialog.locator('#ticket-trigger-wakes').fill('10')
  assert.equal(await warning.count(), 0, `${name}: a lower limit does not pause it`)
  await dialog.locator('#ticket-trigger-wakes').fill('40')
  assert.match(await warning.innerText(), WARNING, `${name}: a higher limit pauses it`)
  await dialog.locator('#ticket-trigger-wakes').fill('10')
  assert.equal(await warning.count(), 0)

  await dialog.locator('#ticket-instructions-general').fill('Triage every ticket, then comment a plan and a test.')
  assert.match(await warning.innerText(), WARNING, `${name}: an edited instruction pauses it`)
  await warning.scrollIntoViewIfNeeded()
  await assertNoSidewaysScroll(page, `${name} edit warning`)
  await settled(page)
  await page.screenshot({ path: shot('machine-access-edit-warning', width) })

  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await dialog.waitFor({ state: 'detached' })
  const saves = (await posted(page)).filter((entry) => entry.path === `/api/triggers/${TRIGGER}`)
  assert.equal(saves.length, 1, `${name}: one PUT`)
  assert.equal(saves[0].body.config.instructions.general, 'Triage every ticket, then comment a plan and a test.')
  assert.equal(saves[0].body.config.limits.wakesPerTicket, 10)

  const notice = page.getByTestId('trigger-saved-machine-access')
  await notice.waitFor()
  assert.equal(await notice.innerText(),
    'Saved. Ondrej’s machine access is paused until they confirm it again; tickets being worked wait for it.')
  await section.getByText('Suspended', { exact: true }).waitFor()
  assert.match(await section.getByTestId('machine-access-state').innerText(), /^Paused because the trigger was edited/)
  await assertNoSidewaysScroll(page, `${name} saved`)
  await settled(page)
  await page.screenshot({ path: shot('machine-access-edit-saved', width) })
  assert.deepEqual(errors, [], `${name} edit: no page errors`)
  await context.close()
}

const authorPage = async (browser, { name, options }) => {
  const width = options.viewport.width
  const { context, errors, page, section } = await openTriggerPage(browser, options, 'author', 'live')
  await page.getByText('When a person moves a ticket into In progress', { exact: false }).waitFor()
  for (const label of ['Run now', 'Edit', 'Pause', 'Delete trigger', 'More page actions']) {
    assert.equal(await page.getByRole('button', { exact: true, name: label }).count(), 0, `${name}: no ${label}`)
  }
  assert.equal(await page.getByTestId('trigger-read-only').innerText(),
    'Only an organisation owner can change this trigger. You can set up its machine access below.')
  // The section is the author's own: machines named, and theirs to change or end.
  assert.match(await section.getByTestId('machine-access-state').innerText(), /starts work on Minis and Studio, as Ondrej\.$/)
  assert.equal(await section.getByRole('button', { name: 'Change machine access…' }).count(), 1)
  assert.equal(await section.getByRole('button', { name: 'End' }).count(), 1)
  // Every delivery of the fixture's history, T5's machine and session ones among them.
  assert.equal(await page.getByTestId('ticket-delivery-line').count(), 9, `${name}: the deliveries, read as the author`)
  await assertNoSidewaysScroll(page, `${name} author page`)
  await settled(page)
  await page.screenshot({ fullPage: true, path: shot('trigger-page-author', width) })
  assert.deepEqual(errors, [], `${name} author page: no page errors`)
  await context.close()
}

export const triggerPage = async (browser, viewport) => {
  await editWarning(browser, viewport)
  await authorPage(browser, viewport)
}
