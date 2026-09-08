#!/usr/bin/env node
//   DATABASE_URL=postgresql://… pnpm --filter @nessie/admin test:e2e:agent-conversations
//
// Many isolated conversations with one agent, proved against the real stack:
// the API with its embedded worker on 5454, the admin on 5455, and a scripted
// OpenAI-compatible endpoint standing in for inference. What it claims is
// structural — that two conversations with the same agent run at once, that
// neither model request ever saw the other's turns, that a reader who is not
// in the room is told nothing, and that the doorway card resolves per viewer.
// It deliberately claims nothing about a real model's judgement.
//
// Spec: docs/plans/2026-09-08-agent-conversations.md § "Verification system" 5.
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import {
  assertFreshServersAvailable,
  startAdmin,
  startApi,
  stopProcess,
} from '../navigation/lib/servers.mjs'
import { exerciseConversationCard } from './conversation-card.mjs'
import { saveFailureEvidence } from './failure-evidence.mjs'
import {
  ALPHA_QUESTION,
  BETA_QUESTION,
  seedFixture,
  tokenFor,
  waitForRun,
} from './fixture.mjs'
import { startMockModelServer } from './mock-server.mjs'
import { exercisePhoneColumn } from './phone-column.mjs'
import { openGallery } from './viewports.mjs'

const ADMIN_URL = 'http://127.0.0.1:5455'
const API_URL = 'http://127.0.0.1:5454'
const SCREENSHOTS = resolve(
  import.meta.dirname, '..', '..', '..', 'e2e', 'screenshots', 'agent-conversations',
)

/** Long enough to photograph a run in flight, short enough to finish inside the budget. */
const ECHO_LATENCY_MS = 1_500
const CONVERSATION_TITLE = 'Pricing page copy'

const api = async (path, token, options = {}) => {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
  })
  const text = await response.text()
  return { body: text, payload: text ? JSON.parse(text) : null, status: response.status }
}

const apiOk = async (path, token, options) => {
  const result = await api(path, token, options)
  assert.ok(
    result.status >= 200 && result.status < 300,
    `${options?.method ?? 'GET'} ${path} → ${result.status}: ${result.body.slice(0, 300)}`,
  )
  return result.payload?.data
}

const goto = (page, path) => page.goto(`${ADMIN_URL}${path}`, {
  // Never `networkidle`: the admin holds an SSE stream open, so it never idles.
  waitUntil: 'domcontentloaded',
})

const rowTitles = (page) =>
  page.locator('[data-testid="agent-conversation-row"]').allInnerTexts()

/**
 * The list, once it has settled on a number.
 *
 * The column renders three `Skeleton` rows while its query is in flight, so a
 * count read the instant the panel appears is a count of nothing. This waits
 * for the expected number and only then reports what is there — a wrong number
 * still fails, with the titles in the message.
 */
const settledRows = async (page, expected, label) => {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid="agent-conversation-row"]').length === count,
    expected,
    { timeout: 30_000 },
  ).catch(() => {})
  const titles = await rowTitles(page)
  assert.equal(titles.length, expected, `${label}: ${JSON.stringify(titles)}`)
  return titles
}

/** The composer of the conversation on screen, ignoring any retained layer beneath. */
const composer = (page) => page.locator('form.admin-compose:visible [contenteditable="true"]').last()

/**
 * Type into the composer and send, confirming both.
 *
 * The composer is a contenteditable whose props change as the page's later
 * queries land — the placeholder alone is derived from the conversation's agent
 * — and a re-render mid-type drops what has been typed so far. On the Vite dev
 * server that race never showed; against the built bundle CI serves, it did,
 * and silently: `Enter` on an empty editor sends nothing and the suite then
 * waits for a run that was never asked for. So the text is verified before
 * Enter, and the message is verified after it.
 */
const sendMessage = async (page, text) => {
  const editor = composer(page)
  await editor.waitFor({ timeout: 60_000 })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await editor.click()
    await editor.pressSequentially(text)
    if ((await editor.innerText()).includes(text)) break
    await editor.press('ControlOrMeta+A')
    await editor.press('Backspace')
  }
  assert.ok((await editor.innerText()).includes(text),
    `the composer would not take "${text}"`)
  await editor.press('Enter')
  await page.waitForFunction(
    (needle) => document.body.innerText.includes(needle),
    text,
    { timeout: 60_000 },
  )
}

/**
 * Open the column through this width's own doorway.
 *
 * Two different controls, one rule (`chatToolDoorway`): a rail button beside a
 * wide conversation, a header action on a phone — where pressing it navigates,
 * because the column is a real screen there. Every page starts from "no tool
 * open" (`viewports.mjs`), so a press always opens.
 */
const openConversationsColumn = async (page, viewport, agentName) => {
  if (viewport === 'phone') {
    // The header renders a hidden measuring copy of every action beside the
    // real one — hence `:visible`. And `.last()`, not `.first()`: the room's
    // layer is retained beneath a pushed conversation, so its own still-visible
    // header sits earlier in the DOM and is covered by the top layer's title.
    const doorway = page.locator('[data-page-header-action="chat-tool-conversations"]:visible')
    await doorway.last().waitFor({ timeout: 30_000 })
    await doorway.last().click()
    await page.waitForURL(/\/tools\/conversations$/u)
  } else {
    const rail = page.locator('aside[aria-label="Agent tools"]')
    await rail.waitFor({ timeout: 30_000 })
    await rail.getByRole('button', { name: 'Conversations' }).click()
  }
  await page.locator(`[aria-label="Conversations with ${agentName}"]`)
    .waitFor({ timeout: 30_000 })
  await page.locator('[data-testid="start-agent-conversation"]').waitFor({ timeout: 30_000 })
}

const main = async () => {
  process.env.DATABASE_URL ??= 'postgresql://nessie:nessie@127.0.0.1:55453/nessie'
  process.env.NESSIE_DB_URL ??= process.env.DATABASE_URL
  process.env.NESSIE_AUTH_SECRET ??= 'agent-conversations-browser-e2e-secret'
  process.env.NESSIE_MODEL_API_KEY ??= 'mock-token'
  process.env.NESSIE_MODEL_PROVIDER ??= 'openai'
  process.env.OPENAI_API_KEY ??= 'mock-token'

  await rm(SCREENSHOTS, { force: true, recursive: true })
  await mkdir(SCREENSHOTS, { recursive: true })
  await assertFreshServersAvailable()

  // The plan is read per request, so the agent's seeded name can be filled in
  // after the server is already listening — which it has to be, because its URL
  // has to exist before the worker module is imported.
  const plan = {
    conversationTitle: CONVERSATION_TITLE,
    echoLatencyMs: ECHO_LATENCY_MS,
    fallbackJob: 'Take a look at the pricing page copy.',
    targetAgentName: null,
  }
  const model = await startMockModelServer(plan)
  // `worker/src/run/agent-loop.ts` reads model configuration at import time.
  process.env.NESSIE_MODEL_BASE_URL = `${model.url}/v1`

  const { issueSessionToken } = await import('../../../api/src/auth/session.ts')
  const { ensurePersonalAssistantBootstrap } =
    await import('../../../api/src/services/personal-assistant.ts')
  const { cleanupScope, seedScope, startMockPipeline } =
    await import('../../../worker/test-harness/pipeline.ts')
  // Two subscribers beside the API's own embedded worker: one conversation
  // must be able to run while another is still running, and a single-consumer
  // queue would serialise the very thing this suite is here to disprove.
  const pipeline = await startMockPipeline({ workers: 2 })
  const fixture = await seedFixture(pipeline, seedScope, ensurePersonalAssistantBootstrap)
  plan.targetAgentName = fixture.agent.name
  const ownerToken = tokenFor(issueSessionToken, fixture.owner, fixture.scope)
  const outsiderToken = tokenFor(issueSessionToken, fixture.outsider, fixture.scope)
  const runIds = []

  let apiServer = null
  let adminServer = null
  let browser = null
  let gallery = null
  let outsiderContext = null
  let outsiderPage = null
  try {
    // A conversation suite must never adopt another worktree's dev servers:
    // it would drive different source and leave this fixture unverified.
    apiServer = await startApi({ reuseExisting: false })
    adminServer = await startAdmin({ reuseExisting: false })
    browser = await launchBrowser()
    gallery = await openGallery(browser, { screenshots: SCREENSHOTS, token: ownerToken })
    outsiderContext = await openViewportContext(browser, { name: 'desktop', token: outsiderToken })
    outsiderPage = (await outsiderContext.newPage()).page
    const desktop = gallery.pages.desktop
    // Agent X's own room with A. The doorway exists only here — see the
    // `standard-room` case at the end for the room where it does not.
    const room = `/channels/${fixture.dmRoom.id}`

    // ---- rail -------------------------------------------------------------
    // The doorway exists, offers only the tools this agent has, and opens onto
    // the room's own General row before any conversation has been started.
    await gallery.capture('rail', async (page, viewport) => {
      await goto(page, room)
      await composer(page).waitFor({ timeout: 60_000 })
      if (viewport === 'phone') {
        // The doorway lands with the agent read, which is a second request; a
        // rendered composer does not mean the header has decided yet.
        await page.locator('[data-page-header-action="chat-tool-conversations"]:visible')
          .last().waitFor({ timeout: 30_000 })
        assert.equal(
          await page.locator('aside[aria-label="Agent tools"]').count(), 0,
          'the rail stands down on a single-column layout',
        )
        assert.equal(
          await page.locator('[data-page-header-action="chat-tool-browser"]:visible').count(), 0,
          'an agent with no browser grant is offered no Browser doorway',
        )
      } else {
        await page.locator('aside[aria-label="Agent tools"]').waitFor({ timeout: 30_000 })
        const labels = await page.locator(
          'aside[aria-label="Agent tools"] .admin-rail-btn-label',
        ).allInnerTexts()
        assert.deepEqual(labels, ['Conversations'],
          `the rail offers only the tools this agent has (${viewport})`)
      }
      await openConversationsColumn(page, viewport, fixture.agent.name)
      // Two General rows and no conversations yet: the list rule's second arm
      // is what puts a room the agent merely works in on the list, so the
      // standard room appears here even though it offers no doorway of its own.
      const titles = await settledRows(page, 2,
        `both rooms the agent is bound to are listed (${viewport})`)
      assert.ok(titles.some((title) => title.includes(fixture.agent.name)),
        'this room’s own General row is named by the room')
      assert.ok(titles.some((title) => title.includes('Pricing room')),
        'and so is the standard room the agent is also bound to')
    })

    // ---- start-two --------------------------------------------------------
    // Two presses, two threads, two isolated jobs.
    await goto(desktop, room)
    await composer(desktop).waitFor({ timeout: 60_000 })
    await openConversationsColumn(desktop, 'desktop', fixture.agent.name)
    const started = []
    for (const question of [ALPHA_QUESTION, BETA_QUESTION]) {
      const before = desktop.url()
      await desktop.locator('[data-testid="start-agent-conversation"]').click()
      // A *different* thread each time: matching the shape alone would accept
      // the URL the previous press already put there.
      await desktop.waitForURL((url) => url.href !== before
        && new RegExp(`${fixture.dmRoom.id}/threads/[0-9a-f-]{36}$`, 'u').test(url.pathname))
      const threadId = desktop.url().split('/threads/')[1]
      assert.ok(!started.includes(threadId), 'the second press opens a second thread, not the first')
      // The reader is here to say the first thing; the caret has to be there.
      // The focus is applied on arrival rather than during the navigation, so
      // this waits for it rather than reading once and calling it a verdict.
      await desktop.waitForFunction(
        () => document.activeElement?.getAttribute('contenteditable') === 'true',
        undefined,
        { timeout: 15_000 },
      ).catch(async () => {
        const tag = await desktop.evaluate(() => document.activeElement?.tagName ?? 'none')
        assert.fail(`a newly started conversation must arrive focused; the caret was on ${tag}`)
      })
      assert.equal(
        await composer(desktop).getAttribute('data-placeholder'),
        `Message ${fixture.agent.name}`,
        'the composer names the one agent this conversation reaches',
      )
      await sendMessage(desktop, question)
      started.push(threadId)
    }
    const [alphaThreadId, betaThreadId] = started

    // Renaming is the door that makes two "New conversation" rows tellable
    // apart — and the same door the suite checks refuses a General thread.
    await apiOk(`/api/threads/${alphaThreadId}`, ownerToken, {
      body: JSON.stringify({ title: 'Alpha thread' }), method: 'PATCH',
    })
    await apiOk(`/api/threads/${betaThreadId}`, ownerToken, {
      body: JSON.stringify({ title: 'Beta thread' }), method: 'PATCH',
    })
    const generalRename = await api(`/api/threads/${fixture.privateThread.id}`, ownerToken, {
      body: JSON.stringify({ title: 'Not allowed' }), method: 'PATCH',
    })
    assert.equal(generalRename.status, 400, 'a room’s own thread takes the room’s name')
    assert.equal(generalRename.payload?.error?.code, 'THREAD_TITLE_FIXED',
      'the refusal names the rule rather than a generic validation failure')

    const alphaRun = await waitForRun(pipeline, {
      agentId: fixture.agent.id, threadId: alphaThreadId,
    })
    const betaRun = await waitForRun(pipeline, {
      agentId: fixture.agent.id, threadId: betaThreadId,
    })
    runIds.push(alphaRun.id, betaRun.id)

    // The live dot, while there still is one. The list polls at
    // WATCHING_POLL_MS (5s) and each answer is delayed by the mock, so the
    // window is real but not generous — hence a poll rather than one look.
    await goto(desktop, `${room}/threads/${alphaThreadId}`)
    await openConversationsColumn(desktop, 'desktop', fixture.agent.name)
    const sawLiveDot = await desktop.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-testid="agent-conversation-row"]')]
      return rows.some((row) => row.textContent?.includes('Running now'))
    }, undefined, { timeout: 30_000 }).then(() => true).catch(() => false)
    assert.ok(sawLiveDot, 'a conversation with a run in flight shows the live dot in the list')

    const terminal = await pipeline.waitForTerminalRuns([alphaRun.id, betaRun.id], 90_000)
    assert.equal(terminal.get(alphaRun.id), 'completed', 'the first conversation’s run completes')
    assert.equal(terminal.get(betaRun.id), 'completed', 'the second conversation’s run completes')

    // Every message of the thread, replies included. `GET /api/threads/:id/messages`
    // returns the top-level feed and summarises a reply thread as a count, and
    // an answer to a conversation's opening message lands *under* it: a
    // conversation stamps `replyPlacement: 'thread'`, which
    // `resolveReplyRootMessageId` reads as "attach to the trigger". Isolation is
    // a claim about the thread, so the read has to be the thread.
    const feedOf = async (threadId) => {
      const messages = await pipeline.prisma.message.findMany({
        orderBy: { createdAt: 'asc' }, select: { content: true }, where: { threadId },
      })
      return messages.map((message) => message.content).join('\n')
    }
    const alphaFeed = await feedOf(alphaThreadId)
    const betaFeed = await feedOf(betaThreadId)
    assert.ok(alphaFeed.includes(`Echo: ${ALPHA_QUESTION}`), 'the first conversation got its own reply')
    assert.ok(betaFeed.includes(`Echo: ${BETA_QUESTION}`), 'the second conversation got its own reply')
    assert.equal(alphaFeed.includes(BETA_QUESTION), false,
      'the first conversation holds nothing the second was told')
    assert.equal(betaFeed.includes(ALPHA_QUESTION), false,
      'the second conversation holds nothing the first was told')

    await gallery.capture('start-two', async (page, viewport) => {
      await goto(page, `${room}/threads/${betaThreadId}`)
      await page.waitForFunction((needle) => document.body.innerText.includes(needle),
        BETA_QUESTION, { timeout: 60_000 })
      await openConversationsColumn(page, viewport, fixture.agent.name)
      const titles = await settledRows(page, 4,
        `two conversations and two General rows (${viewport})`)
      assert.ok(titles.some((title) => title.includes('Alpha thread')), 'the first is listed')
      assert.ok(titles.some((title) => title.includes('Beta thread')), 'the second is listed')
      if (viewport === 'phone') return
      // Only a layout that shows both at once can mark the one on screen. On a
      // phone the list *is* the screen, so its `aria-current` is the room's
      // General row and marking Beta there would be a lie.
      const open = await page.locator(
        '[data-testid="agent-conversation-row"][aria-current="true"]',
      ).innerText()
      assert.ok(open.includes('Beta thread'), 'the conversation on screen is the marked row')
    })

    // ---- isolation --------------------------------------------------------
    // The honest proof is on the inference side: not "the feeds differ", which
    // a UI filter could fake, but "no request that carried one question ever
    // carried the other".
    const requests = model.requests()
    const carrying = (needle) => requests.filter((request) =>
      request.messages.some((message) => message.content.includes(needle)))
    const alphaRequests = carrying(ALPHA_QUESTION)
    const betaRequests = carrying(BETA_QUESTION)
    assert.ok(alphaRequests.length > 0, 'the first conversation reached the model at all')
    assert.ok(betaRequests.length > 0, 'the second conversation reached the model at all')
    for (const request of alphaRequests) {
      assert.equal(
        request.messages.some((message) => message.content.includes(BETA_QUESTION)), false,
        'a request carrying the first question also carried the second — the contexts are shared',
      )
    }
    for (const request of betaRequests) {
      assert.equal(
        request.messages.some((message) => message.content.includes(ALPHA_QUESTION)), false,
        'a request carrying the second question also carried the first — the contexts are shared',
      )
    }

    // Concurrency, from the rows the runs themselves wrote: two runs for one
    // agent whose lifetimes overlap. This is the invariant the old one-thread
    // world could not satisfy at all.
    const [alphaRow, betaRow] = await Promise.all([
      pipeline.prisma.run.findUniqueOrThrow({
        where: { id: alphaRun.id }, select: { finishedAt: true, startedAt: true },
      }),
      pipeline.prisma.run.findUniqueOrThrow({
        where: { id: betaRun.id }, select: { finishedAt: true, startedAt: true },
      }),
    ])
    assert.ok(alphaRow.startedAt && betaRow.startedAt, 'both runs recorded a start')
    const overlaps = alphaRow.startedAt <= (betaRow.finishedAt ?? new Date(8.64e15))
      && betaRow.startedAt <= (alphaRow.finishedAt ?? new Date(8.64e15))
    assert.ok(overlaps,
      'two conversations with one agent ran at the same time'
      + ` (alpha ${alphaRow.startedAt?.toISOString()}–${alphaRow.finishedAt?.toISOString()},`
      + ` beta ${betaRow.startedAt?.toISOString()}–${betaRow.finishedAt?.toISOString()})`)

    await gallery.capture('isolation', async (page, viewport) => {
      await goto(page, `${room}/threads/${alphaThreadId}`)
      await page.waitForFunction((needle) => document.body.innerText.includes(needle),
        ALPHA_QUESTION, { timeout: 60_000 })
      const body = await page.locator('body').innerText()
      assert.equal(body.includes(BETA_QUESTION), false,
        `the other conversation's turns are absent from this feed (${viewport})`)
    })

    // ---- visibility -------------------------------------------------------
    const outsiderList = await api(`/api/agents/${fixture.agent.id}/conversations`, outsiderToken)
    assert.equal(outsiderList.status, 404,
      'an agent whose rooms this reader cannot see is not confirmed to exist')
    assert.equal(outsiderList.payload?.error?.code, 'AGENT_NOT_FOUND',
      'the refusal is the ordinary not-found, not a forbidden')
    for (const threadId of [alphaThreadId, betaThreadId]) {
      const read = await api(`/api/threads/${threadId}/conversation`, outsiderToken)
      assert.equal(read.status, 404, 'a conversation in a private room reads as absent')
      assert.equal(read.payload?.error?.code, 'THREAD_NOT_FOUND', 'in the same words as every thread read')
      assert.equal(read.body.includes('Alpha thread') || read.body.includes('Beta thread'), false,
        'the refusal leaks no title')
    }
    // The preview path works when nothing carries a basis — which is what
    // localises the withheld preview on the card case to the delegated path.
    const started2 = await apiOk(`/api/threads/${alphaThreadId}/conversation`, ownerToken)
    assert.equal(started2.lastMessagePreview, `Echo: ${ALPHA_QUESTION}`,
      'a person-started conversation previews its newest message')
    assert.equal(started2.lastRunOutcome, 'completed', 'and carries how its last run ended')
    assert.equal(started2.activeRun, null, 'with nothing still in flight')

    const ownerConversations = await apiOk(
      `/api/agents/${fixture.agent.id}/conversations`, ownerToken,
    )
    assert.equal(ownerConversations.length, 4,
      'the member sees both conversations and both rooms the agent works in')
    assert.equal(
      ownerConversations.filter((record) => record.isGeneral).length, 2,
      'the two General rows arrive through the binding arm of the list rule',
    )
    for (const threadId of [alphaThreadId, betaThreadId]) {
      const record = await apiOk(`/api/threads/${threadId}/conversation`, ownerToken)
      assert.equal(record.id, threadId, 'the member reads the record behind the card')
      assert.equal(record.agentId, fixture.agent.id, 'the record names the agent it is with')
    }
    await gallery.capture('visibility', async (page, viewport) => {
      await goto(page, `${room}/threads/${alphaThreadId}`)
      await page.waitForFunction((needle) => document.body.innerText.includes(needle),
        ALPHA_QUESTION, { timeout: 60_000 })
      const body = await page.locator('body').innerText()
      // The owner's own three widths carry the positive half of the claim; the
      // negative half is the outsider's page, photographed once below.
      assert.ok(body.includes('Alpha thread'), `the member can read it (${viewport})`)
    })
    await goto(outsiderPage, `${room}/threads/${alphaThreadId}`)
    await outsiderPage.waitForTimeout(2_500)
    const outsiderBody = await outsiderPage.locator('body').innerText()
    assert.equal(outsiderBody.includes(ALPHA_QUESTION), false,
      'a non-member’s browser is shown none of the conversation')
    assert.equal(outsiderBody.includes('Alpha thread'), false,
      'a non-member’s browser is not even shown its title')
    await outsiderPage.screenshot({ path: resolve(SCREENSHOTS, 'visibility', 'outsider.png') })

    // ---- card -------------------------------------------------------------
    const card = await exerciseConversationCard({
      api,
      apiOk,
      fixture,
      gallery,
      goto,
      model,
      outsiderPage,
      outsiderToken,
      ownerToken,
      pipeline,
      runIds,
      screenshots: SCREENSHOTS,
      sendMessage,
      title: CONVERSATION_TITLE,
    })

    // ---- phone ------------------------------------------------------------
    await exercisePhoneColumn({
      fixture,
      goto,
      page: gallery.pages.phone,
      screenshots: SCREENSHOTS,
    })

    // ---- agent-page -------------------------------------------------------
    await gallery.capture('agent-page', async (page, viewport) => {
      await goto(page, `/agents/${fixture.agent.id}?agentTab=conversations`)
      await page.locator('[data-testid="agent-conversation-row"]').first().waitFor({ timeout: 60_000 })
      const titles = await settledRows(page, 5,
        `the agent's page lists every conversation the reader may see (${viewport})`)
      assert.ok(titles.some((title) => title.includes('Alpha thread')),
        `the agent's own page lists the same conversations (${viewport})`)
      assert.ok(titles.some((title) => title.includes('Beta thread')), 'both of them')
      assert.ok(titles.some((title) => title.includes(card.title)),
        'including the one the assistant started')
    })

    // ---- standard-room ----------------------------------------------------
    // A room the agent works in, and no way into its conversations from it.
    //
    // This case pins a GAP, not a wanted behaviour. `ChannelsPage.tsx:146` sets
    // `isConversationSurface` from `activeChannel.type === 'dm' ||
    // isPersonalAssistantConversation`, and `resolveConversationAgent`
    // (`admin/src/components/features/channels/channel-tabs.ts:67`) returns
    // null without it — so an ordinary channel with exactly one bound agent has
    // no rail, no header doorway, no "New conversation" button, and its
    // `/tools/conversations` URL renders nothing. Both files predate this
    // branch. Whoever widens `isConversationSurface` will land here: the room
    // IS listed by the API (asserted above), so the only thing missing is the
    // door, and this assertion should be inverted rather than deleted.
    await gallery.capture('standard-room', async (page, viewport) => {
      await goto(page, `/channels/${fixture.privateRoom.id}/tools/conversations`)
      await composer(page).waitFor({ timeout: 60_000 })
      // Long enough for the agent read the doorway depends on to have landed:
      // "absent" has to mean absent, not "not yet".
      await page.waitForTimeout(3_000)
      assert.equal(
        await page.locator('[data-testid="start-agent-conversation"]').count(), 0,
        'GAP: a standard channel the agent is bound to still offers no conversations'
        + ` doorway (${viewport}) — ChannelsPage.tsx:146 / channel-tabs.ts:67.`
        + ' If this now renders, the gap is closed: invert this assertion.',
      )
      assert.equal(
        await page.locator('aside[aria-label="Agent tools"]').count(), 0,
        'GAP: and no rail either, at any width',
      )
    })

    console.log(
      '[agent-conversations e2e] PASS: rail → two isolated conversations → concurrent runs'
      + ' → scoped visibility → live card → phone column → agent page',
    )
  } catch (error) {
    await saveFailureEvidence({
      error,
      model,
      pages: { ...(gallery?.pages ?? {}), outsider: outsiderPage },
      screenshots: SCREENSHOTS,
    })
    throw error
  } finally {
    if (outsiderContext) await outsiderContext.close().catch(() => {})
    if (gallery) await gallery.close()
    if (browser) await browser.close().catch(() => {})
    if (adminServer) await stopProcess(adminServer)
    if (apiServer) await stopProcess(apiServer)
    await pipeline.prisma.user.deleteMany({
      where: { id: { in: [fixture.outsider.id] } },
    }).catch(() => {})
    await cleanupScope(pipeline.prisma, pipeline.pool, fixture.scope, runIds).catch(() => {})
    await pipeline.stop().catch(() => {})
    await model.close().catch(() => {})
  }
}

await main()
