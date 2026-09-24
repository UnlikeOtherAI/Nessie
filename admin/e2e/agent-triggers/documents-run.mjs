import assert from 'node:assert/strict'

import {
  assertNoSidewaysScroll,
  fixtureState,
  openDialog,
  openPage,
  posted,
  settled,
  shot,
} from './helpers.mjs'

/**
 * The document-trigger half of the agent-triggers runner
 * (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "Finder and
 * project docs", triggers.md → "`document_changed`"), over `documents.tsx`.
 *
 * It pins, at both widths:
 * - the form: public project channels only and why, the project's own
 *   Documents space chosen, a space no public channel may watch shown and not
 *   offered, folders by path, a server refusal landing **on the space field**,
 *   and the exact typed config a corrected create posts;
 * - a document trigger's page: its space, folder and labels by name, no
 *   schedule, and each delivery in words (reviewed in the document's thread,
 *   woke the ticket's work, a skip's sentence);
 * - the project's Documents: "Reviewed by CTO · v5" on a reviewed row and "Sent
 *   to CTO for review · v2" on one whose review has not run yet, from
 *   one Finder read for the listed folder (plus one for the space's own
 *   answer) — never one per row; the badge leading to the review thread only
 *   where the viewer may open it; "Tell an agent when this changes…" on a
 *   folder and a document, never on a spreadsheet, and absent for a viewer the
 *   Triggers routes refuse; and the editor it opens, prefilled with its type
 *   fixed.
 */

const AGENT_ID = '60000000-0000-4000-8000-000000000001'
const CHANNEL_ID = '60000000-0000-4000-8000-000000000002'
const DOCS_SPACE = '60000000-0000-4000-8000-000000000501'
const SPECS = '60000000-0000-4000-8000-000000000511'
const ARCHITECTURE = '60000000-0000-4000-8000-000000000513'
const RELEASE_NOTES = '60000000-0000-4000-8000-000000000514'
const ROADMAP = '60000000-0000-4000-8000-000000000515'
const BUDGET = '60000000-0000-4000-8000-000000000516'
const REVIEW_THREAD = '60000000-0000-4000-8000-000000000530'
const TELL = 'Tell an agent when this changes…'
const INSTRUCTIONS = 'Read the change and say in the thread whether the spec still holds.'

const optionTexts = (select) =>
  select.locator('option').evaluateAll((nodes) => nodes.map((node) => [node.textContent, node.disabled]))

/** 5. A document trigger: its form, a refusal on the space field, then the typed create. */
export const documentForm = async (browser, { name, options }) => {
  const width = options.viewport.width
  const { context, dialog, errors, page } = await openDialog(browser, options, 'document')
  await dialog.getByText('Document change', { exact: true }).click()
  assert.deepEqual(
    (await optionTexts(dialog.locator('#trigger-channel'))).map(([text]) => text),
    ['engineering'],
    `${name}: only the public project channel is offered`,
  )
  await dialog.getByText(/the agent reviews each change in a thread here/).waitFor()
  const space = dialog.locator('#document-trigger-space')
  await space.locator('option', { hasText: 'Research' }).waitFor({ state: 'attached' })
  assert.equal(await space.inputValue(), DOCS_SPACE, `${name}: the project's own Documents space is chosen`)
  assert.deepEqual(await optionTexts(space), [
    ['Engineering docs', false],
    ['Leadership — is readable by its team only', true],
    ['Research', false],
  ], `${name}: a space no public channel may watch is shown, and not offered`)
  const folder = dialog.locator('#document-trigger-folder')
  await folder.locator('option', { hasText: 'Specs / API' }).waitFor({ state: 'attached' })
  assert.deepEqual((await optionTexts(folder)).map(([text]) => text), ['The whole space', 'Specs', 'Specs / API'])
  await dialog.getByText('Also wake on another agent’s saves').waitFor()
  await space.scrollIntoViewIfNeeded()
  await settled(page)
  await page.screenshot({ path: shot('document-form', width) })

  // The server refuses a space the agent cannot read, on the space field.
  await dialog.getByLabel('Trigger name').fill('Review spec changes')
  await space.selectOption({ label: 'Research' })
  await dialog.locator('#document-trigger-instructions').fill(INSTRUCTIONS)
  await dialog.getByRole('button', { name: 'Create trigger', exact: true }).click()
  const refusal = dialog.locator('[data-field-error="spaceId"]')
  await refusal.waitFor()
  assert.match(await refusal.innerText(), /CTO cannot read space Research/)
  await dialog.getByText('Fix the fields marked below.').waitFor()
  await space.scrollIntoViewIfNeeded()
  await settled(page)
  await assertNoSidewaysScroll(page, `${name} document refused`)
  await page.screenshot({ path: shot('document-refused', width) })

  // Fixed where it was refused, narrowed to a folder and a label, and created as the typed config.
  await space.selectOption({ label: 'Engineering docs' })
  await folder.locator('option', { hasText: 'Specs / API' }).waitFor({ state: 'attached' })
  await folder.selectOption({ label: 'Specs' })
  await dialog.locator('#document-trigger-labels').fill('spec')
  await page.getByRole('option', { exact: true, name: 'spec' }).click()
  // Escape closes the label list, and only the list: the editor stays open.
  await dialog.locator('#document-trigger-labels').press('Escape')
  await page.getByRole('option', { exact: true, name: 'spec' }).waitFor({ state: 'detached' })
  assert.equal(await dialog.isVisible(), true, `${name}: Escape in the label list keeps the editor open`)
  await dialog.locator('#document-trigger-quiet').fill('300')
  await dialog.getByText('5 min after the first save.', { exact: false }).waitFor()
  // The lower half: the label as a token, what wakes the agent, the window and the instructions.
  // Scrolled inside the editor's own form only, so the dialog keeps its header.
  await dialog.locator('label[for="document-trigger-labels"]').evaluate((node) => {
    const form = node.closest('form')
    form.scrollTop += node.getBoundingClientRect().top - form.getBoundingClientRect().top - 8
  })
  await settled(page)
  await page.screenshot({ path: shot('document-form-filled', width) })
  await dialog.getByRole('button', { name: 'Create trigger', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  const creates = await posted(page)
  assert.equal(creates.length, 2, 'one refused create, one accepted')
  const { body, path } = creates[1]
  assert.equal(path, `/api/agents/${AGENT_ID}/triggers`)
  assert.equal(body.type, 'document_changed')
  assert.equal(body.targetChannelId, CHANNEL_ID, 'the public channel, never the protected one')
  assert.equal(body.nextRunAt, undefined, 'a document trigger has no schedule')
  assert.deepEqual(body.config, {
    fireOn: 'save',
    folderPageId: SPECS,
    includeAgentEdits: false,
    instructions: { general: INSTRUCTIONS },
    kinds: ['document', 'file'],
    labels: ['spec'],
    quietSeconds: 300,
    spaceId: DOCS_SPACE,
  })
  assert.deepEqual(errors, [], `${name}: no page errors`)
  await context.close()
}

/** 6. A document trigger's own page: named facts, and deliveries that say what they decided. */
export const documentDetail = async (browser, { name, options }) => {
  const width = options.viewport.width
  const { context, errors, page } = await openPage(browser, options, 'document-detail')
  await page.getByText('Engineering docs', { exact: true }).waitFor()
  await page.getByText('Specs', { exact: true }).waitFor()
  await page.getByText('Only pages labelled spec', { exact: true }).waitFor()
  await page.getByText('5 min after the first save, once for every change in that window').waitFor()
  assert.equal(await page.getByText('Schedule', { exact: true }).count(), 0, `${name}: no schedule fact`)
  const lines = page.getByTestId('document-delivery-line')
  await lines.first().waitFor()
  assert.deepEqual(await lines.allInnerTexts(), [
    'Woke the agent to review v6 → v7 (3 saves) in the document’s thread.',
    'Woke the ticket’s work to review v5 → v6.',
    'Only agents saved this document — the agent itself, another reviewer, or another agent '
      + 'while agent edits are left out — so nobody was woken.',
  ])
  await assertNoSidewaysScroll(page, `${name} document detail`)
  await settled(page)
  await page.screenshot({ fullPage: true, path: shot('document-detail', width) })
  assert.deepEqual(errors, [], `${name}: no page errors`)
  await context.close()
}

const row = (page, id) => page.locator(`[data-finder-row="${id}"]`)

/** The labels of the menu a right-click on this row opens, then the menu closed again. */
const menuOn = async (page, id) => {
  await row(page, id).click({ button: 'right' })
  const menu = page.getByRole('menu')
  await menu.waitFor()
  const labels = await menu.getByRole('menuitem').allInnerTexts()
  return { close: async () => {
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
  }, labels: labels.map((label) => label.trim()), menu }
}

/** 7. The project's Documents: review badges from one read, and the doorway that opens the editor. */
export const documentsFinder = async (browser, { name, options }) => {
  const width = options.viewport.width
  const { context, errors, page } = await openPage(browser, options, 'docs')
  const badges = page.getByTestId('document-review-badge')
  await badges.nth(1).waitFor()
  assert.deepEqual(await badges.allInnerTexts(), ['Reviewed by CTO · v5', 'Sent to CTO for review · v2'])
  assert.equal(await row(page, ARCHITECTURE).getByTestId('document-review-badge').getAttribute('data-review-thread'),
    REVIEW_THREAD, `${name}: a review the viewer may open leads to its thread`)
  assert.equal(await row(page, RELEASE_NOTES).getByTestId('document-review-badge').getAttribute('data-review-thread'),
    null, `${name}: a review the viewer may not open is text`)
  const reads = [...(await fixtureState(page)).reads].sort()
  assert.deepEqual(reads, [
    `${DOCS_SPACE}?`,
    `${DOCS_SPACE}?${[ARCHITECTURE, RELEASE_NOTES, ROADMAP].sort().join(',')}`,
  ], `${name}: one read for the listed folder's documents and files, and one for the space — none per row`)
  await settled(page)
  await assertNoSidewaysScroll(page, `${name} docs`)
  await page.screenshot({ path: shot('docs-badges', width) })

  // The doorway is on a folder and a document, never a spreadsheet; a review
  // the viewer may open is one menu item away for a keyboard too.
  const architecture = await menuOn(page, ARCHITECTURE)
  assert.ok(architecture.labels.includes('Open review thread'), `${name}: ${architecture.labels}`)
  assert.ok(architecture.labels.includes(TELL))
  await settled(page)
  await page.screenshot({ path: shot('docs-menu-reviewed', width) })
  await architecture.close()
  const notes = await menuOn(page, RELEASE_NOTES)
  assert.ok(notes.labels.includes(TELL) && !notes.labels.includes('Open review thread'), `${name}: ${notes.labels}`)
  await notes.close()
  const budget = await menuOn(page, BUDGET)
  assert.ok(!budget.labels.includes(TELL), `${name}: a spreadsheet offers no document trigger`)
  await budget.close()

  const specs = await menuOn(page, SPECS)
  assert.ok(specs.labels.includes(TELL), `${name}: ${specs.labels}`)
  await settled(page)
  await page.screenshot({ path: shot('docs-menu', width) })
  await specs.menu.getByRole('menuitem', { name: TELL }).click()
  const dialog = page.getByRole('dialog', { name: 'Create a trigger' })
  await dialog.waitFor()
  await dialog.locator('#document-trigger-folder option', { hasText: 'Specs / API' }).waitFor({ state: 'attached' })
  await settled(page)
  assert.equal(await dialog.locator('input[type="radio"]').count(), 0, 'no type picker from the Finder')
  assert.match(await dialog.innerText(), /Trigger type\s+Document change/i)
  assert.match(await dialog.innerText(), /Target kind\s+Agent/i)
  assert.equal(await dialog.getByLabel('Trigger name').inputValue(), 'Review changes in Specs')
  assert.equal(await dialog.locator('#trigger-channel').inputValue(), CHANNEL_ID)
  assert.equal(await dialog.locator('#document-trigger-space').inputValue(), DOCS_SPACE)
  assert.equal(await dialog.locator('#document-trigger-folder').inputValue(), SPECS)
  await assertNoSidewaysScroll(page, `${name} docs doorway`)
  await page.screenshot({ path: shot('docs-doorway', width) })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })

  // The badge's own way in: the review thread, where the viewer may open it.
  await row(page, ARCHITECTURE).getByTestId('document-review-badge').click()
  await page.waitForFunction(
    (thread) => window.__agentTriggersFixture.location?.endsWith(`/threads/${thread}`),
    REVIEW_THREAD,
  )
  assert.deepEqual(errors, [], `${name}: no page errors`)
  await context.close()

  if (name !== 'desktop') return
  // The list view (a split affordance) badges its rows from its own one read.
  const list = await openPage(browser, options, 'docs&view=list')
  await list.page.locator('.finder-grid-row[data-finder-row]').first().waitFor()
  await list.page.getByTestId('document-review-badge').nth(1).waitFor()
  assert.deepEqual(await list.page.getByTestId('document-review-badge').allInnerTexts(),
    ['Reviewed by CTO · v5', 'Sent to CTO for review · v2'])
  assert.equal((await fixtureState(list.page)).reads.filter((read) => !read.endsWith('?')).length, 1,
    'one read for the listed folder')
  await settled(list.page)
  await list.page.screenshot({ path: shot('docs-list', width) })
  assert.deepEqual(list.errors, [], 'no page errors')
  await list.context.close()

  // A viewer the Triggers routes refuse sees the badges and no doorway.
  const refused = await openPage(browser, options, 'docs&owner=0')
  await refused.page.getByTestId('document-review-badge').nth(1).waitFor()
  const folderMenu = await menuOn(refused.page, SPECS)
  assert.ok(!folderMenu.labels.includes(TELL), `a viewer who may not create triggers is not offered one: ${folderMenu.labels}`)
  await folderMenu.close()
  assert.deepEqual(refused.errors, [], 'no page errors')
  await refused.context.close()
}
