// Phone, switching a tab inside the channel (Messages → Files). A tab host
// swaps its sections in place: it is never a push, never a history entry,
// and the screen must not move at all (docs/navigation/overview.md §1).
import { hasPhoneViewport, waitForStackSettled, watchForMotion } from '../lib/freeze.mjs'
import { clickChannelTab, gotoChannel, selectedChannelTab, shot } from '../lib/page.mjs'
import { createChecks } from '../lib/expect.mjs'

const REGIONS = ['[data-phone-navigation-viewport]', '[data-phone-navigation-layer="current"]']
const WATCH_MS = 600

const sameRect = (before, after) => {
  if (!before?.rect || !after?.rect) return false
  return ['height', 'left', 'top', 'width'].every(
    (key) => Math.abs(before.rect[key] - after.rect[key]) < 0.5,
  )
}

export const phoneTabSwitch = {
  name: 'phone-tab-switch',
  run: async ({ page, seed }) => {
    const checks = createChecks('phone-tab-switch')
    await gotoChannel(page, seed.channels[0].id)
    await waitForStackSettled(page)

    checks.ok('phone stack is mounted', await hasPhoneViewport(page))
    checks.equal('starts on Messages', await selectedChannelTab(page), 'Messages')
    const frames = [await shot(page, 'phone-tab-switch', '00-messages')]

    const motion = await watchForMotion(page, { selectors: REGIONS, windowMs: WATCH_MS })
    const switched = clickChannelTab(page, 'Files')
    const observed = await watchForMotion(page, { selectors: REGIONS, windowMs: WATCH_MS })
    await switched

    checks.equal('ends on Files', await selectedChannelTab(page), 'Files')
    checks.ok(
      'no navigation layer animates on a tab switch',
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

    frames.push(await shot(page, 'phone-tab-switch', '01-files'))
    frames.push(await shot(page, 'phone-tab-switch', '02-settled'))
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'phone',
}
