import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('a temporary login card opens the routed browser with its exact thread on phone and desktop', () => {
  const card = readSource('../src/components/features/channels/AgentCardMessage.tsx')
  const channels = readSource('../src/pages/ChannelsPage.tsx')
  const messageSurface = readSource('../src/pages/channels/useChannelMessageSurface.ts')

  assert.match(
    card,
    /navigate\(`\/channels\/\$\{channelId\}\/tools\/browser\?threadId=\$\{encodeURIComponent\(card\.threadId\)\}`\)/,
  )
  // The message-surface controller owns the thread choice. A browser route's
  // explicit thread wins, then an open reply, then the channel conversation.
  const browserThreadSelection = [
    "const browserThreadId = \\(routeTool === 'browser'",
    "\\? searchParams\\.get\\('threadId'\\) : null\\)",
    '\\?\\? replyThread\\.activeThreadId',
    '\\?\\? activeThreadId',
  ].join('\\s*')
  assert.match(
    messageSurface,
    new RegExp(browserThreadSelection),
  )
  // The page is still the route composition boundary and sends the resolved
  // thread to the dock; moving the controller must not drop the route value.
  assert.match(channels, /threadId=\{messageSurface\.browserThreadId \?\? null\}/)
})

test('Done retires the claim intent and never lets an adopted run auto-reclaim control', () => {
  const panel = readSource('../src/components/features/browser-cloud/AgentScreenPanel.tsx')
  const viewer = readSource('../src/components/features/browser-cloud/AgentScreenViewer.tsx')

  assert.match(
    panel,
    /const finishHandover = \(\) => \{\s*setClaimForPerson\(false\)\s*overlay\.requestClose\(\)/,
  )
  assert.match(
    viewer,
    /const shouldClaim = session\.data\?\.canControl === true\s*&& session\.data\?\.runId === null\s*&& claimOnLive/,
  )
  assert.doesNotMatch(viewer, /claimOnLive \|\| Boolean\(session\.data\?\.privateAccess\)/)
})
