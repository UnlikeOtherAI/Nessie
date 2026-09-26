import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * A local program's screenshots, where a person reads the call that took them.
 *
 * A pure fixture suite — the real thought-process dialog and the real agent
 * page Activity tab over the real API client, with the runner answering
 * `/api/**` — so it needs the admin and nothing behind it. It pins:
 *
 * - the thought-process dialog, the doorway from a thinking bubble: a tool
 *   line carries its call's screenshots as thumbnails, read from the run's
 *   full thought log, which the dialog reads again once a call is known to
 *   have returned — a live line never carries them;
 * - the agent page's tool execution log, the home: the same thumbnails on the
 *   call's card, from `ToolCallEntry.attachments`;
 * - bytes come from the ordinary attachment routes — the thumbnail when the
 *   ref has one, else the original — and a press opens the original in the
 *   shared viewer, which over the dialog takes the blocking layer and gives
 *   Escape back to the dialog, not past it;
 * - both at 1280 px and at 390 px under a finger, with no sideways scroll.
 *
 * The image is the real one Kelpie returned on Windows
 * (`executor/test/fixtures/kelpie-screenshot-result.json`). It refuses to adopt
 * an admin already listening, so a run beside another checkout's dev server
 * cannot drive that checkout's components.
 */

const RUN_ID = '50000000-0000-4000-8000-000000000001'
const THREAD_ID = '50000000-0000-4000-8000-000000000002'
const AGENT_ID = '50000000-0000-4000-8000-000000000003'
const SCREENSHOT_CALL = '50000000-0000-4000-8000-000000000011'
const NAVIGATE_CALL = '50000000-0000-4000-8000-000000000012'
const SEARCH_CALL = '50000000-0000-4000-8000-000000000013'
const WITH_THUMBNAIL = '60000000-0000-4000-8000-000000000001'
const ORIGINAL_ONLY = '60000000-0000-4000-8000-000000000002'
const T0 = '2026-09-23T09:00:00.000Z'

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/tool-screenshots')

const kelpieResult = JSON.parse(readFileSync(
  resolve(REPO_ROOT, 'executor/test/fixtures/kelpie-screenshot-result.json'),
  'utf8',
))
const PNG = Buffer.from(kelpieResult.content.find((item) => item.type === 'image').data, 'base64')

const images = [
  {
    attachmentId: WITH_THUMBNAIL,
    byteLength: PNG.length,
    filename: 'kelpie-screenshot-1.png',
    hasThumbnail: true,
    mimeType: 'image/png',
  },
  // Its thumbnail is still being made: the original is painted instead.
  {
    attachmentId: ORIGINAL_ONLY,
    byteLength: PNG.length,
    filename: 'kelpie-screenshot-2.png',
    hasThumbnail: false,
    mimeType: 'image/png',
  },
]

const chunk = (id, kind, content, extra = {}) => ({ content, createdAt: T0, id, kind, ...extra })

// The full thought log. Until the screenshot call has returned, its line has
// no images; once it has, the line carries both and the next thought follows.
const thinkingLog = (returned) => ({
  entries: [
    chunk('1', 'reasoning', 'I will open the pricing page in Kelpie and look at how it renders.'),
    chunk('2', 'tool', 'executor_mcp_call: server=kelpie, tool=navigate, url=https://example.com'),
    chunk('3', 'reasoning', 'The page loaded. A screenshot will show whether the hero fits.'),
    chunk('4', 'tool', 'executor_mcp_call: server=kelpie, tool=screenshot', returned ? { attachments: images } : {}),
    ...(returned ? [chunk('5', 'reasoning', 'The hero fits; the pricing table wraps at this width.')] : []),
  ],
  run: { agentId: AGENT_ID, id: RUN_ID, rootMessageId: null, status: 'running' },
  truncated: false,
})

const toolCall = (id, toolName, inputSummary, outputPreview, attachments) => ({
  attachments,
  durationMs: 1840,
  endedAt: T0,
  id,
  inputSummary,
  outputPreview,
  runId: RUN_ID,
  startedAt: T0,
  success: true,
  toolName,
})

const activity = {
  agentId: AGENT_ID,
  recentToolCalls: [
    toolCall(
      SCREENSHOT_CALL,
      'executor_mcp_call',
      'server=kelpie, tool=screenshot',
      '{"content":[{"type":"text","text":"[image 1: screenshot, 13 KB]"},{"type":"text","text":"[image 2: screenshot, 13 KB]"}]}',
      images,
    ),
    toolCall(
      NAVIGATE_CALL,
      'executor_mcp_call',
      'server=kelpie, tool=navigate, url=https://example.com',
      '{"content":[{"type":"text","text":"Navigated to https://example.com"}]}',
      [],
    ),
    toolCall(SEARCH_CALL, 'web_search', 'query=example pricing page', '3 results for example pricing page', []),
  ],
  status: 'idle',
  subAgents: [],
}

const pagedEmpty = { data: [], meta: { hasMore: false, nextCursor: null } }

// A member of the organisation, signed in: a signed-out session provider
// clears the query cache under the page, which is not what a person sees.
const TOKEN = 'tool-screenshots-fixture'
const me = {
  auth: { autoRedirectToSso: false, providerId: 'local', providerType: 'local' },
  context: {
    bootstrapMode: false,
    channelId: null,
    organizationId: '50000000-0000-4000-8000-000000000020',
    projectId: null,
    teamId: null,
  },
  session: { issuedAt: T0, sessionId: '50000000-0000-4000-8000-000000000021' },
  user: {
    displayName: 'Ondřej Rafaj',
    email: 'ondrej@example.test',
    id: '50000000-0000-4000-8000-000000000022',
    roleIds: ['member'],
  },
}

const openCase = async (browser, surface, contextOptions) => {
  const state = { bytes: [], logReads: 0, returned: false, unexpected: [] }
  const context = await browser.newContext({ deviceScaleFactor: 2, ...contextOptions })
  await context.addInitScript((token) => { window.localStorage.setItem('nessie.admin.token', token) }, TOKEN)
  await context.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (request.headers().authorization !== `Bearer ${TOKEN}`) {
      state.unexpected.push(`${request.method()} ${path} without the session`)
      return route.fulfill({ json: { error: { code: 'UNAUTHORIZED', message: 'Signed out' } }, status: 401 })
    }
    if (path === '/api/auth/me') return route.fulfill({ json: { data: me } })
    if (request.method() !== 'GET') {
      state.unexpected.push(`${request.method()} ${path}`)
      return route.fulfill({ json: { error: { code: 'NOT_FOUND', message: 'Not in this fixture' } }, status: 404 })
    }
    const bytes = /^\/api\/attachments\/([^/]+)(\/thumbnail)?$/.exec(path)
    if (bytes) {
      state.bytes.push(path)
      return route.fulfill({ body: PNG, contentType: 'image/png', status: 200 })
    }
    if (path === `/api/threads/${THREAD_ID}/runs/${RUN_ID}/thinking`) {
      state.logReads += 1
      return route.fulfill({ json: { data: thinkingLog(state.returned) } })
    }
    if (path === `/api/agents/${AGENT_ID}/activity`) return route.fulfill({ json: { data: activity } })
    if (path === `/api/agents/${AGENT_ID}/status`) {
      return route.fulfill({
        json: { data: { activeSubAgents: [], agentId: AGENT_ID, lastActivityAt: T0, since: T0, status: 'idle' } },
      })
    }
    if (path === `/api/agents/${AGENT_ID}/children`) return route.fulfill({ json: { data: [] } })
    if (path === `/api/agents/${AGENT_ID}/run-failures`) return route.fulfill({ json: { data: { failures: [] } } })
    if (path === `/api/agents/${AGENT_ID}/messages`) return route.fulfill({ json: pagedEmpty })
    if (path === `/api/agents/${AGENT_ID}/conversations`) return route.fulfill({ json: pagedEmpty })
    // The agent has no email address: the Activity tab reads that as no Mailbox section.
    if (path === `/api/agents/${AGENT_ID}/mailbox`) {
      return route.fulfill({ json: { error: { code: 'MAILBOX_NOT_FOUND', message: 'No mailbox' } }, status: 404 })
    }
    state.unexpected.push(`GET ${path}`)
    return route.fulfill({ json: { error: { code: 'NOT_FOUND', message: 'Not in this fixture' } }, status: 404 })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const query = surface === 'agent' ? 'surface=agent' : 'surface=thought'
  await page.goto(`${ADMIN_URL}/e2e/tool-screenshots/index.html?${query}`)
  return { context, errors, page, state }
}

const shot = (name) => resolve(screenshots, name)

// Every thumbnail painted real pixels, not a broken image.
const assertPainted = async (locator, count) => {
  await locator.first().waitFor()
  assert.equal(await locator.count(), count)
  for (let index = 0; index < count; index += 1) {
    const img = locator.nth(index).locator('img')
    await img.waitFor()
    await assert.doesNotReject(img.evaluate((node) => node.decode()))
    assert.ok(await img.evaluate((node) => node.naturalWidth > 0), `thumbnail ${index + 1} has pixels`)
  }
}

const assertNoSidewaysScroll = async (page, label) => {
  const { inner, scroll } = await page.evaluate(() => ({
    inner: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  assert.ok(scroll <= inner, `${label}: the page scrolls sideways (${scroll} > ${inner})`)
}

const within = async (inner, outer, label) => {
  const [a, b] = [await inner.boundingBox(), await outer.boundingBox()]
  assert.ok(a && b, `${label}: both have a box`)
  assert.ok(a.x >= b.x - 0.5 && a.x + a.width <= b.x + b.width + 0.5, `${label}: sits inside horizontally`)
}

// The dialog on a live run: no images while the call runs, both once the next
// thought shows it returned. Shared by the desktop and phone cases.
const thoughtSurface = async (browser, contextOptions) => {
  const opened = await openCase(browser, 'thought', contextOptions)
  const { page, state } = opened
  const dialog = page.getByTestId('thought-process-dialog')
  const toolLines = dialog.getByTestId('thought-process-tool')
  await dialog.waitFor()
  await toolLines.nth(1).waitFor()
  await page.waitForTimeout(300)
  assert.equal(state.logReads, 1, 'the dialog reads the full log when it opens')
  assert.equal(await dialog.getByTestId('tool-screenshot').count(), 0, 'a call still running shows nothing')

  // The call returned (its images are kept), and the model's next thought
  // arrives on the stream.
  state.returned = true
  await page.evaluate(() => {
    window.__toolScreenshotsFixture.reason({ content: 'The hero fits; the pricing table wraps.', id: '5', kind: 'reasoning' })
  })
  const thumbnails = toolLines.nth(1).getByTestId('tool-screenshot')
  await assertPainted(thumbnails, 2)
  assert.equal(state.logReads, 2, 'a call known to have returned is read again, once')
  assert.equal(await toolLines.nth(0).getByTestId('tool-screenshot').count(), 0, 'a call without images shows none')
  assert.deepEqual(
    [...new Set(state.bytes)].sort(),
    [`/api/attachments/${ORIGINAL_ONLY}`, `/api/attachments/${WITH_THUMBNAIL}/thumbnail`].sort(),
    'the thumbnail where there is one, else the original',
  )
  return { ...opened, dialog, thumbnails }
}

const openViewer = async (page, thumbnail, state) => {
  state.bytes.length = 0
  await thumbnail.click()
  const viewer = page.getByTestId('attachment-viewer')
  await viewer.waitFor()
  const full = viewer.locator('img')
  await full.waitFor()
  await assert.doesNotReject(full.evaluate((node) => node.decode()))
  assert.equal(await viewer.locator('#attachment-viewer-title').innerText(), 'kelpie-screenshot-1.png')
  assert.ok(state.bytes.includes(`/api/attachments/${WITH_THUMBNAIL}`), 'the viewer shows the original')
  // Screenshot it once its open motion has played out, not mid-fade.
  await viewer.evaluate((panel) => Promise.all(panel.getAnimations().map((animation) => animation.finished)))
  return viewer
}

const admin = await startAdmin({ reuseExisting: false })
const browser = await launchBrowser()
try {
  await mkdir(screenshots, { recursive: true })
  const desktop = { viewport: { height: 800, width: 1280 } }
  const phone = { hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } }

  // ── The thought-process dialog, at 1280 ─────────────────────────────────
  {
    const { context, dialog, errors, page, state, thumbnails } = await thoughtSurface(browser, desktop)
    await page.screenshot({ path: shot('01-thought-desktop.png') })

    const viewer = await openViewer(page, thumbnails.first(), state)
    // Over a modal, the viewer is the sanctioned blocking nesting: above the
    // dialog for paint, so the press lands on it and not on the dialog.
    const layer = await viewer.evaluate((panel) => getComputedStyle(panel.parentElement).zIndex)
    assert.equal(layer, '80', 'the viewer opened from the dialog takes the blocking layer')
    const box = await viewer.boundingBox()
    const topmost = await page.evaluate(
      ([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="attachment-viewer"]')),
      [box.x + box.width / 2, box.y + box.height / 2],
    )
    assert.ok(topmost, 'the viewer paints above the dialog')
    await page.screenshot({ path: shot('02-thought-viewer-desktop.png') })

    // Escape closes the viewer and nothing under it.
    await page.keyboard.press('Escape')
    await viewer.waitFor({ state: 'detached' })
    assert.ok(await dialog.isVisible(), 'the dialog stays open under the closed viewer')
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'tool-screenshot',
      'focus returns to the screenshot that opened it')

    // The run ends: the record stays, images included.
    await page.evaluate(() => { window.__toolScreenshotsFixture.streamDone() })
    await dialog.getByText('Reply posted. This is the complete record for that run.').waitFor()
    assert.equal(await thumbnails.count(), 2)
    assert.deepEqual(state.unexpected, [])
    assert.deepEqual(errors, [])
    await context.close()
  }

  // ── The agent page's tool execution log, at 1280 ────────────────────────
  {
    const { context, errors, page, state } = await openCase(browser, 'agent', desktop)
    // The tool log is a technical fold on the Activity tab; a person opens it.
    await page.getByTestId('agent-tool-log').locator('summary').click()
    const log = page.locator('section').filter({ has: page.getByText('Tool execution log', { exact: true }) })
    await log.waitFor()
    await log.getByText('web_search', { exact: true }).waitFor()
    const screenshotCard = log.getByTestId('tool-screenshots').first()
    await assertPainted(screenshotCard.getByTestId('tool-screenshot'), 2)
    assert.equal(await log.getByTestId('tool-screenshots').count(), 1, 'only the call that returned images shows any')
    await screenshotCard.scrollIntoViewIfNeeded()
    await page.screenshot({ path: shot('03-agent-desktop.png') })

    const viewer = await openViewer(page, screenshotCard.getByTestId('tool-screenshot').first(), state)
    const layer = await viewer.evaluate((panel) => getComputedStyle(panel.parentElement).zIndex)
    assert.equal(layer, '70', 'on the page itself the viewer is an ordinary modal')
    await page.screenshot({ path: shot('04-agent-viewer-desktop.png') })
    await page.keyboard.press('Escape')
    await viewer.waitFor({ state: 'detached' })
    assert.deepEqual(state.unexpected, [])
    assert.deepEqual(errors, [])
    await context.close()
  }

  // ── Both at 390, under a finger ─────────────────────────────────────────
  {
    const { context, dialog, errors, page, state, thumbnails } = await thoughtSurface(browser, phone)
    await assertNoSidewaysScroll(page, 'thought-process dialog on a phone')
    await within(thumbnails.nth(1), dialog, 'the second thumbnail')
    await page.screenshot({ path: shot('05-thought-phone.png') })
    const viewer = await openViewer(page, thumbnails.first(), state)
    await within(viewer.locator('img'), viewer, 'the full image')
    await page.screenshot({ path: shot('06-thought-viewer-phone.png') })
    assert.deepEqual(state.unexpected, [])
    assert.deepEqual(errors, [])
    await context.close()
  }
  {
    const { context, errors, page, state } = await openCase(browser, 'agent', phone)
    await page.getByTestId('agent-tool-log').locator('summary').click()
    const list = page.getByTestId('tool-screenshots').first()
    await assertPainted(list.getByTestId('tool-screenshot'), 2)
    await assertNoSidewaysScroll(page, 'agent page on a phone')
    await list.scrollIntoViewIfNeeded()
    await page.screenshot({ path: shot('07-agent-phone.png') })
    assert.deepEqual(state.unexpected, [])
    assert.deepEqual(errors, [])
    await context.close()
  }

  console.log(`Tool screenshot proofs passed; screenshots: ${screenshots}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
