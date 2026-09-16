// An agent editing a spreadsheet, seen from a person's browser.
//
// This is the case the no-approval-gate decision rests on. Nothing stops an
// agent writing into a document somebody is looking at, so what has to be true
// instead is that they *see it happening*: the agent's name and colour on a
// cursor, a selection on the range it is about to change, and the value it is
// about to put there — before the cell changes — followed by the version the
// write door saved, sitting in History where anybody can restore it.
//
// It drives the `spreadsheet-agent-edit` mock-LLM scenario through the worker's
// own builtin dispatch (`lib/agent.mjs`), so every frame on screen came from
// `sheet_read_range` and `sheet_write_range` actually running. Nothing is
// injected.
import { createChecks } from '../../navigation/lib/expect.mjs'
import { formulaBarText, gotoCell, peersOnScreen, shot, until } from '../lib/grid.mjs'
import { serverCsv } from '../lib/seed.mjs'

/** `#rrggbb` from whatever the browser computed, so a palette entry compares. */
const hexOf = (colour) => {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(colour ?? '')
  if (!match) return (colour ?? '').toLowerCase()
  const [, r, g, b] = match
  return `#${[r, g, b].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`
}

export const run = async ({ openSheet, page, runAgentScenario, seed }) => {
  const checks = createChecks('agent-presence')
  const sheet = await seed.createSpreadsheet({
    rows: [['Region', 'Revenue'], ['North', 10]],
    title: `Agent presence ${Date.now()}`,
  })
  await openSheet(sheet.pageId)

  // The person is looking at the document before the agent arrives. Reading
  // through the formula bar rather than the DOM because the grid is IronCalc's
  // canvas: there is no cell element to query.
  await gotoCell(page, 'B2')
  checks.equal('the sheet starts at its seeded value', await formulaBarText(page), '10')
  await shot(page, 'agent-presence-before')

  // Deliberately not awaited: the drafts only exist while the scenario is
  // mid-flight, and awaiting here would assert on the aftermath.
  const finished = runAgentScenario({
    pageId: sheet.pageId,
    scenario: 'spreadsheet-agent-edit',
  })

  // ── The agent arrives, and is visibly an agent ───────────────────────────
  // Waiting on the tag rather than on the value is the whole point: presence
  // that only arrived with the batch would still pass a value assertion and
  // lose everything this case exists to show.
  const arrival = await until('the agent to appear in the person\'s grid', async () => {
    const seen = await peersOnScreen(page)
    return seen.tags.some((tag) => tag.includes(seed.agent.name)) ? seen : null
  }, { timeoutMs: 60_000 })

  checks.ok('the person sees the agent\'s cursor tag', true, arrival.tags.join(' | '))
  checks.ok(
    'it is marked as an agent, not mistaken for a colleague',
    arrival.tags.some((tag) => tag.includes('⌬')),
    arrival.tags.join(' | '),
  )
  checks.ok(
    'the agent draws a selection rectangle on the range it is working in',
    arrival.ranges.length > 0,
    `${arrival.ranges.length} range(s)`,
  )
  checks.ok(
    'the presence strip names the agent',
    arrival.strip.some((title) => title.includes(seed.agent.name)),
    arrival.strip.join(' | '),
  )

  // Its own colour, resolved from the agent record rather than a default.
  const painted = hexOf(await page
    .locator('[data-testid="spreadsheet-peer-tag"]')
    .first()
    .evaluate((node) => getComputedStyle(node).backgroundColor))
  checks.ok('the cursor is painted a real colour', /^#[0-9a-f]{6}$/u.test(painted), painted)
  checks.ok(
    'and not the default foreground',
    painted !== '#000000' && painted !== '#ffffff',
    painted,
  )

  // ── The draft: what is about to land, before it lands ────────────────────
  const drafting = await until('the agent\'s draft to appear', async () => {
    const seen = await peersOnScreen(page)
    return seen.drafts.some((draft) => draft.length > 0) ? seen : null
  }, { timeoutMs: 60_000 })
  const drafted = drafting.drafts.filter((draft) => draft.length > 0)
  checks.ok('the person sees what the agent is about to write', drafted.length > 0, drafted.join(' | '))
  await shot(page, 'agent-presence-drafting')

  // The scenario writes "Region" into A1 first, so by the time any draft is on
  // screen the cell the person is watching still holds what it held.
  const csvWhileDrafting = await serverCsv(sheet.pageId, seed.ownerToken)
  checks.ok(
    'the values have not all landed yet while a draft is showing',
    csvWhileDrafting.includes('North'),
    csvWhileDrafting.split('\r\n')[1] ?? '',
  )

  const { versionId } = await finished

  // ── The batch arrives on the same lane, without a reload ─────────────────
  await until('the draft to clear once the batch lands', async () => {
    const seen = await peersOnScreen(page)
    return seen.drafts.every((draft) => draft.length === 0) ? seen : null
  }, { timeoutMs: 60_000 })

  // The scenario ends by restoring the version the write door saved before the
  // agent's first write, so the document is back where the person left it.
  checks.ok('the run\'s first write took a version', Boolean(versionId), String(versionId))
  await until('the restore to reach the person\'s grid', async () => {
    await gotoCell(page, 'B2')
    return (await formulaBarText(page)) === '10'
  }, { timeoutMs: 60_000 })
  checks.equal('the restore put the sheet back', await formulaBarText(page), '10')

  const csv = await serverCsv(sheet.pageId, seed.ownerToken)
  checks.ok(
    'and the server agrees, not just the browser that watched it',
    csv.includes('North,10'),
    csv.replaceAll('\r\n', ' / ').trim(),
  )

  // ── History: the safety net, where a person can reach it ─────────────────
  await page.getByTestId('spreadsheet-action-history').click()
  await page.getByTestId('spreadsheet-history').waitFor({ timeout: 30_000 })
  const entries = page.locator('[data-testid^="spreadsheet-version-"]')
  await entries.first().waitFor({ timeout: 30_000 })
  const history = await entries.allInnerTexts()
  checks.ok(
    'History names the version saved before the agent started',
    history.some((entry) => /before:/iu.test(entry)),
    history.join(' | ').slice(0, 300),
  )
  checks.ok(
    'and says an agent authored it',
    history.some((entry) => entry.includes(seed.agent.name) || /agent/iu.test(entry)),
    history.join(' | ').slice(0, 300),
  )
  await shot(page, 'agent-presence-history')

  checks.close()
  return checks.checks
}
