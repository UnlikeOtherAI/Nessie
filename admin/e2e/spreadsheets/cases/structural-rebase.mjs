import { createChecks } from '../../navigation/lib/expect.mjs'
import { call, createSpreadsheet, serverCsv } from '../lib/seed.mjs'
import {
  cellBox,
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
 * Two people edit the same grid at the same moment, and **neither loses
 * anything**.
 *
 * Bruno types into B5. Ada inserts a row above row 1, which moves B5 to B6
 * before Bruno's batch reaches the write door. The server refuses his batch —
 * it was built against a grid that no longer exists — and the client repairs
 * it without asking him anything: undo, apply Ada's insert, re-issue the same
 * intent one row down, send again.
 *
 * Two things this case has to prove, and the second is the one that is easy to
 * lose. The value ends up in **B6**, not B5, so the edit followed its row
 * rather than landing on whatever now sits at the old index. And **no notice
 * appears**: a conflict the client repaired is not news, and a product that
 * announces every repair teaches people to ignore the line that matters.
 *
 * The race is made deterministic by holding Bruno's `POST …/ops` at the
 * network boundary. That is latency, not a stub: the request is the one his
 * browser actually built, and it is released unchanged.
 */
export const run = async ({ browser, contextFor, seed }) => {
  const checks = createChecks('structural-rebase')
  const page = await createSpreadsheet({
    spaceId: seed.spaceId,
    title: `Structural rebase ${Date.now()}`,
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

    // Something to move, so "the row shifted" is visible and not just asserted.
    await focusGrid(adaPage)
    await gotoCell(adaPage, 'A1')
    await typeDraft(adaPage, 'header')
    await commit(adaPage)
    await until('the seed value to land', async () =>
      (await serverCsv(page.id, seed.ownerToken)).includes('header'))

    // Hold Bruno's next write for a beat, so Ada's insert is certain to win
    // the race the plan says is normally a single round trip wide.
    let held = 0
    await brunoContext.route('**/spreadsheet/ops', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      held += 1
      if (held === 1) await new Promise((done) => { setTimeout(done, 2_500) })
      return route.continue()
    })

    await focusGrid(brunoPage)
    await gotoCell(brunoPage, 'B5')
    await typeDraft(brunoPage, '99')
    await commit(brunoPage)

    // Ada inserts a row above row 1, through the widget's own row-header
    // context menu — a client batch with recorded intents, which is what a
    // person actually produces. (A server-built structural batch carries no
    // intents and is deliberately *not* rebasable; see `foreignSummary`.)
    const rowOne = await cellBox(adaPage, 'A1')
    const canvas = await adaPage.locator('.ic-worksheet-sheet-canvas').boundingBox()
    await adaPage.mouse.click(canvas.x + 14, rowOne.y + rowOne.height / 2, { button: 'right' })
    await adaPage.getByText(/Insert \d+ row\(s\) above/).first().click()
    await until('Ada\'s insert to reach the server', async () => {
      const page_ = await call(
        `/api/knowledge-base/pages/${page.id}/spreadsheet/ops?afterSeq=0`,
        { token: seed.ownerToken },
      )
      return page_.batches.some((batch) => batch.structuralKind === 'insertRows')
    })

    // ── The proof ────────────────────────────────────────────────────────────
    // The journal, first: three batches, and Bruno's carries `baseSeq: 2`.
    // That is the rebase, stated as a number — the batch he *built* was based
    // at seq 1, and a batch the server accepted at 1 would have landed on the
    // row Ada's insert had already moved.
    //
    // The CSV export is deliberately **not** the oracle here: it starts at the
    // sheet's first non-empty row, so an insert that pushes everything down by
    // one leaves it byte-identical. It answers "what is in this workbook", not
    // "where", which is exactly the question this case asks.
    const journal = await until('Bruno\'s rebased batch to land', async () => {
      const ops = await call(
        `/api/knowledge-base/pages/${page.id}/spreadsheet/ops?afterSeq=0`,
        { token: seed.ownerToken },
      )
      return ops.batches.length >= 3 ? ops.batches : null
    }, { timeoutMs: 40_000 })
    const [seeded, structural, rebased] = journal
    checks.equal('Ada\'s seed is seq 1', seeded?.seq, 1)
    checks.equal('her insert is seq 2', structural?.structuralKind, 'insertRows')
    checks.ok('and it says which rows moved',
      JSON.stringify(structural?.structuralIntents) === JSON.stringify([{ kind: 'insertRows', sheet: 0, row: 1, count: 1 }]),
      JSON.stringify(structural?.structuralIntents))
    checks.equal('Bruno\'s batch is seq 3', rebased?.seq, 3)
    checks.equal('and it was rebased onto her insert, not sent at its original base',
      rebased?.baseSeq, 2)
    checks.equal('by Bruno', rebased?.actor.displayName, bruno.displayName)

    // Both workbooks, independently: the edit followed its row.
    const reads = async (target, a1) => {
      await focusGrid(target)
      await gotoCell(target, a1)
      return until(`${a1} to settle`, async () => {
        const text = await formulaBarText(target)
        return text === '' ? '(empty)' : text
      })
    }
    for (const [who, target] of [['Bruno', brunoPage], ['Ada', adaPage]]) {
      checks.equal(`${who}'s B6 carries the edit`, await reads(target, 'B6'), '99')
      checks.equal(`${who}'s B5 is empty`, await reads(target, 'B5'), '(empty)')
      checks.equal(`${who}'s header moved to A2`, await reads(target, 'A2'), 'header')
    }

    // Nothing was lost, so nothing was said.
    checks.equal('no conflict notice in Bruno\'s browser',
      await brunoPage.getByTestId('spreadsheet-conflict-notice').count(), 0)
    checks.equal('no live error either',
      await brunoPage.getByTestId('spreadsheet-live-error').count(), 0)
    checks.equal('and no action error',
      await brunoPage.getByTestId('spreadsheet-action-error').count(), 0)

    await shot(brunoPage, 'structural-rebase')
    await shot(adaPage, 'structural-rebase-ada')

    checks.ok('no page errors in either browser', errors.length === 0, errors.join(' | '))
  } finally {
    await adaContext.close()
    await brunoContext.close()
  }
  checks.close()
  return checks.checks
}
