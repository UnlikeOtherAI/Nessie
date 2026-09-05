// Phone, switching between two boards of one project. A board is a tab of the
// project's Board section, not a screen of its own: switching must animate no
// navigation layer, move neither region, and leave Back pointing out of the
// project rather than at the board somebody just left
// (docs/navigation/overview.md §1, "Tab hosts").
import { hasPhoneViewport, waitForStackSettled, watchForMotion } from '../lib/freeze.mjs'
import { clickTab, gotoPath, selectedTab, shot } from '../lib/page.mjs'
import { ensureSecondBoard } from '../lib/seed.mjs'
import { createChecks } from '../lib/expect.mjs'

const REGIONS = ['[data-phone-navigation-viewport]', '[data-phone-navigation-layer="current"]']
const WATCH_MS = 600

const sameRect = (before, after) => {
  if (!before?.rect || !after?.rect) return false
  return ['height', 'left', 'top', 'width'].every(
    (key) => Math.abs(before.rect[key] - after.rect[key]) < 0.5,
  )
}

// Reads the switcher through the shared helper, so a project with enough
// boards to collapse the strip into a dropdown reports its selection the same
// way rather than silently reading null.
const selectedBoardTab = (page) => selectedTab(page, 'Boards')

export const phoneBoardSwitch = {
  name: 'phone-board-switch',
  run: async ({ page, seed }) => {
    const checks = createChecks('phone-board-switch')
    // A second board, so the switcher has a choice to offer at all. Created
    // through the same route the settings dialog calls.
    await ensureSecondBoard(seed.token, seed.project.id, 'Review queue')

    await gotoPath(page, `/projects/${seed.project.id}/board`)
    await waitForStackSettled(page)

    checks.ok('phone stack is mounted', await hasPhoneViewport(page))
    checks.equal('starts on the default board', await selectedBoardTab(page), 'Board')
    const frames = [await shot(page, 'phone-board-switch', '00-default-board')]

    const motion = await watchForMotion(page, { selectors: REGIONS, windowMs: WATCH_MS })
    const switched = clickTab(page, 'Boards', 'Review queue')
    const observed = await watchForMotion(page, { selectors: REGIONS, windowMs: WATCH_MS })
    await switched

    checks.equal('ends on the second board', await selectedBoardTab(page), 'Review queue')
    checks.ok(
      'the choice is in the URL, not component state',
      new URL(page.url()).searchParams.has('board'),
      page.url(),
    )
    checks.ok(
      'no navigation layer animates on a board switch',
      observed.animated.length === 0,
      observed.animated.join(', '),
    )
    for (const [index, selector] of REGIONS.entries()) {
      checks.ok(
        `${selector} does not move`,
        sameRect(motion.before[index], observed.after[index]),
        `${JSON.stringify(motion.before[index]?.rect)} → ${JSON.stringify(observed.after[index]?.rect)}`,
      )
      checks.equal(`${selector} scrollLeft`, observed.after[index]?.scrollLeft ?? null, 0)
    }

    frames.push(await shot(page, 'phone-board-switch', '01-second-board'))
    frames.push(await shot(page, 'phone-board-switch', '02-settled'))
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'phone',
}
