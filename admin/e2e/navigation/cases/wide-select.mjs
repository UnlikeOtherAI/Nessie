// Tablet and desktop, selecting a channel. Those layouts keep their columns
// adjacent and never mount the phone stack, so a sibling swap must not slide
// anything (docs/navigation.md §1: an unchanged identity key never animates).
// This case pins today's behaviour: no phone viewport, no layer motion, and
// a shell whose columns stay exactly where they were.
import { createChecks } from '../lib/expect.mjs'
import { hasPhoneViewport, watchForMotion } from '../lib/freeze.mjs'
import { clickChannelRow, gotoChannels, shot } from '../lib/page.mjs'

const REGIONS = ['main', '.resizable-sidebar']
const WATCH_MS = 700

const sameRect = (before, after) => {
  if (!before?.rect || !after?.rect) return false
  return ['height', 'left', 'top', 'width'].every(
    (key) => Math.abs(before.rect[key] - after.rect[key]) < 0.5,
  )
}

const wideSelectCase = (viewport) => ({
  name: `${viewport}-select`,
  run: async ({ page, seed }) => {
    const caseName = `${viewport}-select`
    const checks = createChecks(caseName)
    await gotoChannels(page)

    checks.ok('no phone navigation stack at this width', (await hasPhoneViewport(page)) === false)
    const frames = [await shot(page, caseName, '00-before')]

    const baseline = await watchForMotion(page, { selectors: REGIONS, windowMs: 50 })
    const selected = clickChannelRow(page, seed.channels[1].slug)
    const observed = await watchForMotion(page, { selectors: REGIONS, windowMs: WATCH_MS })
    await selected

    checks.ok(
      'the route changed to the selected channel',
      page.url().includes('/channels/'),
      page.url(),
    )
    checks.ok(
      'no navigation layer or column animates',
      observed.animated.length === 0,
      observed.animated.join(', '),
    )
    for (const [index, selector] of REGIONS.entries()) {
      const before = baseline.before[index]
      const after = observed.after[index]
      if (!before?.rect) {
        checks.ok(`${selector} is present`, false, 'not found in the document')
        continue
      }
      checks.ok(
        `${selector} does not move`,
        sameRect(before, after),
        `${JSON.stringify(before.rect)} → ${JSON.stringify(after?.rect)}`,
      )
    }

    frames.push(await shot(page, caseName, '01-after'))
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport,
})

export const tabletSelect = wideSelectCase('tablet')
export const desktopSelect = wideSelectCase('desktop')
