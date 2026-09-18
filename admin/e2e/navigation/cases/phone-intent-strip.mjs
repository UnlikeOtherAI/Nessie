// Phone navigation keeps a trigger's own address in the route while consuming
// a one-shot conversation message intent (docs/navigation/overview.md §8).
// The trigger screen survives Back and reload; the message pointer is read
// once and stripped, leaving only the reader-selected tab.
//
// A trigger used to be the list's `?trigger=` selection; it is its own route
// now, which is what this case walks. The old address still has to work — a
// bookmark or an older notification holds it — so the forward is proved first.
import { createChecks } from '../lib/expect.mjs'
import { gotoPath, pushPath, shot } from '../lib/page.mjs'

const readLocation = (page) => page.evaluate(() => (
  `${window.location.pathname}${window.location.search}${window.location.hash}`
))

const waitForLocation = async (page, expected) => {
  await page.waitForFunction(
    (target) => `${window.location.pathname}${window.location.search}${window.location.hash}` === target,
    expected,
    { timeout: 15_000 },
  ).catch(() => undefined)
  return readLocation(page)
}

export const phoneIntentStrip = {
  name: 'phone-intent-strip',
  run: async ({ page, seed }) => {
    const caseName = 'phone-intent-strip'
    const checks = createChecks(caseName)
    const triggerId = 'does-not-matter'

    await gotoPath(page, '/channels')
    await pushPath(page, `/agents/triggers?trigger=${triggerId}`)
    checks.equal(
      `${caseName}: the old selection address forwards to the trigger's own screen`,
      await waitForLocation(page, `/agents/triggers/${triggerId}`),
      `/agents/triggers/${triggerId}`,
    )
    await shot(page, caseName, 'triggers-with-selection')

    const conversation = `/channels/${seed.channels[0].id}`
    await pushPath(page, `${conversation}?messageId=00000000-0000-4000-8000-000000000001&tab=files`)
    checks.equal(
      `${caseName}: the message intent is stripped and the linkable tab stays`,
      await waitForLocation(page, `${conversation}?tab=files`),
      `${conversation}?tab=files`,
    )
    await shot(page, caseName, 'conversation-after-strip')

    // Back returns to the exact trigger, rather than a generic list where the
    // person must rediscover the recovery control. The forward replaced the
    // `?trigger=` entry, so there is nothing superseded to land on.
    await page.goBack({ waitUntil: 'commit' }).catch(() => undefined)
    checks.equal(
      `${caseName}: Back returns to the trigger's own screen`,
      await waitForLocation(page, `/agents/triggers/${triggerId}`),
      `/agents/triggers/${triggerId}`,
    )

    checks.close()
    return { checks: checks.checks, frames: [] }
  },
  viewport: 'phone',
}
