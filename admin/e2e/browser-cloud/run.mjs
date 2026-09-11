import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { REPO_ROOT } from '../navigation/lib/config.mjs'
import { call, seedTeam } from '../navigation/lib/seed.mjs'
import { startAdmin, startApi } from '../navigation/lib/servers.mjs'

const SESSION_ID = '00000000-0000-4000-8000-000000000002'
const ADMIN_URL = 'http://localhost:5455'
const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/browser-cloud')
// A real PNG keeps the canvas image path browser-native without a provider URL.
const FRAME = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J7YkAAAAASUVORK5CYII='

const json = (route, data, status = 200) => route.fulfill({
  body: JSON.stringify({ data }), contentType: 'application/json', status,
})

const createPrivateAgent = (token, name) => call('/api/agents', {
  body: { name, role: 'browser tester', visibility: 'private' }, method: 'POST', token,
})

const grantBrowser = async (token, agentId) => {
  const tools = await call('/api/mcp/tools', { token })
  const browser = tools.find((tool) => tool.toolId === 'browser_open')
  assert.ok(browser, 'browser_open was not registered')
  await call(`/api/mcp/tools/${browser.id}/policy-targets/${agentId}`, {
    body: { enabled: true }, method: 'PATCH', token,
  })
  const agents = await call('/api/agents', { token })
  const agent = agents.find((candidate) => candidate.id === agentId)
  assert.equal(agent?.browserEnabled, true, 'a persisted browser_open grant must project browserEnabled')
}

const detail = (fixture, state) => ({
  agentId: fixture.agentId,
  agentName: fixture.agentName,
  canControl: state.canControl ?? true,
  controlLeaseActive: state.leaseActive ?? state.controller,
  controlledByUserId: state.controller ? fixture.userId : null,
  endedAt: null,
  expiresAt: '2036-09-07T12:00:00.000Z',
  id: SESSION_ID,
  liveViewUrl: null,
  runId: null,
  shared: false,
  startedAt: '2036-09-07T11:00:00.000Z',
  status: 'active',
  tabs: [],
  viewerMode: state.controller && (state.leaseActive ?? state.controller) ? 'controller' : 'observer',
  viewport: { height: 800, width: 1280 },
})

const installMediatedFixture = async (page, fixture, state) => {
  await page.route('**/api/threads/**/browser-sessions?active=1', (route) => json(route, {
    sessions: [{
      agentId: fixture.agentId, agentName: fixture.agentName,
      controlledByUserId: state.controller ? fixture.userId : null,
      endedAt: null, id: SESSION_ID, runId: null,
      startedAt: '2036-09-07T11:00:00.000Z', status: 'active',
    }],
  }))
  await page.route(`**/api/browser-sessions/${SESSION_ID}`, (route) => json(route, detail(fixture, state)))
  await page.route(`**/api/browser-sessions/${SESSION_ID}/screenshot`, (route) => json(route, { imageDataUrl: FRAME }))
  await page.route(`**/api/browser-sessions/${SESSION_ID}/control`, (route) => {
    if (route.request().method() === 'POST') state.controller = true
    return route.fulfill({ status: 204 })
  })
  await page.route(`**/api/browser-sessions/${SESSION_ID}/home`, (route) => {
    state.homeRequests = (state.homeRequests ?? 0) + 1
    if (state.homeFailure) {
      return route.fulfill({
        body: JSON.stringify({ error: { message: 'Home is unavailable' } }),
        contentType: 'application/json', status: 502,
      })
    }
    return json(route, { url: 'https://example.test/home' })
  })
}

// The canvas uses a WebSocket for human gestures. This browser-native fake
// leaves every other realtime socket alone and lets the mobile case prove the
// client emits the closed grammar in the order a person used it.
const installCanvasSocket = async (context) => context.addInitScript((frame) => {
  const NativeWebSocket = window.WebSocket
  class CanvasSocket {
    static CLOSED = 3
    static OPEN = 1

    constructor(url) {
      if (!String(url).includes('/canvas')) return new NativeWebSocket(url)
      this.readyState = CanvasSocket.OPEN
      this.listeners = new Map()
      window.setTimeout(() => this.emit('message', {
        data: JSON.stringify({
          imageDataUrl: frame,
          pageUrl: 'https://example.test/',
          tabs: [],
          type: 'frame',
          viewport: { height: 844, width: 390 },
        }),
      }), 0)
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? []
      listeners.push(listener)
      this.listeners.set(type, listeners)
    }

    close() {
      this.readyState = CanvasSocket.CLOSED
      this.emit('close', { code: 1000 })
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event)
    }

    send(payload) {
      const inputs = window.__browserCanvasInputs ?? []
      inputs.push(JSON.parse(payload))
      window.__browserCanvasInputs = inputs
    }
  }
  window.WebSocket = CanvasSocket
}, FRAME)

// A policy event only exercises stale mounted UI after the channel has added
// its scope to the shared activity socket. Wait for the server's exact
// subscription acknowledgement instead of racing React's initial render.
const waitForChannelRealtimeSubscription = (page, channelId, timeoutMs = 10_000) => new Promise((resolve, reject) => {
  let done = false
  const finish = (error) => {
    if (done) return
    done = true
    clearTimeout(timeout)
    page.off('websocket', onSocket)
    if (error) reject(error)
    else resolve()
  }
  const onSocket = (socket) => {
    if (new URL(socket.url()).pathname !== '/api/activity') return
    socket.on('framereceived', ({ payload }) => {
      try {
        const message = JSON.parse(payload)
        if (
          message.type === 'subscribed'
          && message.scopes?.some((scope) => scope.kind === 'channel' && scope.channelId === channelId)
        ) {
          finish()
        }
      } catch {
        // Frames for the shared socket are schema-validated by the app. A
        // malformed frame cannot establish the test's subscription boundary.
      }
    })
  }
  const timeout = setTimeout(
    () => finish(new Error(`activity socket did not subscribe to channel ${channelId}`)),
    timeoutMs,
  )
  page.on('websocket', onSocket)
})

const main = async () => {
  const api = await startApi()
  await startAdmin()
  const browser = await launchBrowser()
  try {
    const seed = await seedTeam(api)
    const agent = await createPrivateAgent(seed.token, 'Browser grant gate E2E')
    assert.ok(agent.homeChannelId, 'private agent creation did not provision its home DM')
    await rm(screenshots, { force: true, recursive: true })
    await mkdir(screenshots, { recursive: true })
    const context = await browser.newContext({ viewport: { height: 900, width: 1440 } })
    await context.addInitScript(([key, value]) => window.localStorage.setItem(key, value), ['nessie.admin.token', seed.token])

    // Browser access follows the agent's explicit grant, never its name,
    // connection, or home DM. A second API client changes the policy while
    // this mounted client listens for agent.updated: no reload may preserve
    // a stale Browser doorway after revoke.
    {
      const page = await context.newPage()
      const subscription = waitForChannelRealtimeSubscription(page, agent.homeChannelId)
      await page.goto(`${ADMIN_URL}/channels/${agent.homeChannelId}`, { waitUntil: 'domcontentloaded' })
      await subscription
      const browserDoor = page.getByRole('button', { name: 'Browser', exact: true })
      assert.equal(await browserDoor.count(), 0, 'an ungranted agent must not expose a browser doorway')
      await page.goto(`${ADMIN_URL}/agents/${agent.id}?agentTab=tools`, { waitUntil: 'domcontentloaded' })
      await page.getByRole('tab', { name: 'Tools', exact: true }).waitFor()
      await page.getByText('Loading tools…', { exact: true }).waitFor({ state: 'hidden' })
      await page.getByText(
        'Project and cloud-browser access are granted explicitly here. Connected apps are managed on Apps.',
        { exact: true },
      ).waitFor()
      assert.equal(
        await page.getByText('Couldn’t load this agent’s browser.', { exact: true }).count(),
        0,
        'an ungranted agent must not render its correctly-refused browser read as an error',
      )
      await page.screenshot({ fullPage: true, path: resolve(screenshots, 'agent-tools-no-browser-grant.png') })
      await grantBrowser(seed.token, agent.id)
      await page.goto(`${ADMIN_URL}/channels/${agent.homeChannelId}`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Browser'),
      null, { timeout: 10_000 })
      await call('/api/mcp/tools', { token: seed.token }).then(async (tools) => {
        const browserTool = tools.find((tool) => tool.toolId === 'browser_open')
        assert.ok(browserTool)
        await call(`/api/mcp/tools/${browserTool.id}/policy-targets/${agent.id}`, {
          body: { enabled: false }, method: 'PATCH', token: seed.token,
        })
      })
      await page.waitForFunction(() =>
        ![...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Browser'),
      null, { timeout: 10_000 })
      await grantBrowser(seed.token, agent.id)
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Browser'),
      null, { timeout: 10_000 })
      const state = { canControl: false, controller: false }
      const fixture = {
        agentId: agent.id,
        agentName: agent.name,
        channelId: agent.homeChannelId,
        userId: '00000000-0000-4000-8000-000000000001',
      }
      await installMediatedFixture(page, fixture, state)
      await page.getByRole('button', { name: 'Browser', exact: true }).click()
      await page.getByLabel(`${fixture.agentName} browser`).waitFor()
      await page.getByAltText('Current remote browser screen').waitFor()
      assert.equal(await page.locator('iframe').count(), 0, 'a provider iframe leaked into the observer surface')
      await page.getByText('View only.', { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Take control' }).count(), 0,
        'a team observer must not receive a human-control doorway')
      await page.screenshot({ fullPage: true, path: resolve(screenshots, 'fullscreen-observer.png') })
      await page.close()

      // A separate fresh page follows the exact same grant path and proves
      // that an HTTP screenshot never becomes an interactive fallback.
      const controllerContext = await browser.newContext({ viewport: { height: 900, width: 1440 } })
      await controllerContext.addInitScript(([key, value]) => window.localStorage.setItem(key, value), ['nessie.admin.token', seed.token])
      const controllerPage = await controllerContext.newPage()
      const controllerAgent = await createPrivateAgent(seed.token, 'Browser preview control E2E')
      const controllerSubscription = waitForChannelRealtimeSubscription(controllerPage, controllerAgent.homeChannelId)
      await controllerPage.goto(`${ADMIN_URL}/channels/${controllerAgent.homeChannelId}`, { waitUntil: 'domcontentloaded' })
      await controllerSubscription
      await grantBrowser(seed.token, controllerAgent.id)
      await controllerPage.waitForFunction(() =>
        [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Browser'),
      null, { timeout: 10_000 })
      const controllerState = { controller: false }
      await installMediatedFixture(controllerPage, {
        agentId: controllerAgent.id,
        agentName: controllerAgent.name,
        channelId: controllerAgent.homeChannelId,
        userId: '00000000-0000-4000-8000-000000000001',
      }, controllerState)
      await controllerPage.getByRole('button', { name: 'Browser', exact: true }).click()
      await controllerPage.getByRole('button', { name: 'Take control' }).click()
      await controllerPage.getByRole('button', { name: 'Reconnect' }).waitFor()
      assert.equal(await controllerPage.getByRole('application').count(), 0, 'an HTTP preview must not accept browser input')
      assert.equal(await controllerPage.getByLabel('Browser keyboard').isDisabled(), true)
      await controllerPage.screenshot({ fullPage: true, path: resolve(screenshots, 'fullscreen-preview-only.png') })
      await controllerContext.close()

    }

    // The same routed surface fills a 390px phone and forwards tap-to-keyboard input.
    {
      const phone = await browser.newContext({ hasTouch: true, viewport: { height: 844, width: 390 } })
      try {
        await phone.addInitScript(([key, value]) => window.localStorage.setItem(key, value), ['nessie.admin.token', seed.token])
        const page = await phone.newPage()
        const mobileAgent = await createPrivateAgent(seed.token, 'Mobile browser grant E2E')
        assert.ok(mobileAgent.homeChannelId, 'mobile private agent creation did not provision its home DM')
        const mobileSubscription = waitForChannelRealtimeSubscription(page, mobileAgent.homeChannelId)
        await page.goto(`${ADMIN_URL}/channels/${mobileAgent.homeChannelId}`, { waitUntil: 'domcontentloaded' })
        await mobileSubscription
        assert.equal(await page.getByRole('button', { name: 'Browser', exact: true }).count(), 0)
        await grantBrowser(seed.token, mobileAgent.id)
        // The phone's doorway is the compact header action: its name is its
        // `aria-label`, not its text, so ask for the accessible name — visible
        // only, so the header's hidden measuring copy cannot answer for it.
        await page.getByRole('button', { name: 'Browser', exact: true }).first()
          .waitFor({ state: 'visible', timeout: 10_000 })
        const state = { controller: false, homeFailure: true }
        const fixture = {
          agentId: mobileAgent.id,
          agentName: mobileAgent.name,
          channelId: mobileAgent.homeChannelId,
          userId: '00000000-0000-4000-8000-000000000001',
        }
        await installMediatedFixture(page, fixture, state)
        // The temporary-login card leaves its reply/dashboard context for the
        // existing Browser route, carrying the card's exact thread. A phone
        // must reach the same full-width panel after that navigation without
        // needing a second rail press.
        const cardThreadId = '00000000-0000-4000-8000-000000000003'
        await installCanvasSocket(phone)
        await page.goto(
          `${ADMIN_URL}/channels/${mobileAgent.homeChannelId}/tools/browser?threadId=${cardThreadId}`,
          { waitUntil: 'domcontentloaded' },
        )
        assert.match(page.url(), new RegExp(`/tools/browser\\?threadId=${cardThreadId}$`))
        await page.getByLabel(`${fixture.agentName} browser`).waitFor()
        await page.getByRole('button', { name: 'Full screen', exact: true }).click()
        await page.getByRole('button', { name: 'Home' }).waitFor()
        assert.equal(await page.getByRole('button', { name: 'Home' }).isDisabled(), true,
          'an observer preview must not request or navigate Home')
        await page.getByRole('dialog', { name: 'Browser' })
          .getByRole('button', { name: 'Exit full screen', exact: true }).click()
        await page.getByRole('button', { name: 'Take control' }).click()
        await page.getByRole('button', { name: 'Full screen', exact: true }).click()
        const canvas = page.getByRole('application')
        await canvas.waitFor()
        await page.getByRole('button', { name: 'Home' }).click()
        await page.waitForFunction(() => {
          const home = [...document.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === 'Home')
          return home instanceof HTMLButtonElement && !home.disabled
        })
        assert.equal(await page.evaluate(() =>
          (window.__browserCanvasInputs ?? []).some(({ input }) => input?.type === 'navigate'),
        ), false, 'a failed home lookup must not send navigation to the canvas')
        state.homeFailure = false
        await page.getByRole('button', { name: 'Home' }).click()
        await page.waitForFunction(() =>
          (window.__browserCanvasInputs ?? []).some(({ input }) =>
            input?.type === 'navigate' && input.url === 'https://example.test/home'),
        )
        await canvas.dispatchEvent('pointerdown', { clientX: 150, clientY: 280, pointerType: 'touch' })
        await canvas.dispatchEvent('pointermove', { clientX: 150, clientY: 180, pointerType: 'touch' })
        await canvas.dispatchEvent('pointerup', { clientX: 150, clientY: 180, pointerType: 'touch' })
        // A new touch begins a new gesture. It must not be consumed by the
        // previous drag's suppressed synthetic click.
        await canvas.dispatchEvent('pointerdown', { clientX: 195, clientY: 210, pointerType: 'touch' })
        await canvas.dispatchEvent('pointerup', { clientX: 195, clientY: 210, pointerType: 'touch' })
        await canvas.dispatchEvent('click', { clientX: 195, clientY: 210 })
        await page.getByLabel('Browser keyboard').fill('Nessie browser QA', { force: true })
        await page.waitForFunction(() => {
          const inputs = window.__browserCanvasInputs ?? []
          return inputs.some(({ input }) => input?.type === 'scroll')
            && inputs.some(({ input }) => input?.type === 'click')
            && inputs.some(({ input }) => input?.type === 'text' && input.text === 'Nessie browser QA')
        })
        await page.getByRole('dialog', { name: 'Browser' })
          .getByRole('button', { name: 'Exit full screen', exact: true }).click()
        const panel = page.locator('aside[aria-label="Browser"]')
        const box = await panel.boundingBox()
        assert.ok(box && Math.abs(box.width - 390) < 1, `phone browser should fill 390px, got ${box?.width ?? 'none'}`)
        assert.equal(await page.getByRole('application').count(), 1, 'the current controller can use the live canvas')
        await page.screenshot({ fullPage: true, path: resolve(screenshots, 'mobile-390-mediated.png') })
        await page.close()
      } finally {
        await phone.close()
      }
    }
    await context.close()
  } finally {
    await browser.close()
  }
}

await main()
