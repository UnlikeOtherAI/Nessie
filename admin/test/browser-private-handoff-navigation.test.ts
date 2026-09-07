import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('a temporary login card opens the routed browser with its exact thread on phone and desktop', () => {
  const card = readSource('../src/components/features/channels/AgentCardMessage.tsx')
  const channels = readSource('../src/pages/ChannelsPage.tsx')

  assert.match(
    card,
    /navigate\(`\/channels\/\$\{channelId\}\/tools\/browser\?threadId=\$\{encodeURIComponent\(card\.threadId\)\}`\)/,
  )
  assert.match(channels, /const routedBrowserThreadId = routeTool === 'browser'/)
  assert.match(channels, /searchParams\.get\('threadId'\)/)
  assert.match(channels, /threadId=\{browserThreadId \?\? null\}/)
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
