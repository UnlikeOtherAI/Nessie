import assert from 'node:assert/strict'

/**
 * The research-brief suite's address walks: a brief opened at the admin's own
 * addresses for a reply thread and the Threads inbox, a question handed from a
 * screen with no brief host to the conversation it belongs to (and dropped
 * from history once taken), and Knowledge › Research whose first page the
 * server's bounded read answered empty with more to come.
 */

const RUNS = '/api/integrations/products/deep-water/research-runs'
const CHANNEL = '40000000-0000-4000-8000-000000000001'
const THREAD = '40000000-0000-4000-8000-000000000002'
const DM_CHANNEL = '40000000-0000-4000-8000-000000000003'
const DM_THREAD = '40000000-0000-4000-8000-000000000004'
const REPLY_ROOT = '60000000-0000-4000-8000-000000000099'
const OLD_CARD_ROOT = '60000000-0000-4000-8000-000000000097'
const DRAFT = '50000000-0000-4000-8000-000000000001'
const RUNNING = '50000000-0000-4000-8000-000000000006'

export const REPLY_THREAD_BRIEF = `at=/channels/${CHANNEL}/threads/${THREAD}/replies/${REPLY_ROOT}?research=${DRAFT}`
export const INBOX_BRIEF = `at=/threads?research=${RUNNING}`

const created = (page) => page.evaluate((path) =>
  window.__research.calls.filter((call) => call.method === 'POST' && call.path === path).at(-1), RUNS)

const whereAmI = (page) => page.evaluate(() => window.__research.location())

/** `?research=` on a reply thread's address opens that brief over the reply thread. */
export const walkReplyThreadAddress = async (page) => {
  const dialog = page.getByTestId('research-brief-dialog')
  await dialog.getByTestId('research-brief-workspace').waitFor()
  await dialog.getByText('which country should I focus on?', { exact: false }).waitFor()
  const { pathname, search } = await whereAmI(page)
  assert.equal(pathname, `/channels/${CHANNEL}/threads/${THREAD}/replies/${REPLY_ROOT}`)
  assert.equal(new URLSearchParams(search).get('research'), DRAFT)
}

/**
 * The Threads inbox is no conversation: a brief opened there is shown as being
 * elsewhere, and a card's composer sends a new one back under its reply thread.
 */
export const walkInbox = async (page) => {
  const dialog = page.getByTestId('research-brief-dialog')
  await dialog.getByText('The result will come back to the conversation it was asked in.', { exact: false }).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click()
  await dialog.waitFor({ state: 'detached' })
  assert.equal(new URLSearchParams((await whereAmI(page)).search).get('research'), null, 'closing drops ?research=')

  await page.getByTestId('inbox-research-button').click()
  const form = page.getByTestId('research-brief-new')
  assert.equal(await form.getByRole('textbox').first().inputValue(), 'What do tenants pay to heat a flat?')
  await form.getByRole('button', { name: 'Plan with DeepWater' }).click()
  await page.getByTestId('research-brief-replying').waitFor()
  assert.deepEqual((await created(page)).body.origin, {
    channelId: DM_CHANNEL, kind: 'thread', rootMessageId: REPLY_ROOT, threadId: DM_THREAD,
  })
}

/**
 * An older card on a screen with no brief host hands its question to its own
 * conversation in router state: the reply thread opens with the question in a
 * new brief, the state is dropped from that entry at once, so Back and
 * Forward return to the conversation — never to a half-filled form — and the
 * brief comes back under the card's reply thread.
 */
export const walkHandedQuestion = async (page, snap) => {
  const target = `/channels/${DM_CHANNEL}/threads/${DM_THREAD}/replies/${OLD_CARD_ROOT}`
  const runAgain = () => page.getByTestId('older-card').getByRole('button', { name: 'Run again' }).click()
  await runAgain()
  const form = page.getByTestId('research-brief-new')
  assert.equal(await form.getByRole('textbox').first().inputValue(), 'Heat pump grants for landlords')
  await page.waitForFunction((path) => {
    const here = window.__research.location()
    return here.pathname === path && here.state === null
  }, target)
  await snap(page, '20-handed-question.png')

  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click()
  await form.waitFor({ state: 'detached' })
  await page.evaluate(() => window.__research.go(-1))
  await page.getByTestId('research-elsewhere').waitFor()
  await page.evaluate(() => window.__research.go(1))
  await page.getByTestId('research-thread').waitFor()
  await page.evaluate(() => new Promise((done) => setTimeout(done, 400)))
  assert.equal(await page.getByTestId('research-brief-new').count(), 0, 'Forward does not reopen the handed question')

  await page.evaluate(() => window.__research.go(-1))
  await page.getByTestId('research-elsewhere').waitFor()
  await runAgain()
  await form.getByRole('button', { name: 'Plan with DeepWater' }).click()
  await page.getByTestId('research-brief-replying').waitFor()
  assert.deepEqual((await created(page)).body.origin, {
    channelId: DM_CHANNEL, kind: 'thread', rootMessageId: OLD_CARD_ROOT, threadId: DM_THREAD,
  })
}

/**
 * The server read only research this viewer may not see for the first page:
 * it came back empty with more to come. That is not "No research yet" — the
 * pager stays, says so, and Next reaches the research further back.
 */
export const walkEmptyFirstPage = async (page, snap) => {
  const note = page.getByTestId('research-list-nothing-here')
  await note.getByText('choose Next to keep looking.', { exact: false }).waitFor()
  assert.equal(await page.getByText('No research yet').count(), 0)
  await page.getByText('None on this page', { exact: true }).waitFor()
  await page.getByText('Page 1 of 2', { exact: true }).waitFor()
  await snap(page, '18d-knowledge-empty-page-with-more.png')

  const rows = page.locator('[data-research-run]')
  await page.getByRole('button', { name: 'Next page' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-research-run]').length === 10)
  // A page after a short one counts its own rows; it never claims "11–20".
  await page.getByText('10 on this page', { exact: true }).waitFor()
  await page.getByText('Page 2 of 3', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Next page' }).click()
  await page.getByText('Page 3 of 3', { exact: true }).waitFor()
  assert.ok(await rows.count() > 0 && await rows.count() < 10)
  assert.equal(await page.getByRole('button', { name: 'Next page' }).isDisabled(), true)
  await page.getByRole('button', { name: 'Previous page' }).click()
  await page.getByText('Page 2 of 3', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Previous page' }).click()
  await note.waitFor()
  assert.equal(await page.getByRole('button', { name: 'Next page' }).isDisabled(), false)
}
