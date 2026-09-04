import { phoneBack } from './phone-back.mjs'
import { phoneEdgeSwipe } from './phone-edge-swipe.mjs'
import { phonePush } from './phone-push.mjs'
import { phoneTabSwitch } from './phone-tab-switch.mjs'
import { desktopSelect, tabletSelect } from './wide-select.mjs'
import { desktopSplitPush, tabletSplitPush } from './split-push.mjs'
import { phoneColdStart } from './phone-cold-start.mjs'
import { phoneIntentStrip } from './phone-intent-strip.mjs'
import { desktopChatHistory } from './desktop-chat-history.mjs'

export const CASES = [
  phonePush,
  phoneBack,
  phoneEdgeSwipe,
  phoneTabSwitch,
  tabletSelect,
  desktopSelect,
  tabletSplitPush,
  desktopSplitPush,
  phoneColdStart,
  phoneIntentStrip,
  desktopChatHistory,
]
