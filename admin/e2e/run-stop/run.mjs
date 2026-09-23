import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * Stop, where a person watches a run.
 *
 * A pure fixture suite — the real thinking bubbles and the real agent header
 * over the real API client, with the runner answering `/api/**` — so it needs
 * the admin and nothing behind it. It pins:
 *
 * - the Stop icon on the channel bubble, the thread bubble and the agent
 *   page's status pill while their run is live;
 * - the request: `POST /api/runs/<that run>/cancel`, once, and pressing Stop
 *   never also opens the thought process;
 * - the pending state: "Stopping…" holds after the API has answered, because
 *   Stop is cooperative, and ends only when the run leaves its live state
 *   (the bubble's `stream.done`, the header's `run.updated`);
 * - a refusal puts Stop back with the server's reason;
 * - the target is the design system's action button: 26px under a mouse, 44px
 *   under a finger.
 *
 * It refuses to adopt an admin already listening, so a run beside another
 * checkout's dev server cannot drive that checkout's components.
 */

const RUN_CHANNEL = '00000000-0000-4000-8000-0000000000a1'
const RUN_THREAD = '00000000-0000-4000-8000-0000000000a2'
const RUN_AGENT = '00000000-0000-4000-8000-0000000000a3'
const RUN_AGENT_NEXT = '00000000-0000-4000-8000-0000000000a4'
const AGENT_PAGE_ID = '00000000-0000-4000-8000-0000000000b3'

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/run-stop')

// Mutable per context: which run the agent header's status read reports.
const openCase = async (browser, contextOptions) => {
  const state = { agentRunId: RUN_AGENT, cancels: [] }
  const context = await browser.newContext(contextOptions)
  await context.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const cancel = /^\/api\/runs\/([^/]+)\/cancel$/.exec(path)
    if (cancel && request.method() === 'POST') {
      const runId = cancel[1]
      state.cancels.push(runId)
      if (runId === RUN_THREAD) {
        return route.fulfill({
          json: { error: { code: 'RUN_ALREADY_FINISHED', message: 'Run already completed' } },
          status: 409,
        })
      }
      // Held briefly, so the pending state is visible before the answer too.
      await new Promise((done) => { setTimeout(done, 400) })
      return route.fulfill({ json: { data: { status: 'cancel_requested' } }, status: 202 })
    }
    if (path === `/api/agents/${AGENT_PAGE_ID}/status` && request.method() === 'GET') {
      return route.fulfill({
        json: {
          data: {
            activeSubAgents: [],
            agentId: AGENT_PAGE_ID,
            lastActivityAt: '2026-09-23T09:00:00.000Z',
            since: '2026-09-23T09:00:00.000Z',
            status: state.agentRunId ? 'thinking' : 'idle',
            ...(state.agentRunId ? { currentRunId: state.agentRunId } : {}),
          },
        },
      })
    }
    throw new Error(`Unexpected fixture request ${request.method()} ${path}`)
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${ADMIN_URL}/e2e/run-stop/index.html`)
  await page.getByRole('button', { name: 'Stop Release manager', exact: true }).waitFor()
  return { context, errors, page, state }
}

const boxOf = async (locator) => {
  const box = await locator.boundingBox()
  assert.ok(box, 'Stop has a box')
  return box
}

const admin = await startAdmin({ reuseExisting: false })
const browser = await launchBrowser()
try {
  await mkdir(screenshots, { recursive: true })

  const { context, errors, page, state } = await openCase(browser, {
    viewport: { height: 900, width: 1100 },
  })
  const stopCto = page.getByRole('button', { name: 'Stop CTO', exact: true })
  const stopResearcher = page.getByRole('button', { name: 'Stop Researcher', exact: true })
  const stopAgent = page.getByRole('button', { name: 'Stop Release manager', exact: true })
  const opened = page.getByTestId('opened')
  const ctoBubble = page.getByTestId('thinking-bubble').filter({ hasText: 'CTO' })
  const agentPage = page.getByRole('region', { name: 'Agent page' })

  await stopCto.waitFor()
  await stopResearcher.waitFor()
  const desktopBox = await boxOf(stopCto)
  assert.ok(Math.round(desktopBox.width) === 26 && Math.round(desktopBox.height) === 26,
    `Stop is the 26px action button under a mouse, got ${desktopBox.width}×${desktopBox.height}`)
  await page.screenshot({ fullPage: true, path: resolve(screenshots, '01-live.png') })

  // The channel bubble: the request, and the pending state before and after
  // the answer. The bubble itself must not open.
  await stopCto.click()
  await ctoBubble.getByText('Stopping…', { exact: true }).waitFor()
  assert.deepEqual(state.cancels, [RUN_CHANNEL])
  await page.waitForTimeout(900)
  const pending = ctoBubble.getByRole('button', { name: 'Stopping CTO…', exact: true })
  assert.equal(await pending.count(), 1, 'Stopping… holds after the API answered')
  assert.equal(await pending.getAttribute('aria-disabled'), 'true')
  // `aria-disabled`, not `disabled`, so focus stays on the control; the
  // press still reaches it, and must send nothing.
  await pending.click({ force: true })
  assert.deepEqual(state.cancels, [RUN_CHANNEL], 'a pending Stop sends nothing more')
  assert.equal(await opened.innerText(), 'Nothing opened', 'Stop never opens the thought process')
  await page.screenshot({ fullPage: true, path: resolve(screenshots, '02-stopping.png') })

  // The worker ends the run and publishes `stream.done`: the bubble goes, and
  // its "Stopping…" with it.
  await page.evaluate((runId) => { window.__runStopFixture.streamDone(runId) }, RUN_CHANNEL)
  await ctoBubble.waitFor({ state: 'detached' })

  // The thread bubble, by keyboard, against a run the server says has
  // already finished: Stop comes back and says why.
  await stopResearcher.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('alert').getByText('Run already completed', { exact: true }).waitFor()
  assert.deepEqual(state.cancels, [RUN_CHANNEL, RUN_THREAD])
  assert.equal(await stopResearcher.count(), 1, 'a refused Stop is offered again')
  assert.equal(await opened.innerText(), 'Nothing opened', 'Enter on Stop does not open the bubble')
  await page.screenshot({ fullPage: true, path: resolve(screenshots, '03-refused.png') })

  // The rest of the bubble is still the way into the thought process.
  await page.getByRole('button', { name: 'View Researcher’s thought process', exact: true }).click()
  assert.equal(await opened.innerText(), `Opened: ${RUN_THREAD}`)

  // The agent page's status pill.
  await stopAgent.click()
  await agentPage.getByText('Stopping…', { exact: true }).waitFor()
  assert.deepEqual(state.cancels, [RUN_CHANNEL, RUN_THREAD, RUN_AGENT])
  await page.waitForTimeout(900)
  assert.equal(await agentPage.getByText('Stopping…', { exact: true }).count(), 1)
  await agentPage.screenshot({ path: resolve(screenshots, '04-agent-stopping.png') })

  // `run.updated`: the status read names no current run, so Stop leaves.
  state.agentRunId = null
  await page.evaluate(() => { window.__runStopFixture.runUpdated('idle') })
  await agentPage.getByText('idle', { exact: true }).waitFor()
  await agentPage.getByTestId('run-stop').waitFor({ state: 'detached' })

  // A later run is offered Stop afresh, never inherits the last "Stopping…".
  state.agentRunId = RUN_AGENT_NEXT
  await page.evaluate(() => { window.__runStopFixture.runUpdated('thinking') })
  await stopAgent.waitFor()
  assert.equal(await agentPage.getByText('Stopping…', { exact: true }).count(), 0)
  await agentPage.screenshot({ path: resolve(screenshots, '05-agent-next-run.png') })
  assert.deepEqual(errors, [])
  await context.close()

  // Under a finger the same control is a 44px target.
  const phone = await openCase(browser, {
    hasTouch: true,
    isMobile: true,
    viewport: { height: 844, width: 390 },
  })
  for (const name of ['Stop CTO', 'Stop Researcher', 'Stop Release manager']) {
    const phoneBox = await boxOf(phone.page.getByRole('button', { name, exact: true }))
    assert.ok(phoneBox.width >= 44 && phoneBox.height >= 44,
      `${name} is a 44px target under a finger, got ${phoneBox.width}×${phoneBox.height}`)
  }
  await phone.page.screenshot({ fullPage: true, path: resolve(screenshots, '06-phone.png') })
  assert.deepEqual(phone.errors, [])
  await phone.context.close()

  console.log(`Run stop proofs passed; screenshots: ${screenshots}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
