// Phone, a cold deep link: the stack seeds the registry's parent chain
// beneath the landed screen (docs/navigation.md §8), so header Back slides
// the conversation away over the channel list a real navigation would have
// left there.
import { createChecks } from '../lib/expect.mjs'
import { clickBackTo, gotoPath } from '../lib/page.mjs'
import { captureTransition } from '../lib/transition.mjs'

export const phoneColdStart = {
  name: 'phone-cold-start',
  run: async ({ page, seed }) => {
    const caseName = 'phone-cold-start'
    const checks = createChecks(caseName)
    const result = await captureTransition({
      caseName,
      page,
      prepare: async (target) => {
        await gotoPath(target, `/channels/${seed.channels[0].id}`)
        const layers = await target.evaluate(() => [...document.querySelectorAll('[data-phone-navigation-layer]')]
          .map((el) => `${el.getAttribute('data-phone-navigation-layer')}=${el.getAttribute('data-phone-navigation-route')}`))
        checks.ok(
          `${caseName}: the seeded channel list rests beneath the cold-started conversation`,
          layers.includes('underlay=root:channels:/channels') && layers.includes('current=channels:channel'),
          layers.join(', '),
        )
      },
      travels: [
        { from: 0, label: 'leaving conversation', to: 1 },
        { from: -0.28, label: 'revealing channel list', to: 0 },
      ],
      trigger: (target) => clickBackTo(target, 'Back to Channels'),
    })
    checks.close()
    return { checks: [...result.checks, ...checks.checks], frames: result.frames }
  },
  viewport: 'phone',
}
