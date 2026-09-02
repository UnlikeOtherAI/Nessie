// Phone, a link that carries an instruction: `#trigger-<id>` on the Triggers
// browser and `?messageId=` on a conversation are consumed intents
// (docs/navigation.md §8). Each is read once and stripped with a replacing
// redirect, so the address the person stands on — and the one Back returns
// to — is the screen, never the instruction.
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

    await gotoPath(page, '/channels')
    await pushPath(page, '/agents/triggers#trigger-does-not-matter')
    checks.equal(
      `${caseName}: the trigger anchor is consumed and stripped`,
      await waitForLocation(page, '/agents/triggers'),
      '/agents/triggers',
    )
    await shot(page, caseName, 'triggers-after-strip')

    const conversation = `/channels/${seed.channels[0].id}`
    await pushPath(page, `${conversation}?messageId=00000000-0000-4000-8000-000000000001&tab=files`)
    checks.equal(
      `${caseName}: the message intent is stripped and the linkable tab stays`,
      await waitForLocation(page, `${conversation}?tab=files`),
      `${conversation}?tab=files`,
    )
    await shot(page, caseName, 'conversation-after-strip')

    // Replaced, not pushed: browser Back lands on the stripped Triggers
    // address, not on the pre-strip one.
    await page.goBack({ waitUntil: 'commit' }).catch(() => undefined)
    checks.equal(
      `${caseName}: Back returns to the stripped address`,
      await waitForLocation(page, '/agents/triggers'),
      '/agents/triggers',
    )

    checks.close()
    return { checks: checks.checks, frames: [] }
  },
  viewport: 'phone',
}
