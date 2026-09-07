import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { REPO_ROOT } from '../navigation/lib/config.mjs'
import { call, seedTeam } from '../navigation/lib/seed.mjs'
import { startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'

const SESSION_ID = 'browser-cloud-live-view-e2e'
const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/browser-cloud')
const ADMIN_URL = 'http://localhost:5455'

const detail = ({ agentId, agentName, liveViewUrl, status = 'active' }) => ({
  agentId, agentName, controlledByUserId: null,
  endedAt: status === 'released' ? '2036-09-07T12:00:00.000Z' : null,
  expiresAt: '2036-09-07T12:00:00.000Z', id: SESSION_ID, liveViewUrl, runId: null,
  shared: false, startedAt: '2036-09-07T11:00:00.000Z', status, tabs: [],
  viewport: { height: 800, width: 1280 },
})

const json = (route, data, status = 200) => route.fulfill({
  body: JSON.stringify({ data }), contentType: 'application/json', status,
})

const openViewer = async (page, fixture, { fullscreen = true, mobile = false } = {}) => {
  await page.addInitScript((agentId) => {
    window.localStorage.removeItem(`nessie.chatTool.${agentId}`)
  }, fixture.agentId)
  await page.goto(`${ADMIN_URL}/channels/${fixture.channelId}`, { waitUntil: 'domcontentloaded' })
  if (mobile) await page.getByRole('button', { name: 'Browser', exact: true }).click()
  else await page.locator('aside[aria-label="Agent tools"] button').click()
  if (fullscreen) {
    await page.getByRole('button', { name: 'Full screen' }).click()
    await page.locator('[role="dialog"][aria-label="Browser"]').waitFor()
    // OverlayPortal animates its entry; screenshots belong to the settled
    // full-screen surface, rather than its partly transparent first frame.
    await page.waitForTimeout(300)
  }
  return page.getByTitle(`${fixture.agentName} browser`)
}

const routeFixture = async (page, fixture, read) => {
  await page.route('**/api/threads/**/browser-sessions?active=1', (route) => json(route, {
    sessions: [{
      agentId: fixture.agentId, agentName: fixture.agentName, controlledByUserId: null,
      endedAt: null, id: SESSION_ID, runId: null, startedAt: '2036-09-07T11:00:00.000Z', status: 'active',
    }],
  }))
  await page.route(`**/api/browser-sessions/${SESSION_ID}`, read)
}

const screenshot = (page, name) => page.screenshot({
  fullPage: true, path: resolve(screenshots, `${name}.png`),
})

const createPrivateAgent = (token, name) => call('/api/agents', {
  // The private-agent route is the product's home-DM provisioner. Browser
  // access is deliberately absent here: protected builtins can only be
  // granted through the owner Tools policy route below.
  body: { name, role: 'browser tester', visibility: 'private' },
  method: 'POST',
  token,
})

const browserEnabled = async (token, agentId) => {
  const agents = await call('/api/agents', { token })
  return agents.find((agent) => agent.id === agentId)?.browserEnabled
}

const setBrowserOpenGrant = async (token, agentId, enabled) => {
  // Builtins are registered as canonical ToolRegistryEntry rows. This is the
  // same owner write the Tools screen uses; agent create/update intentionally
  // rejects this protected policy key.
  const tools = await call('/api/mcp/tools', { token })
  const browserTool = tools.find((tool) => tool.toolId === 'browser_open')
  assert.ok(browserTool, 'the canonical browser_open Tools entry was not registered')
  await call(`/api/mcp/tools/${browserTool.id}/policy-targets/${agentId}`, {
    body: { enabled }, method: 'PATCH', token,
  })
  assert.equal(await browserEnabled(token, agentId), enabled,
    `browserEnabled was not persisted as ${String(enabled)}`)
}

const main = async () => {
  const api = await startApi()
  const admin = await startAdmin()
  const browser = await launchBrowser()
  let context
  try {
    const seed = await seedTeam(api)
    const disabledAgent = await createPrivateAgent(seed.token, 'No browser joke agent')
    const agent = await createPrivateAgent(seed.token, 'Browser cloud E2E')
    assert.ok(agent.homeChannelId, 'private agent creation did not provision its home DM')
    assert.ok(disabledAgent.homeChannelId, 'disabled private agent did not provision its home DM')
    assert.equal(await browserEnabled(seed.token, disabledAgent.id), false,
      'an ungranted agent exposed browser access')
    await setBrowserOpenGrant(seed.token, agent.id, true)
    const fixture = { agentId: agent.id, agentName: agent.name, channelId: agent.homeChannelId }
    await rm(screenshots, { force: true, recursive: true })
    await mkdir(screenshots, { recursive: true })
    context = await browser.newContext({ viewport: { height: 900, width: 1440 } })
    await context.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      ['nessie.admin.token', seed.token],
    )

    // Browser session data or a connected Browserbase account cannot make an
    // ungranted agent discoverable. Its normal channel and a crafted tool URL
    // both have no browser surface.
    {
      const page = await context.newPage()
      await page.goto(`${ADMIN_URL}/channels/${disabledAgent.homeChannelId}`, { waitUntil: 'domcontentloaded' })
      await page.locator('aside[aria-label="Agent tools"]').waitFor({ state: 'detached' })
      await page.goto(`${ADMIN_URL}/channels/${disabledAgent.homeChannelId}/tools/browser`, { waitUntil: 'domcontentloaded' })
      assert.equal(await page.locator('aside[aria-label="Browser"]').count(), 0,
        'a direct browser tool URL exposed an ungranted agent')
      await page.close()
    }

    // A browser link from a reply pane uses the routed doorway. It reaches the
    // same mounted panel when the rail has no room beside that pane.
    {
      const page = await context.newPage()
      await routeFixture(page, fixture, (route) => json(route, detail({
        ...fixture, liveViewUrl: 'https://live-view.fixture/routed',
      })))
      await page.route('https://live-view.fixture/routed', (route) => route.fulfill({
        body: '<p>routed preview</p>', contentType: 'text/html', status: 200,
      }))
      await page.goto(`${ADMIN_URL}/channels/${fixture.channelId}/tools/browser`, { waitUntil: 'domcontentloaded' })
      const viewer = page.getByTitle(`${fixture.agentName} browser`)
      await viewer.contentFrame().getByText('routed preview').waitFor()
      assert.equal(await page.locator('aside[aria-label="Browser"]').count(), 1,
        'the routed browser doorway did not mount the browser panel')
      await page.close()
    }

    // The browser starts as a narrow drawer beside the conversation. This is
    // the status-overlay layout: a person can still see the preview while the
    // viewer says it is watch-only.
    {
      const page = await context.newPage()
      await page.addInitScript(() => {
        window.localStorage.setItem('nessie.agentScreenPanelWidth', '320')
      })
      await routeFixture(page, fixture, (route) => json(route, detail({
        ...fixture, liveViewUrl: 'https://live-view.fixture/narrow',
      })))
      await page.route('https://live-view.fixture/narrow', (route) => route.fulfill({
        body: '<p>narrow preview</p>', contentType: 'text/html', status: 200,
      }))
      const viewer = await openViewer(page, fixture, { fullscreen: false })
      await viewer.contentFrame().getByText('narrow preview').waitFor()
      const panel = page.locator('aside[aria-label="Browser"]')
      const panelBox = await panel.boundingBox()
      assert.ok(panelBox && panelBox.width >= 300 && panelBox.width <= 340,
        `narrow browser panel should be about 320px wide, got ${panelBox?.width ?? 'none'}`)
      await page.getByText('Take control to use this browser.').waitFor()
      await screenshot(page, 'narrow-panel-320')
      await page.close()
    }

    // A re-minted URL can be textually identical. The iframe must still mount
    // again or Browserbase keeps the disconnected document alive.
    {
      const page = await context.newPage()
      let reads = 0
      let sameUrlLoads = 0
      await routeFixture(page, fixture, (route) => {
        reads += 1
        return json(route, detail({ ...fixture, liveViewUrl: 'https://live-view.fixture/same' }))
      })
      await page.route('https://live-view.fixture/same', (route) => {
        sameUrlLoads += 1
        return route.fulfill({
          body: sameUrlLoads === 1
            ? '<script>parent.postMessage("browserbase-disconnected", "*")</script>'
            : '<p>same URL remounted</p>',
          contentType: 'text/html', status: 200,
        })
      })
      const viewer = await openViewer(page, fixture)
      await viewer.waitFor()
      await viewer.contentFrame().getByText('same URL remounted').waitFor()
      assert.ok(reads >= 2, 'disconnect did not refetch the live-view detail')
      assert.ok(sameUrlLoads >= 2, 'same URL recovery did not remount the iframe')
      await screenshot(page, 'same-url-recovery')
      await page.close()
    }

    // A failed recovery must not reuse React Query's retained successful data.
    {
      const page = await context.newPage()
      let failRecovery = false
      await routeFixture(page, fixture, (route) => {
        if (failRecovery) return json(route, undefined, 503)
        return json(route, detail({ ...fixture, liveViewUrl: 'https://live-view.fixture/retry' }))
      })
      await page.route('https://live-view.fixture/retry', (route) => route.fulfill({
        body: '<p>retry source</p>', contentType: 'text/html', status: 200,
      }))
      const viewer = await openViewer(page, fixture)
      await viewer.waitFor()
      failRecovery = true
      await page.getByRole('button', { name: 'Reload the live view' }).click()
      await page.getByRole('button', { name: 'Retry live view' }).waitFor()
      assert.equal(await viewer.count(), 0, 'failed recovery kept a stale authorized iframe')
      await screenshot(page, 'transient-retry')
      await page.close()
    }

    // A terminal detail ends the view without offering a futile retry.
    {
      const page = await context.newPage()
      let closeBrowser = false
      await routeFixture(page, fixture, (route) => {
        return json(route, closeBrowser
          ? detail({ ...fixture, liveViewUrl: null, status: 'released' })
          : detail({ ...fixture, liveViewUrl: 'https://live-view.fixture/terminal' }))
      })
      await page.route('https://live-view.fixture/terminal', (route) => route.fulfill({
        body: '<p>terminal source</p>', contentType: 'text/html', status: 200,
      }))
      const viewer = await openViewer(page, fixture)
      await viewer.waitFor()
      closeBrowser = true
      await page.getByRole('button', { name: 'Reload the live view' }).click()
      await page.getByText('This browser has closed. Open a new browser from this agent’s conversation.').waitFor()
      assert.equal(await viewer.count(), 0, 'terminal session kept an iframe')
      assert.equal(await page.getByRole('button', { name: 'Retry live view' }).count(), 0)
      await screenshot(page, 'terminal')
      await page.close()
    }

    // Polling, not just an explicit retry, must revoke an old provider URL.
    {
      const page = await context.newPage()
      let revokeViewer = false
      let readsAfterRevoke = 0
      await routeFixture(page, fixture, (route) => {
        if (revokeViewer) {
          readsAfterRevoke += 1
          return json(route, undefined, 403)
        }
        return json(route, detail({ ...fixture, liveViewUrl: 'https://live-view.fixture/revoked' }))
      })
      await page.route('https://live-view.fixture/revoked', (route) => route.fulfill({
        body: '<p>revoked source</p>', contentType: 'text/html', status: 200,
      }))
      const viewer = await openViewer(page, fixture)
      await viewer.waitFor()
      revokeViewer = true
      await page.waitForFunction(() => !document.querySelector('iframe'), undefined, { timeout: 20_000 })
      assert.ok(readsAfterRevoke >= 1, 'the ordinary detail poll did not run')
      await page.getByText('You no longer have access to this browser. Ask the agent owner to enable Browser.').waitFor()
      assert.equal(await page.getByRole('button', { name: 'Retry live view' }).count(), 0)
      await screenshot(page, 'permission-revoked')
      await page.close()
    }

    // At phone width Browser remains a primary conversation-header doorway;
    // it opens the same screen-sized panel and keeps its status in the preview.
    {
      const phone = await browser.newContext({
        hasTouch: true,
        viewport: { height: 844, width: 390 },
      })
      try {
        await phone.addInitScript(
          ([key, value]) => window.localStorage.setItem(key, value),
          ['nessie.admin.token', seed.token],
        )
        const page = await phone.newPage()
        await routeFixture(page, fixture, (route) => json(route, detail({
          ...fixture, liveViewUrl: 'https://live-view.fixture/mobile',
        })))
        await page.route('https://live-view.fixture/mobile', (route) => route.fulfill({
          body: '<p>mobile preview</p>', contentType: 'text/html', status: 200,
        }))
        const viewer = await openViewer(page, fixture, { fullscreen: false, mobile: true })
        await viewer.contentFrame().getByText('mobile preview').waitFor()
        assert.match(page.url(), new RegExp(`/channels/${fixture.channelId}/tools/browser$`))
        await page.getByText('Take control to use this browser.').waitFor()
        // The phone tool is a routed screen, so wait for its push transition
        // before measuring or capturing it. An early screenshot catches the
        // outgoing conversation and misrepresents the actual panel width.
        await page.waitForTimeout(500)
        const panel = page.locator('aside[aria-label="Browser"]')
        const panelBox = await panel.boundingBox()
        assert.ok(panelBox && Math.abs(panelBox.x) < 1 && Math.abs(panelBox.width - 390) < 1,
          `phone browser panel should fill 390px, got ${panelBox?.x ?? 'none'} / ${panelBox?.width ?? 'none'}`)
        await screenshot(page, 'mobile-390')
        await page.close()
      } finally {
        await phone.close()
      }
    }

    // A policy change can come from another owner's tab. Its organization
    // realtime event must remove the presently mounted dock without a reload,
    // then a direct URL must be equally unavailable.
    {
      const watching = await browser.newContext({ viewport: { height: 900, width: 1440 } })
      try {
        await watching.addInitScript(
          ([key, value]) => window.localStorage.setItem(key, value),
          ['nessie.admin.token', seed.token],
        )
        const page = await watching.newPage()
        await page.goto(`${ADMIN_URL}/channels/${fixture.channelId}`, { waitUntil: 'domcontentloaded' })
        await page.locator('aside[aria-label="Agent tools"]').waitFor()
        await setBrowserOpenGrant(seed.token, agent.id, false)
        await page.locator('aside[aria-label="Agent tools"]').waitFor({ state: 'detached', timeout: 15_000 })
        await page.goto(`${ADMIN_URL}/channels/${fixture.channelId}/tools/browser`, { waitUntil: 'domcontentloaded' })
        assert.equal(await page.locator('aside[aria-label="Browser"]').count(), 0,
          'a revoked agent remained available on a direct browser tool URL')
        await page.close()
      } finally {
        await watching.close()
      }
    }
    {
      const page = await context.newPage()
      await page.goto(`${ADMIN_URL}/channels/${fixture.channelId}`, { waitUntil: 'domcontentloaded' })
      await page.locator('aside[aria-label="Agent tools"]').waitFor({ state: 'detached' })
      await page.goto(`${ADMIN_URL}/channels/${fixture.channelId}/tools/browser`, { waitUntil: 'domcontentloaded' })
      assert.equal(await page.locator('aside[aria-label="Browser"]').count(), 0,
        'a revoked agent remained available on a direct browser tool URL')
      await page.close()
    }
  } finally {
    await context?.close()
    await browser.close()
    await stopProcess(admin)
    await stopProcess(api)
  }
}

await main()
