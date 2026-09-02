// Tablet and desktop, selecting a channel. Those layouts are `split`
// (docs/navigation/overview.md §5): the list column is pinned and the detail column
// is its own navigation stack, in which a root → detail or a sibling swap is
// an in-place change — nothing slides (§1: an unchanged identity key never
// animates). This case pins that: the split stack is mounted, one layer only,
// no layer or column motion, and a shell whose columns stay where they were.
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

    checks.ok('the split stack is mounted at this width', (await hasPhoneViewport(page)) === true)
    checks.ok(
      'the shell declares the split layout',
      await page.evaluate(() => document.querySelector('[data-navigation]')?.getAttribute('data-navigation')) === 'split',
    )
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
    const layers = await page.evaluate(
      () => [...document.querySelectorAll('[data-phone-navigation-layer]')].map((el) => el.getAttribute('data-phone-navigation-layer')),
    )
    checks.ok('a sibling swap keeps one layer, nothing retained beneath', layers.length === 1 && layers[0] === 'current', layers.join(', '))
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
