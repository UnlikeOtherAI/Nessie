// Phone, the interactive edge swipe: a touch that starts inside the left
// edge and travels inwards commits a Back, and the released settle carries
// both layers the rest of the way. Its start poses come from where the
// finger lifted, so the expected travel is computed from the released
// displacement rather than assumed.
import { clickChannelRow, edgeSwipe, gotoChannels } from '../lib/page.mjs'
import { waitForStackSettled } from '../lib/freeze.mjs'
import { captureTransition } from '../lib/transition.mjs'

const SWIPE = { from: 8, steps: 6, to: 300, y: 420 }
// The lower layer's resting offset, mirrored from --nav-parallax.
const PARALLAX = 0.28

export const phoneEdgeSwipe = {
  name: 'phone-edge-swipe',
  run: async ({ page, seed }) => captureTransition({
    caseName: 'phone-edge-swipe',
    page,
    prepare: async (target) => {
      await gotoChannels(target)
      await waitForStackSettled(target)
      await clickChannelRow(target, seed.channels[1].slug)
      await target.waitForSelector('button[aria-label="Back to Channels"]', { timeout: 30_000 })
    },
    // The released position is a touch coordinate, not a layout constant:
    // allow it a little more room than a scripted push.
    tolerance: 0.03,
    travels: ({ measurement, triggered }) => {
      const width = measurement.frames[0]?.viewportWidth || 1
      const released = Math.min(1, Math.max(0, triggered.dx / width))
      return [
        { from: released, label: 'released detail', to: 1 },
        { from: -(1 - released) * PARALLAX, label: 'revealed list', to: 0 },
      ]
    },
    trigger: async (target) => ({ dx: await edgeSwipe(target, SWIPE) }),
  }),
  viewport: 'phone',
}
