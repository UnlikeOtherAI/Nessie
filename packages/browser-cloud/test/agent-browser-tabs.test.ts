import assert from 'node:assert/strict'
import test from 'node:test'

import type { CdpClient } from '../src/cdp-client.js'
import {
  AGENT_BROWSER_TAB_LIMIT,
  restoreBrowserTabs,
  SCREENSHOT_MAX_BYTES,
  snapshotBrowserTabs,
} from '../src/agent-browser-tabs.js'

/**
 * A CDP client that answers the four calls a capture and a restore make, and
 * records every call so the tests can say what the browser was asked to do.
 */
const fakeCdp = (input: {
  pages: Array<{ targetId: string; url: string; title: string }>
  screenshotBytes?: (targetId: string, quality: number) => number | null
  failScreenshotFor?: string
}) => {
  const calls: Array<{
    method: string
    params: Record<string, unknown> | undefined
    sessionId: string | null | undefined
  }> = []
  const attached = new Map<string, string>()
  let nextSession = 1
  const client: CdpClient = {
    call: async (method, params, options) => {
      calls.push({ method, params, sessionId: options?.sessionId })
      if (method === 'Target.attachToTarget') {
        const targetId = String(params?.targetId)
        const sessionId = `s${nextSession++}`
        attached.set(sessionId, targetId)
        return { sessionId }
      }
      if (method === 'Target.detachFromTarget') return {}
      if (method === 'Page.captureScreenshot') {
        const targetId = attached.get(String(options?.sessionId)) ?? ''
        if (targetId === input.failScreenshotFor) throw new Error('capture failed')
        const quality = Number(params?.quality)
        const size = input.screenshotBytes?.(targetId, quality) ?? 1000
        if (size === null) return {}
        return { data: Buffer.alloc(size, 1).toString('base64') }
      }
      if (method === 'Page.navigate' || method === 'Target.createTarget') return {}
      throw new Error(`unexpected ${method}`)
    },
    pageSessionId: () => 'page',
    attachToPage: async () => 'page',
    targets: async () => input.pages.map((page) => ({ ...page, type: 'page' })),
    close: () => undefined,
    closed: new Promise(() => undefined),
  }
  return { client, calls }
}

test('a snapshot keeps every real page in order, with a picture each', async () => {
  const { client, calls } = fakeCdp({
    pages: [
      { targetId: 't1', url: 'https://a.example/x', title: 'A' },
      { targetId: 't2', url: 'about:blank', title: '' },
      { targetId: 't3', url: 'https://b.example/y', title: 'B' },
    ],
  })
  const tabs = await snapshotBrowserTabs(client)
  assert.deepEqual(
    tabs.map((tab) => [tab.position, tab.url, tab.title, tab.screenshotMime]),
    [[0, 'https://a.example/x', 'A', 'image/jpeg'], [1, 'https://b.example/y', 'B', 'image/jpeg']],
  )
  assert.ok(tabs.every((tab) => tab.screenshot && tab.screenshot.byteLength === 1000))
  // Each page was attached to for its picture and let go again, so the
  // client's own page attachment — the one the agent drives — is untouched.
  const attaches = calls.filter((call) => call.method === 'Target.attachToTarget')
  const detaches = calls.filter((call) => call.method === 'Target.detachFromTarget')
  assert.equal(attaches.length, 2)
  assert.equal(detaches.length, 2)
  assert.ok(calls.every((call) => call.method !== 'Page.captureScreenshot' || typeof call.sessionId === 'string'))
})

test('a page whose picture fails keeps its address', async () => {
  const { client } = fakeCdp({
    pages: [
      { targetId: 't1', url: 'https://a.example', title: 'A' },
      { targetId: 't2', url: 'https://b.example', title: 'B' },
    ],
    failScreenshotFor: 't1',
  })
  const tabs = await snapshotBrowserTabs(client)
  assert.equal(tabs.length, 2)
  assert.equal(tabs[0]?.screenshot, null)
  assert.equal(tabs[0]?.url, 'https://a.example')
  assert.ok(tabs[1]?.screenshot)
})

test('an oversized picture is retried at lower quality, then dropped', async () => {
  const { client, calls } = fakeCdp({
    pages: [{ targetId: 't1', url: 'https://a.example', title: 'A' }],
    // Too big at 55, fine at 30.
    screenshotBytes: (_target, quality) => (quality > 40 ? SCREENSHOT_MAX_BYTES + 1 : 500),
  })
  const [tab] = await snapshotBrowserTabs(client)
  assert.equal(tab?.screenshot?.byteLength, 500)
  const qualities = calls
    .filter((call) => call.method === 'Page.captureScreenshot')
    .map((call) => call.params?.quality)
  assert.deepEqual(qualities, [55, 30])

  const stubborn = fakeCdp({
    pages: [{ targetId: 't1', url: 'https://a.example', title: 'A' }],
    screenshotBytes: () => SCREENSHOT_MAX_BYTES + 1,
  })
  const [big] = await snapshotBrowserTabs(stubborn.client)
  assert.equal(big?.screenshot, null)
  assert.equal(big?.url, 'https://a.example')
})

test('the tab limit holds', async () => {
  const pages = Array.from({ length: AGENT_BROWSER_TAB_LIMIT + 5 }, (_, index) => ({
    targetId: `t${index}`,
    url: `https://site${index}.example`,
    title: `Site ${index}`,
  }))
  const { client } = fakeCdp({ pages })
  const tabs = await snapshotBrowserTabs(client, { withScreenshots: false })
  assert.equal(tabs.length, AGENT_BROWSER_TAB_LIMIT)
  assert.ok(tabs.every((tab) => tab.screenshot === null))
})

test('a restore puts the first tab in the driven page and the rest behind it', async () => {
  const { client, calls } = fakeCdp({ pages: [] })
  const restored = await restoreBrowserTabs(client, [
    { url: 'https://first.example' },
    { url: 'https://second.example' },
    { url: 'https://third.example' },
  ])
  assert.equal(restored, 3)
  assert.deepEqual(
    calls.map((call) => [call.method, call.params?.url, call.params?.background ?? null]),
    [
      ['Page.navigate', 'https://first.example', null],
      ['Target.createTarget', 'https://second.example', true],
      ['Target.createTarget', 'https://third.example', true],
    ],
  )
  assert.equal(await restoreBrowserTabs(client, []), 0)
})
