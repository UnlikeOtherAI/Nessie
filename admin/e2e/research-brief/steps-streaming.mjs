import assert from 'node:assert/strict'

/**
 * DeepWater's research events reaching the admin (Water plan
 * amendments-streaming S2): a running research's card moves with every
 * progress push — its phase in Nessie's words, DeepWater's note, a bar while
 * the step is countable, the sources found and the time so far — and the brief
 * dialog stops saying the planner is replying the moment its turn lands. Every
 * change arrives as an `integration.run.updated` frame read by the shell's own
 * frame reader; between two frames the admin asks the server nothing.
 */

const RUNNING = '50000000-0000-4000-8000-000000000006'
const DRAFT = '50000000-0000-4000-8000-000000000001'

const card = (page, id) => page.locator(`[data-card="${id}"]`)

const callCount = (page) => page.evaluate(() => window.__research.calls.length)

const callsSince = (page, from) => page.evaluate((start) => window.__research.calls.slice(start), from)

/** Long enough for any polling loop to show itself, with nothing pushed meanwhile. */
const QUIET_MS = 3_000

/** Nothing is fetched while nothing is pushed: the clock ticks, the network does not. */
const assertNoPolling = async (page, what) => {
  const before = await callCount(page)
  await page.waitForTimeout(QUIET_MS)
  assert.deepEqual(await callsSince(page, before), [], `no request between two frames (${what})`)
}

const push = (page, progress) => page.evaluate(({ id, snapshot }) => {
  window.__research.progresses(id, snapshot)
}, { id: RUNNING, snapshot: progress })

export const walkStreamingResearch = async (page, snap) => {
  const running = card(page, RUNNING)
  await running.getByText('The result will come back to this conversation.', { exact: false }).waitFor()
  // Before DeepWater has said anything, the card has only how long it has run.
  const facts = running.getByTestId('research-progress-facts')
  await facts.getByText(/^Running for \d/).waitFor()
  assert.equal(await running.getByRole('progressbar').count(), 0)
  const firstTick = await facts.innerText()
  await assertNoPolling(page, 'before the first push')
  assert.notEqual(await facts.innerText(), firstTick, 'the clock ticks without a request')

  // Reading sources, 40% of the step, 23 sources.
  let before = await callCount(page)
  await push(page, {
    at: new Date().toISOString(),
    note: 'Finding and reading sources',
    percent: 40,
    phase: 'gathering',
    sourcesFound: 23,
  })
  const progress = running.getByTestId('research-progress')
  await progress.getByText('Step 2 of 5: Reading sources').waitFor()
  await progress.getByText('Finding and reading sources').waitFor()
  await progress.getByText(/^23 sources found · Running for /).waitFor()
  assert.equal(await progress.getByRole('progressbar').getAttribute('aria-valuenow'), '40')
  assert.equal(await progress.getAttribute('data-phase'), 'gathering')
  const refetched = await callsSince(page, before)
  assert.ok(refetched.length > 0 && refetched.every((call) => call.method === 'GET'),
    'the frame is answered by the viewer\'s own reads, and only by them')
  assert.ok(refetched.some((call) => call.path.endsWith(`/research-runs/${RUNNING}`)), 'the card re-read its run')
  await snap(page, '23-streaming-gathering.png')
  await assertNoPolling(page, 'between two pushes')

  // A step that is not countable: no bar, the phase and DeepWater's words only.
  await push(page, {
    at: new Date().toISOString(),
    note: 'Checking the summary against its sources',
    percent: null,
    phase: 'verifying',
    sourcesFound: 31,
  })
  await progress.getByText('Step 4 of 5: Checking').waitFor()
  await progress.getByText(/^31 sources found/).waitFor()
  assert.equal(await progress.getByRole('progressbar').count(), 0)

  // Writing the report, chapter by chapter.
  before = await callCount(page)
  await push(page, {
    at: new Date().toISOString(),
    note: 'Finished chapter 3 of 8',
    percent: 38,
    phase: 'writing_report',
    sourcesFound: 31,
  })
  await progress.getByText('Step 5 of 5: Writing the report').waitFor()
  await progress.getByText('Finished chapter 3 of 8').waitFor()
  assert.equal(await progress.getByRole('progressbar').getAttribute('aria-valuenow'), '38')
  assert.ok((await callsSince(page, before)).length > 0, 'each push is one frame and one re-read')
  await snap(page, '24-streaming-writing.png')
  await assertNoPolling(page, 'after the last push')
}

/** Knowledge › Research draws the same block, so its row streams the same pushes. */
export const walkStreamingKnowledgeRow = async (page) => {
  const row = page.getByTestId('research-list').locator(`[data-research-run="${RUNNING}"]`)
  await row.getByText('The result will come back to the conversation it was asked in.', { exact: false }).waitFor()
  await push(page, {
    at: new Date().toISOString(),
    note: 'Planned 12 lines of enquiry',
    percent: null,
    phase: 'scoping',
    sourcesFound: null,
  })
  const progress = row.getByTestId('research-progress')
  await progress.getByText('Step 1 of 5: Planning').waitFor()
  await progress.getByText('Planned 12 lines of enquiry').waitFor()
  assert.match(await progress.getByTestId('research-progress-facts').innerText(), /^Running for /)
  await assertNoPolling(page, 'on Knowledge › Research')
}

/** The brief dialog says the planner is replying until the turn event lands, and not a moment longer. */
export const walkTurnEventEndsReplying = async (page) => {
  await card(page, DRAFT).getByRole('button', { name: 'Continue the brief' }).click()
  const dialog = page.getByTestId('research-brief-dialog')
  await dialog.getByTestId('research-brief-workspace').waitFor()
  await dialog.getByRole('textbox', { name: /^Reply to / }).fill('Focus on solid-wall houses, please.')
  await dialog.getByRole('button', { name: 'Send' }).click()
  const replying = dialog.getByTestId('research-brief-replying')
  await replying.waitFor()
  await assertNoPolling(page, 'while the planner replies')
  assert.equal(await replying.count(), 1, 'still replying: no turn has landed')

  // The planner's turn settles; its event re-reads the brief, and the dialog stops waiting.
  await page.evaluate((id) => window.__research.plannerAnswers(id), DRAFT)
  await replying.waitFor({ state: 'detached' })
  await dialog.getByText('I’ll focus on the UK', { exact: false }).waitFor()
}
