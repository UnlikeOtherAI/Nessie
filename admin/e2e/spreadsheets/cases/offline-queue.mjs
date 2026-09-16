import { createChecks } from '../../navigation/lib/expect.mjs'
import { createSpreadsheet, serverCsv } from '../lib/seed.mjs'
import {
  commit,
  focusGrid,
  formulaBarText,
  gotoCell,
  openSpreadsheet,
  shot,
  typeDraft,
  until,
} from '../lib/grid.mjs'

/**
 * The connection goes away and **the person keeps working**.
 *
 * Rule 5 of `realtime-and-presence.md`: a client whose lane is down keeps
 * editing locally and queues its batches; on reconnect it catches up first and
 * then flushes the queue at the head it has actually seen. What makes this
 * worth a browser is the ordering — a queue flushed before the catch-up would
 * send batches based on a seq the client never applied, and the only place
 * that shows up is a second workbook disagreeing with the first.
 *
 * The outage is a route that refuses Bruno's lane and his write door while
 * leaving everything else alone. That is what a dropped connection looks like
 * from inside the tab, and it is the honest way to produce one: nothing in the
 * app is stubbed or told it is offline.
 */
export const run = async ({ browser, contextFor, seed }) => {
  const checks = createChecks('offline-queue')
  const page = await createSpreadsheet({
    spaceId: seed.spaceId,
    title: `Offline queue ${Date.now()}`,
    token: seed.ownerToken,
  })
  const [ada, bruno] = seed.people

  const adaContext = await contextFor(browser, ada)
  const brunoContext = await contextFor(browser, bruno)
  const adaPage = await adaContext.newPage()
  const brunoPage = await brunoContext.newPage()
  const errors = []
  adaPage.on('pageerror', (error) => errors.push(`ada: ${error}`))
  brunoPage.on('pageerror', (error) => errors.push(`bruno: ${error}`))

  try {
    await openSpreadsheet(adaPage, { pageId: page.id, spaceId: seed.spaceId })
    await openSpreadsheet(brunoPage, { pageId: page.id, spaceId: seed.spaceId })

    // ── The outage ───────────────────────────────────────────────────────────
    let offline = true
    await brunoContext.route('**/pages/*/live*', async (route) =>
      (offline ? route.abort('connectionfailed') : route.continue()))
    await brunoContext.route('**/spreadsheet/ops', async (route) =>
      (offline && route.request().method() === 'POST'
        ? route.abort('connectionfailed')
        : route.continue()))

    // ── He keeps editing ─────────────────────────────────────────────────────
    // The edit comes first, deliberately. Routing the lane does not kill the
    // socket that is already open, so the *write* is what discovers the
    // outage — which is also the ordinary case: a proxy that refuses a POST
    // while an SSE stream it opened minutes ago keeps flowing.
    await focusGrid(brunoPage)
    await gotoCell(brunoPage, 'B3')
    await typeDraft(brunoPage, 'queued')
    await commit(brunoPage)
    await gotoCell(brunoPage, 'B3')
    checks.equal('the edit is in his own workbook already',
      await formulaBarText(brunoPage), 'queued')

    // And he is told, rather than left to find out: the pane's own offline
    // line, which Phase 3a rendered and this phase is what actually raises.
    await brunoPage.getByTestId('spreadsheet-offline-notice').waitFor({ timeout: 30_000 })
    checks.equal('Bruno is told the connection is down',
      await brunoPage.getByTestId('spreadsheet-offline-notice').count(), 1)
    await shot(brunoPage, 'offline-notice')

    const csvDuring = await serverCsv(page.id, seed.ownerToken)
    checks.ok('and nowhere else yet', !csvDuring.includes('queued'),
      JSON.stringify(csvDuring.slice(0, 120)))

    // ── And the world moves on without him ───────────────────────────────────
    await focusGrid(adaPage)
    await gotoCell(adaPage, 'D7')
    await typeDraft(adaPage, 'meanwhile')
    await commit(adaPage)
    await until('Ada\'s edit to land', async () =>
      (await serverCsv(page.id, seed.ownerToken)).includes('meanwhile'))

    // ── Reconnect ────────────────────────────────────────────────────────────
    offline = false
    await until('Bruno\'s queued edit to reach the server', async () =>
      (await serverCsv(page.id, seed.ownerToken)).includes('queued'), { timeoutMs: 60_000 })
    checks.ok('the queued edit went out on reconnect', true)

    await until('the offline line to clear', async () =>
      (await brunoPage.getByTestId('spreadsheet-offline-notice').count()) === 0,
    { timeoutMs: 30_000 })
    checks.equal('and the offline line cleared',
      await brunoPage.getByTestId('spreadsheet-offline-notice').count(), 0)

    // The catch-up ran before the flush, so his workbook has what he missed.
    await focusGrid(brunoPage)
    checks.equal('Bruno caught up on what he missed',
      await until('D7 to arrive', async () => {
        await gotoCell(brunoPage, 'D7')
        const text = await formulaBarText(brunoPage)
        return text === '' ? null : text
      }, { timeoutMs: 30_000 }),
      'meanwhile')
    await gotoCell(brunoPage, 'B3')
    checks.equal('and kept his own edit', await formulaBarText(brunoPage), 'queued')

    // Ada's workbook agrees, which is the only proof that matters.
    await focusGrid(adaPage)
    checks.equal('Ada has his edit too',
      await until('B3 to arrive in Ada\'s browser', async () => {
        await gotoCell(adaPage, 'B3')
        const text = await formulaBarText(adaPage)
        return text === '' ? null : text
      }, { timeoutMs: 30_000 }),
      'queued')
    await shot(brunoPage, 'offline-reconciled')

    checks.equal('no conflict notice was needed',
      await brunoPage.getByTestId('spreadsheet-conflict-notice').count(), 0)
    checks.ok('no page errors in either browser', errors.length === 0, errors.join(' | '))
  } finally {
    await adaContext.close()
    await brunoContext.close()
  }
  checks.close()
  return checks.checks
}
