// Phone, the header Back button: the conversation slides off to the right
// and the list returns from -28 % to rest. The exact reverse of the push,
// and the frame that showed the bounce — the list used to land short.
import { clickBackTo, clickChannelRow, gotoChannels } from '../lib/page.mjs'
import { waitForStackSettled } from '../lib/freeze.mjs'
import { captureTransition } from '../lib/transition.mjs'

const BACK_LABEL = 'Back to Channels'

export const phoneBack = {
  name: 'phone-back',
  run: async ({ page, seed }) => captureTransition({
    caseName: 'phone-back',
    page,
    prepare: async (target) => {
      await gotoChannels(target)
      await waitForStackSettled(target)
      await clickChannelRow(target, seed.channels[0].slug)
      await target.waitForSelector(`button[aria-label="${BACK_LABEL}"]`, { timeout: 30_000 })
    },
    travels: [
      { from: 0, label: 'leaving conversation', to: 1 },
      { from: -0.28, label: 'returning list', to: 0 },
    ],
    trigger: (target) => clickBackTo(target, BACK_LABEL),
  }),
  viewport: 'phone',
}
