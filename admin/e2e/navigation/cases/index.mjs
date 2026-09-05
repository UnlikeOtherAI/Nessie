import { phoneBack } from './phone-back.mjs'
import { phoneEdgeSwipe } from './phone-edge-swipe.mjs'
import { phonePush } from './phone-push.mjs'
import { phoneTabSwitch } from './phone-tab-switch.mjs'
import { phoneBoardSwitch } from './phone-board-switch.mjs'
import { desktopSelect, tabletSelect } from './wide-select.mjs'
import { desktopSplitPush, tabletSplitPush } from './split-push.mjs'
import { phoneColdStart } from './phone-cold-start.mjs'
import { phoneIntentStrip } from './phone-intent-strip.mjs'
import { desktopChatHistory } from './desktop-chat-history.mjs'
import { desktopDashboardExit } from './desktop-dashboard-exit.mjs'
import { desktopKnowledgeCrossNavigation } from './desktop-knowledge-cross-navigation.mjs'
import { desktopDashboardLiveWorkspace } from './desktop-dashboard-live-workspace.mjs'

export const CASES = [
  phonePush,
  phoneBack,
  phoneEdgeSwipe,
  phoneTabSwitch,
  phoneBoardSwitch,
  tabletSelect,
  desktopSelect,
  tabletSplitPush,
  desktopSplitPush,
  phoneColdStart,
  phoneIntentStrip,
  desktopChatHistory,
  desktopDashboardExit,
  desktopKnowledgeCrossNavigation,
  desktopDashboardLiveWorkspace,
]
