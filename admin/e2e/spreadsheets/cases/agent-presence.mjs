// An agent editing a spreadsheet, seen from a person's browser.
//
// This is the case the no-approval-gate decision rests on. Nothing stops an
// agent writing into a document somebody is looking at, so what has to be true
// instead is that they *see it happening*: the agent's name and colour on a
// cursor, a selection on the range it is about to change, and the value it is
// about to put there — before the cell changes — followed by the version the
// write door saved, sitting in History where it can be restored.
//
// It drives the `spreadsheet-agent-edit` mock-LLM scenario, which calls
// `sheet_describe`, `sheet_read_range`, `sheet_write_range` and then
// `sheet_versions restore`. The scenario names its page and version by
// placeholder, because neither id exists when a scenario is written; the
// harness below fills them in from the page it seeded.
//
// What this case needs from `admin/e2e/spreadsheets/run.mjs` (Phase 3b owns the
// harness; this one file is Phase 4's):
//
//   page      a Playwright page already signed in as a person
//   seed      { token, project, agent } for the API seeding helpers
//   openSheet(pageId)          opens the pane and waits for the grid
//   runAgentScenario({ ... })  enqueues a run of a named mock-LLM scenario
//                              against this page and resolves when it finishes
//
// If the harness names these differently, only the destructuring at the top of
// `run` changes: every assertion below is about what a person sees.
import { createChecks } from '../lib/expect.mjs'
import { shot } from '../lib/page.mjs'

/** The overlay's own marks, so a selector change is one edit in one place. */
const CURSOR = '.spreadsheet-presence-cursor'
const LABEL = '.spreadsheet-presence-label'
const DRAFT = '.spreadsheet-presence-draft'

const hexOf = (colour) => {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(colour ?? '')
  if (!match) return (colour ?? '').toLowerCase()
  const [, r, g, b] = match
  return `#${[r, g, b].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`
}

export const agentPresence = {
  name: 'agent-presence',
  run: async ({ page, seed, openSheet, runAgentScenario }) => {
    const checks = createChecks('agent-presence')

    const sheet = await seed.createSpreadsheet({
      title: 'Regional revenue',
      rows: [['Region', 'Revenue'], ['North', 10]],
    })
    await openSheet(sheet.pageId)

    // The person is looking at the document before the agent arrives, which is
    // the only way "the values changed under me" is a thing they could notice.
    const before = await page.locator('[data-cell="B2"]').innerText()
    checks.equal('the sheet starts at its seeded value', before.trim(), '10')
    await shot(page, 'agent-presence', 'before')

    const finished = runAgentScenario({
      scenario: 'spreadsheet-agent-edit',
      pageId: sheet.pageId,
      agentId: seed.agent.id,
    })

    // The agent announces itself before it writes. Waiting on the cursor rather
    // than on the value is deliberate: if presence only arrived with the batch,
    // this would still pass on the value and the whole point would be lost.
    const cursor = page.locator(CURSOR).first()
    await cursor.waitFor({ timeout: 30_000 })
    checks.ok('the agent has a cursor in the grid', await page.locator(CURSOR).count() > 0)

    const label = page.locator(LABEL).first()
    const name = (await label.innerText()).trim()
    checks.equal('the cursor carries the agent\'s own name', name, seed.agent.name)

    // Its own colour — the one its avatar uses everywhere else in the product,
    // resolved through the identity directory because `GET /api/agents` omits
    // system agents and a raw agent map would have shown a placeholder.
    const painted = hexOf(await label.evaluate((node) => getComputedStyle(node).backgroundColor))
    checks.ok('the cursor is painted in the agent\'s colour', /^#[0-9a-f]{6}$/u.test(painted), painted)
    checks.ok(
      'it is not the default foreground',
      painted !== '#000000' && painted !== '#ffffff',
      painted,
    )

    // The draft: what is about to land, before it lands.
    const draft = page.locator(DRAFT).first()
    await draft.waitFor({ timeout: 30_000 })
    const drafted = (await draft.innerText()).trim()
    const cellWhileDrafting = (await page.locator('[data-cell="B2"]').innerText()).trim()
    checks.ok('a draft is shown', drafted.length > 0, drafted)
    checks.equal('the cell has not changed yet', cellWhileDrafting, '10')
    await shot(page, 'agent-presence', 'drafting')

    await finished

    // Then the values, without a reload: the batch arrived on the same lane.
    await page.locator('[data-cell="A2"]').filter({ hasText: 'North' }).waitFor({ timeout: 30_000 })
    const settled = await page.locator(DRAFT).count()
    checks.equal('the draft is cleared once the batch lands', settled, 0)

    // The scenario ends by restoring the version the write door saved before
    // the agent's first write, so the sheet is back where it started — and the
    // person can see both versions in History.
    const restored = (await page.locator('[data-cell="B2"]').innerText()).trim()
    checks.equal('the restore put the sheet back', restored, '10')

    await page.locator('[data-testid="spreadsheet-history"]').click()
    const entries = page.locator('[data-testid="spreadsheet-history-entry"]')
    await entries.first().waitFor({ timeout: 30_000 })
    const history = await entries.allInnerTexts()
    checks.ok(
      'History names the version saved before the agent started',
      history.some((entry) => /before:/iu.test(entry) && entry.includes(seed.agent.name)),
      history.join(' | '),
    )
    checks.ok(
      'History shows the agent as the author, not a person',
      history.some((entry) => entry.includes(seed.agent.name)),
      history.join(' | '),
    )
    await shot(page, 'agent-presence', 'history')

    checks.close()
    return checks.checks
  },
}
