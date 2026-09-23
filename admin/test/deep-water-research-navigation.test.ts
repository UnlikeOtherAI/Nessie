import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  KNOWLEDGE_RESEARCH_VIEW_PATH,
  RESEARCH_INTENT,
  researchBriefHref,
  researchConversationHref,
} from '../src/facades/deep-water/navigation.js'
import { matchSurface } from '../src/navigation/surfaces.js'
import { productDocumentsViewComponents } from '../src/components/features/knowledge/product-documents-registry.js'
import { DeepWaterResearchView } from '../src/components/features/knowledge/DeepWaterResearchView.js'

/**
 * Where a DeepWater research brief opens, as the real router addresses it
 * (Water plan nessie.md §7.7 doorways; docs/navigation/deep-links-and-headers.md).
 * `?research=<runId>` is linkable state on every screen that shows a brief
 * over itself — a conversation, one of its threads, a reply thread, the
 * Threads inbox and the Knowledge views — so a reload, Back and a shared link
 * land on the same brief; each of those routes mounts the one brief host; and
 * every composer a person posts from carries the Research button. The browser
 * suite (`e2e/research-brief/run.mjs`) walks the same addresses; this pins the
 * declarations and the wiring it cannot reach without the whole app.
 */

const ID = '11111111-1111-4111-8111-111111111111'
const CHANNEL = '22222222-2222-4222-8222-222222222222'
const THREAD = '33333333-3333-4333-8333-333333333333'
const ROOT = '44444444-4444-4444-8444-444444444444'

const SCREENS_WITH_A_BRIEF = [
  `/channels/${CHANNEL}`,
  `/channels/${CHANNEL}/threads/${THREAD}`,
  `/channels/${CHANNEL}/threads/${THREAD}/replies/${ROOT}`,
  '/threads',
  KNOWLEDGE_RESEARCH_VIEW_PATH,
]

const declaresResearch = (pathname: string): boolean => {
  const matched = matchSurface(pathname)
  assert.ok(matched, `${pathname} is a screen`)
  const intent = matched.surface.intent
  assert.equal(intent?.consume?.includes(RESEARCH_INTENT) ?? false, false, `${pathname}: ?research= is state, never consumed`)
  return intent?.state?.includes(RESEARCH_INTENT) ?? false
}

test('?research= is linkable state on every screen a brief opens over', () => {
  for (const pathname of SCREENS_WITH_A_BRIEF) {
    assert.equal(declaresResearch(pathname), true, `${pathname} declares ?research=`)
  }
  // The unread list shows no brief: it declares nothing it does not read.
  assert.equal(declaresResearch('/unread-messages'), false)
})

test('every address a doorway sends a brief to lands on a screen that reads it', () => {
  const inConversation = new URL(researchBriefHref({ id: ID, origin: { channelId: CHANNEL } }), 'https://app.example')
  assert.equal(inConversation.searchParams.get(RESEARCH_INTENT), ID)
  assert.equal(declaresResearch(inConversation.pathname), true)
  const nowhere = new URL(researchBriefHref({ id: ID, origin: { channelId: null } }), 'https://app.example')
  assert.equal(nowhere.pathname, KNOWLEDGE_RESEARCH_VIEW_PATH)
  assert.equal(declaresResearch(nowhere.pathname), true)
  // A new brief's question travels in router state to the conversation — and to its reply thread — which reads it.
  for (const rootMessageId of [null, ROOT]) {
    const href = researchConversationHref({ channelId: CHANNEL, rootMessageId, threadId: THREAD })
    assert.equal(declaresResearch(href), true, href)
    assert.equal(href.includes('?'), false, 'the question never goes in the address')
  }
})

const source = (path: string): string => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8')

test('each of those screens mounts the one brief host', () => {
  // The conversation, its threads and reply threads are all ChannelsPage; the inbox is ThreadsPage.
  const router = source('router.tsx')
  assert.match(router, /path: '\/channels',\s*element: <ChannelsPage \/>/)
  assert.match(router, /path: '\/threads', element: lazyElement\(ThreadsPage/)
  assert.match(source('pages/ChannelsPage.tsx'), /<ResearchBriefHost origin=\{researchOrigin\}>/)
  assert.match(source('pages/ThreadsPage.tsx'), /<ResearchBriefHost origin=\{null\}>/)
  // Knowledge › Research is the product view the Knowledge views route renders.
  assert.match(router, /path: '\/knowledge-base\/views\/:productView'/)
  assert.equal(productDocumentsViewComponents['deep-water-research'], DeepWaterResearchView)
  assert.equal(KNOWLEDGE_RESEARCH_VIEW_PATH, '/knowledge-base/views/deep-water-research')
})

test('every composer a person posts from carries the Research button, coming back where it posts', () => {
  const composers: Array<{ file: string; place: RegExp }> = [
    // The conversation's own composer: the screen's thread.
    { file: 'pages/channels/ChannelConversationSurface.tsx', place: /useResearchComposerButton\(composer\.message\)/ },
    // A reply thread: under its root.
    {
      file: 'components/features/channels/thread-panel/ThreadReplyPanel.tsx',
      place: /useResearchComposerButton\(message, \{ rootMessageId: openRootMessageId \}\)/,
    },
    // A person's DM drawer: that DM, not the room behind it.
    {
      file: 'components/features/channels/ChannelUserInfoDrawer.tsx',
      place: /useResearchComposerButton\(message, \{\s*origin: dmChannel\?\.defaultThreadId/,
    },
    // An agent's drawer: the conversation the drawer posts to.
    {
      file: 'components/features/channels/ChannelAgentInfoDrawer.tsx',
      place: /useResearchComposerButton\(message, \{\s*origin: activeChannel && activeThreadId/,
    },
    // A Threads inbox card: its reply thread.
    {
      file: 'pages/channels/ThreadInboxCard.tsx',
      place: /useResearchComposerButton\(composer\.message, \{\s*origin: \{[^}]*rootMessageId: activity\.rootMessageId/,
    },
  ]
  for (const { file, place } of composers) {
    const text = source(file)
    assert.match(text, place, `${file} opens a brief for the place it posts to`)
    assert.match(text, /<ChannelComposer[\s\S]*?researchButton=\{researchButton\}/, `${file} gives its composer the button`)
  }
})
