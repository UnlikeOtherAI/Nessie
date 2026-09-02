// Phone, tapping a channel row: the conversation pushes in from the right
// over the list, which parallaxes to -28 %.
import { clickChannelRow, gotoChannels } from '../lib/page.mjs'
import { captureTransition } from '../lib/transition.mjs'

export const phonePush = {
  name: 'phone-push',
  run: async ({ page, seed }) => captureTransition({
    caseName: 'phone-push',
    page,
    prepare: gotoChannels,
    travels: [
      { from: 1, label: 'entering conversation', to: 0 },
      { from: 0, label: 'parallaxing list', to: -0.28 },
    ],
    trigger: (target) => clickChannelRow(target, seed.channels[0].slug),
  }),
  viewport: 'phone',
}
