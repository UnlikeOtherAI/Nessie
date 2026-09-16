import { createChecks } from '../../navigation/lib/expect.mjs'
import { createSpreadsheet, serverCsv } from '../lib/seed.mjs'
import {
  address,
  commit,
  focusGrid,
  formulaBarText,
  gotoCell,
  openSpreadsheet,
  peersOnScreen,
  shot,
  typeDraft,
  until,
} from '../lib/grid.mjs'

/**
 * The case the whole phase exists for: **B sees what A is typing before A has
 * pressed Enter.**
 *
 * Two real browsers, two real accounts, one API, one database. Nothing is
 * stubbed and no frame is injected: A's keystrokes go into IronCalc's own
 * editor, the draft is read off that editor's textarea by `useDraftObserver`,
 * published to `POST …/presence`, fanned out on the document lane, and drawn
 * by `PresenceOverlay` in B's browser. If any link in that chain is broken
 * this case fails, which is why it is worth more than any number of unit
 * assertions about the pieces.
 */
export const run = async ({ browser, contextFor, seed }) => {
  const checks = createChecks('two-browsers')
  const page = await createSpreadsheet({
    spaceId: seed.spaceId,
    title: `Two browsers ${Date.now()}`,
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

    // ── 1. Each sees the other arrive ────────────────────────────────────────
    // The strip is presence's home (Rule zero): a person who cannot tell
    // anybody else is in the document has no live collaboration, whatever the
    // overlay draws.
    const strip = await until('Bruno to see Ada in the presence strip', async () => {
      const seen = await peersOnScreen(brunoPage)
      return seen.strip.some((title) => title.includes(ada.displayName)) ? seen : null
    })
    checks.ok('Bruno\'s strip names Ada', true, strip.strip.join(' | '))

    await focusGrid(adaPage)
    await gotoCell(adaPage, 'B4')
    await until('Bruno to see Ada\'s selection', async () => {
      const seen = await peersOnScreen(brunoPage)
      return seen.ranges.length > 0 && seen.tags.some((tag) => tag.includes(ada.displayName))
        ? seen
        : null
    })
    const before = await peersOnScreen(brunoPage)
    checks.ok('Bruno draws Ada\'s selection rectangle', before.ranges.length === 1,
      JSON.stringify(before.ranges))
    checks.ok('and tags it with her name', before.tags.some((tag) => tag.includes(ada.displayName)),
      before.tags.join(' | '))

    // ── 2. The draft, before Enter ───────────────────────────────────────────
    await typeDraft(adaPage, '1250')
    const drafted = await until('Bruno to see Ada\'s uncommitted draft', async () => {
      const seen = await peersOnScreen(brunoPage)
      return seen.drafts.some((text) => text.includes('1250')) ? seen : null
    })
    checks.ok('Bruno shows the draft text Ada has not committed', true, drafted.drafts.join(' | '))

    // …and it really is uncommitted: the server has no such value yet.
    const csvBefore = await serverCsv(page.id, seed.ownerToken)
    checks.ok('the server has not been told about it', !csvBefore.includes('1250'),
      JSON.stringify(csvBefore.slice(0, 120)))
    await shot(brunoPage, 'two-browsers-draft')

    // ── 3. The committed value ───────────────────────────────────────────────
    await commit(adaPage)
    await until('the value to reach the server', async () =>
      (await serverCsv(page.id, seed.ownerToken)).includes('1250'))
    await until('Bruno\'s draft ghost to clear', async () => {
      const seen = await peersOnScreen(brunoPage)
      return seen.drafts.every((text) => !text.includes('1250'))
    })
    checks.ok('the draft ghost clears on commit', true)

    await focusGrid(brunoPage)
    await gotoCell(brunoPage, 'B4')
    const value = await until('B4 to read 1250 in Bruno\'s browser', async () =>
      (await formulaBarText(brunoPage)).includes('1250')
        ? await formulaBarText(brunoPage)
        : null)
    checks.ok('Bruno\'s own workbook has the committed value', true, value)
    await shot(brunoPage, 'two-browsers-committed')

    // ── 4. The selection follows ─────────────────────────────────────────────
    await gotoCell(adaPage, 'E9')
    const moved = await until('Ada\'s rectangle to move in Bruno\'s browser', async () => {
      const seen = await peersOnScreen(brunoPage)
      const range = seen.ranges[0]
      if (!range || !before.ranges[0]) return null
      return range.top > before.ranges[0].top + 4 && range.left > before.ranges[0].left + 4
        ? seen
        : null
    })
    checks.ok('Ada\'s rectangle moved down and right with her', true, JSON.stringify(moved.ranges))
    const adaAt = await address(adaPage)
    checks.equal('Ada is on row 9', adaAt.row, 9)
    checks.equal('Ada is on column E', adaAt.column, 5)
    await shot(brunoPage, 'two-browsers-presence')

    checks.ok('no page errors in either browser', errors.length === 0, errors.join(' | '))
  } finally {
    await adaContext.close()
    await brunoContext.close()
  }
  checks.close()
  return checks.checks
}
