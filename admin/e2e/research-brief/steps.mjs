import assert from 'node:assert/strict'

/**
 * The research-brief suite's longer walks, kept beside `run.mjs` so each file
 * reads as one story: what the thread shows, what the person's brief shows,
 * the brief from a one-tap answer to a started research, and a new brief from
 * the composer.
 */

const RUN = {
  agentDraft: '50000000-0000-4000-8000-000000000002',
  created: '50000000-0000-4000-8000-000000000010',
  done: '50000000-0000-4000-8000-000000000003',
  draft: '50000000-0000-4000-8000-000000000001',
  failed: '50000000-0000-4000-8000-000000000005',
  hidden: '50000000-0000-4000-8000-000000000009',
  running: '50000000-0000-4000-8000-000000000006',
  summary: '50000000-0000-4000-8000-000000000004',
}

const card = (page, id) => page.locator(`[data-card="${id}"]`)

const lastPost = (page, suffix) => page.evaluate((end) =>
  window.__research.calls.filter((call) => call.method === 'POST' && call.path.endsWith(end)).at(-1), suffix)

export const assertThreadCards = async (page) => {
  await card(page, RUN.draft).getByText('You’re agreeing the brief with DeepWater.').waitFor()
  await card(page, RUN.draft).getByRole('button', { name: 'Continue the brief' }).waitFor()
  await card(page, RUN.agentDraft).getByText('An agent is agreeing the brief with DeepWater.').waitFor()
  await card(page, RUN.running).getByText('The result will come back to this conversation.', { exact: false }).waitFor()

  const done = card(page, RUN.done)
  await done.getByText('Finished with 48 sources.').waitFor()
  for (const name of ['Download report (.md)', 'Download sources (.csv)', 'Copy markdown']) {
    await done.getByRole('button', { name }).waitFor()
  }
  const publicLink = done.getByRole('link', { name: 'Open on research.deepwater.live' })
  assert.equal(await publicLink.getAttribute('href'),
    'https://research.deepwater.live/heat-pumps-in-victorian-terraces-5a3c9f10')
  assert.equal(await publicLink.getAttribute('target'), '_blank')

  // A summary is labelled a summary everywhere (amendments N10).
  const summary = card(page, RUN.summary)
  await summary.getByText('Research summary (the full report could not be written).').waitFor()
  await summary.getByRole('button', { name: 'Download summary (.md)' }).waitFor()
  await summary.getByRole('link', { name: 'Open the research summary in Documents' }).waitFor()
  assert.equal(await summary.getByRole('link', { name: 'Open on research.deepwater.live' }).count(), 0)

  await card(page, RUN.failed).getByRole('button', { name: 'Start again' }).waitFor()
  await card(page, RUN.hidden).getByText('A research you can’t see.').waitFor()

  // The result reply's own actions: the same artifacts, read live from the run.
  const notice = page.locator(`[data-notice="${RUN.done}"]`)
  await notice.getByTestId('research-notice-actions').getByRole('button', { name: 'Copy markdown' }).waitFor()
}

export const assertBrief = async (page) => {
  const dialog = page.getByTestId('research-brief-dialog')
  await dialog.getByTestId('research-brief-workspace').waitFor()
  const conversation = dialog.getByTestId('research-brief-conversation')
  await conversation.getByText('which country should I focus on?', { exact: false }).waitFor()
  await dialog.getByTestId('research-brief-questions').getByRole('button', { name: 'The UK' }).waitFor()
  assert.equal(await dialog.getByTestId('research-brief-pillars').getByRole('textbox').count(), 3)

  // The seven settings, with the person's own choice locked.
  const settings = dialog.getByTestId('research-brief-settings')
  for (const label of ['How thorough', 'Chapter detail', 'Source search', 'Source languages', 'Report language',
    'Sources from', 'Writing style']) {
    await settings.getByText(label, { exact: true }).first().waitFor()
  }
  await settings.locator('[data-setting="outputLanguage"]').getByTestId('research-setting-locked').waitFor()
  assert.match(await dialog.getByTestId('research-suggested-depth').innerText(), /Suggested depth: Deep/)

  const publish = dialog.getByRole('switch', { name: 'Publish on research.deepwater.live' })
  assert.equal(await publish.getAttribute('aria-checked'), 'false', 'a research is private until the person says')
  return dialog
}

export const walkBriefToStart = async (page, dialog, snap) => {
  // Unsent edits: a setting and a pillar, kept locally while the person decides.
  const settings = dialog.getByTestId('research-brief-settings')
  await settings.getByRole('combobox', { name: 'Sources from' }).selectOption('year')
  await settings.locator('[data-setting="recency"]').getByText('Not sent yet', { exact: false }).waitFor()
  await dialog.getByRole('textbox', { name: 'Pillar 3' }).fill('Installation, disruption and noise')

  // A one-tap answer carries them, against the revision the person saw.
  await dialog.getByTestId('research-brief-questions').getByRole('button', { name: 'The UK' }).click()
  await dialog.getByTestId('research-brief-replying').waitFor()
  const reply = await lastPost(page, `${RUN.draft}/messages`)
  assert.equal(reply.body.message, 'Which country should the research focus on?\nThe UK')
  assert.equal(reply.body.baseRevision, 2)
  assert.deepEqual(reply.body.settings, { recency: 'year' })
  assert.deepEqual(reply.body.pillars,
    ['Costs and grants', 'Performance in solid-wall houses', 'Installation, disruption and noise'])
  assert.match(await dialog.getByTestId('research-brief-replying').innerText(), /is replying…\s*\d+s/)
  // What was sent stays on screen while DeepWater applies it, and is no longer "not sent".
  assert.equal(await dialog.getByRole('textbox', { name: 'Pillar 3' }).inputValue(), 'Installation, disruption and noise')
  assert.equal(await settings.getByRole('combobox', { name: 'Sources from' }).inputValue(), 'year')
  assert.equal(await dialog.getByText('Not sent yet', { exact: false }).count(), 0)
  await snap(page, '03-brief-replying.png')

  // DeepWater's planner answers; the realtime refetch shows it.
  await page.evaluate((id) => window.__research.plannerAnswers(id), RUN.draft)
  await dialog.getByText('I’ll focus on the UK', { exact: false }).waitFor()
  await dialog.getByText('DeepWater thinks this brief is ready.').waitFor()
  assert.equal(await dialog.getByTestId('research-brief-pillars').getByRole('textbox').count(), 4)
  assert.equal(await dialog.getByRole('textbox', { name: 'Pillar 3' }).inputValue(), 'Installation, disruption and noise')
  await settings.locator('[data-setting="recency"]').getByTestId('research-setting-locked').waitFor()
  await snap(page, '04-brief-answered.png')

  // A revision conflict at Start: the person's edit stays on top, and they are told what changed (F8).
  await dialog.getByTestId('research-brief-settings').getByRole('radio', { name: 'Light' }).click()
  await page.evaluate(() => window.__research.conflictNext())
  await dialog.getByRole('button', { name: 'Start research' }).click()
  await dialog.getByText('While you were editing, DeepWater changed how thorough.', { exact: false }).waitFor()
  await snap(page, '05-brief-rebased.png')

  // Start, published: the launch carries the current revision, the kept edit and the person's choice.
  await dialog.getByRole('switch', { name: 'Publish on research.deepwater.live' }).click()
  await dialog.getByRole('button', { name: 'Start research' }).click()
  const start = await lastPost(page, `${RUN.draft}/start`)
  // 2, then the reply's edit (3) and the planner's turn (4), then the conflict (5).
  assert.equal(start.body.revision, 5)
  assert.deepEqual(start.body.settings, { depth: 'light' })
  assert.equal(start.body.public, true)
  await page.evaluate((id) => window.__research.launched(id), RUN.draft)
  await dialog.getByText('DeepWater is researching. The result will come back to this conversation.').waitFor()
  await snap(page, '06-brief-started.png')
}

export const walkNewBrief = async (page, snap) => {
  await page.getByTestId('composer-research-button').click()
  const form = page.getByTestId('research-brief-new')
  const topic = form.getByRole('textbox').first()
  assert.equal(await topic.inputValue(), 'Could we look into heat pumps for the Leeds office before winter?')
  await form.getByRole('textbox').nth(1).fill('We rent the building; the landlord pays for changes.')
  await snap(page, '07-new-brief.png')
  await form.getByRole('button', { name: 'Plan with DeepWater' }).click()
  await page.getByTestId('research-brief-replying').waitFor()
  const created = await page.evaluate(() => window.__research.calls.find((call) =>
    call.method === 'POST' && call.path === '/api/integrations/products/deep-water/research-runs'))
  assert.deepEqual(created.body.origin, {
    channelId: '40000000-0000-4000-8000-000000000001',
    kind: 'thread',
    threadId: '40000000-0000-4000-8000-000000000002',
  })
  assert.equal(created.body.context, 'We rent the building; the landlord pays for changes.')
  assert.match(created.body.actionId, /^[0-9a-f-]{36}$/)
  await snap(page, '08-new-brief-replying.png')
}

/** A brief started from a reply thread's composer comes back under that thread's root. */
export const walkReplyThreadBrief = async (page) => {
  await page.getByTestId('reply-research-button').click()
  const form = page.getByTestId('research-brief-new')
  assert.equal(await form.getByRole('textbox').first().inputValue(), 'Compare the three quotes we got')
  await form.getByRole('button', { name: 'Plan with DeepWater' }).click()
  await page.getByTestId('research-brief-replying').waitFor()
  const created = await page.evaluate(() => window.__research.calls.find((call) =>
    call.method === 'POST' && call.path === '/api/integrations/products/deep-water/research-runs'))
  assert.deepEqual(created.body.origin, {
    channelId: '40000000-0000-4000-8000-000000000001',
    kind: 'thread',
    rootMessageId: '60000000-0000-4000-8000-000000000099',
    threadId: '40000000-0000-4000-8000-000000000002',
  })
}

/** A failed research started from a reply thread starts again under that thread, with its question. */
export const walkStartAgain = async (page) => {
  await card(page, RUN.failed).getByRole('button', { name: 'Start again' }).click()
  const form = page.getByTestId('research-brief-new')
  assert.equal(await form.getByRole('textbox').first().inputValue(), 'Noise from air-source heat pumps in terraces')
  await form.getByRole('button', { name: 'Plan with DeepWater' }).click()
  await page.getByTestId('research-brief-replying').waitFor()
  const created = await page.evaluate(() => window.__research.calls.find((call) =>
    call.method === 'POST' && call.path === '/api/integrations/products/deep-water/research-runs'))
  assert.deepEqual(created.body.origin, {
    channelId: '40000000-0000-4000-8000-000000000001',
    kind: 'thread',
    rootMessageId: '60000000-0000-4000-8000-000000000098',
    threadId: '40000000-0000-4000-8000-000000000002',
  })
}

/** A composer over another conversation (a DM drawer, a Threads inbox card) names it; the brief comes back there. */
export const walkBriefElsewhere = async (page) => {
  await page.getByTestId('elsewhere-research-button').click()
  const form = page.getByTestId('research-brief-new')
  assert.equal(await form.getByRole('textbox').first().inputValue(), 'What do tenants pay to heat a flat?')
  await form.getByRole('button', { name: 'Plan with DeepWater' }).click()
  await page.getByTestId('research-brief-replying').waitFor()
  const created = await page.evaluate(() => window.__research.calls.find((call) =>
    call.method === 'POST' && call.path === '/api/integrations/products/deep-water/research-runs'))
  assert.deepEqual(created.body.origin, {
    channelId: '40000000-0000-4000-8000-000000000003',
    kind: 'thread',
    rootMessageId: '60000000-0000-4000-8000-000000000099',
    threadId: '40000000-0000-4000-8000-000000000004',
  })
}

/**
 * A reply DeepWater's planner could not answer (amendments N2): DeepWater
 * writes no transcript row for it and the action clears without an error, yet
 * the person's words come back into the box, and Send again sends those words —
 * never the question, never an earlier reply.
 */
export const walkFailedReply = async (page, snap) => {
  const dialog = page.getByTestId('research-brief-dialog')
  await dialog.getByTestId('research-brief-workspace').waitFor()
  const box = dialog.getByRole('textbox', { name: /^Reply to / })
  const words = 'Only houses built before 1919, please.'
  await box.fill(words)
  await dialog.getByTestId('research-brief-conversation').getByRole('button', { name: 'Send', exact: true }).click()
  await dialog.getByTestId('research-brief-replying').waitFor()
  assert.equal(await box.inputValue(), '', 'a sent reply leaves the box')

  await page.evaluate((id) => window.__research.plannerFails(id), RUN.draft)
  await dialog.getByText('stopped responding before it answered', { exact: false }).waitFor()
  await page.waitForFunction((expected) =>
    document.querySelector('[aria-label^="Reply to "]')?.value === expected, words)
  await snap(page, '10-brief-reply-failed.png')

  await dialog.getByRole('button', { name: 'Send again' }).click()
  const resend = await lastPost(page, `${RUN.draft}/messages`)
  assert.equal(resend.body.message, words)
  await dialog.getByTestId('research-brief-replying').waitFor()
  assert.equal(await box.inputValue(), '', 'the resent words leave the box again')
}

/** Knowledge › Research pages forwards on the server, and Previous walks back along the address. */
export const walkResearchPages = async (page) => {
  const list = page.getByTestId('research-list')
  const rows = list.locator('[data-research-run]')
  await rows.first().waitFor()
  assert.equal(await rows.count(), 10)
  const firstId = await rows.first().getAttribute('data-research-run')
  assert.equal(await page.getByRole('button', { name: 'Previous page' }).isDisabled(), true)
  await page.getByRole('button', { name: 'Next page' }).click()
  // The second page holds the rest: the oldest research, and none of the first page.
  await list.getByText('Older research 8', { exact: true }).waitFor()
  assert.equal(await list.locator(`[data-research-run="${firstId}"]`).count(), 0)
  assert.ok(await rows.count() < 10)
  await page.getByRole('button', { name: 'Previous page' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-research-run]').length === 10)
  assert.equal(await rows.first().getAttribute('data-research-run'), firstId, 'back on the first page')
  assert.equal(await page.getByRole('button', { name: 'Previous page' }).isDisabled(), true)
}
