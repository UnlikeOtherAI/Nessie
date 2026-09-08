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
  RENAMED_TITLE,
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
const ECHO_LATENCY_MS = 2_500
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

/** The conversations column, whichever width drew it. */
const conversationsPanel = (page) => page.locator('[aria-label^="Conversations with "]')

/**
 * The heading of the screen actually on top.
 *
 * `h1:visible` is enough only because the header's measuring copy is
 * `visibility: hidden`; the *last* one is required because a phone retains the
 * layer being left underneath the layer arriving. The title itself lands with
 * `GET /api/threads/:id/conversation`, not with the navigation, so this waits
 * for it rather than reading once and calling it a verdict.
 */
const expectTopHeading = async (page, expected, message) => {
  await page.waitForFunction((needle) => {
    const nodes = [...document.querySelectorAll('h1')]
      .filter((node) => node.getClientRects().length > 0)
    return nodes.length > 0 && nodes[nodes.length - 1].textContent?.trim() === needle
  }, expected, { timeout: 30_000 }).catch(() => {})
  assert.equal(
    (await page.locator('h1:visible').last().innerText()).trim(), expected, message,
  )
}

/**
 * Send the first thing said in a conversation and read the send's own answer.
 *
 * The claim is the 201 body, not the screen: `POST /api/threads/:id/messages`
 * reports `conversationTitle` on exactly the send that named a still-unnamed
 * conversation, and a client reading it must not have to guess. The listener is
 * armed before the composer is touched, because the request is in flight before
 * the sent text has finished rendering.
 */
const sendNamingMessage = async (page, threadId, text) => {
  const created = page.waitForResponse(
    (response) => response.request().method() === 'POST'
      && response.url().endsWith(`/api/threads/${threadId}/messages`),
    { timeout: 90_000 },
  )
  await sendMessage(page, text)
  const response = await created
  assert.equal(response.status(), 201, `the send was accepted (${text})`)
  const payload = await response.json()
  return payload?.data?.conversationTitle ?? null
}

/**
 * The agents the column is offering, through whichever control this width drew.
 *
 * `TabBar` lays the names out as a `radiogroup` when they fit and collapses to
 * one trigger plus a `listbox` when they do not — a real difference on a 390 px
 * phone, and one the case must read rather than assume either way.
 *
 * Read by accessible name, never by `innerText`: each item draws the agent's
 * avatar beside the name, and the avatar's fallback glyph is inside the text —
 * `aria-hidden`, so it is correctly absent from the name a screen reader is
 * given, and correctly present in the string the DOM holds.
 *
 * At every width this suite uses the panel sits at its 320 px minimum, which
 * is narrower than two agent names, so what actually renders is the collapsed
 * form. The strip branch is kept and exercised the moment a reader has widened
 * the panel; forcing that here (a seeded
 * `nessie.agentConversationsPanelWidth`) was tried and reverted — the widened
 * panel squeezes the shell enough for its sidebar resize handle to sit over
 * the strip and swallow the click, which is a defect of the synthetic width
 * rather than of the strip.
 */
const expectStripAgents = async (page, agents, viewport) => {
  const panel = conversationsPanel(page)
  const trigger = panel.locator('button.tabbar-trigger[aria-label="Agent"]')
  const collapsed = await trigger.count() > 0
  if (collapsed) await trigger.first().click()
  // The collapsed menu is a popover at the document root, so its options are
  // not inside the panel the strip lives in.
  const scope = collapsed ? page : panel
  const role = collapsed ? 'option' : 'radio'
  assert.equal(await scope.getByRole(role).count(), agents.length,
    `the strip offers exactly the room's agents (${viewport})`)
  for (const agent of agents) {
    assert.equal(
      await scope.getByRole(role, { exact: true, name: agent.name }).count(), 1,
      `${agent.name} is on offer under its own name alone (${viewport})`,
    )
    assert.equal(
      await scope.locator(`[data-testid="chat-tool-agent-${agent.id}"]`).count(), 1,
      `and is addressable by its id (${viewport})`,
    )
  }
  if (collapsed) await page.keyboard.press('Escape')
  return collapsed
}

/** Point the column at one of the room's agents, through either control. */
const selectStripAgent = async (page, agent) => {
  const panel = conversationsPanel(page)
  const trigger = panel.locator('button.tabbar-trigger[aria-label="Agent"]')
  const collapsed = await trigger.count() > 0
  if (collapsed) {
    await trigger.first().click()
    await page.locator(`[role="option"][data-testid="chat-tool-agent-${agent.id}"]`).click()
  } else {
    // Driven from the keyboard rather than clicked. `TabBar` roves a
    // radiogroup with the arrow keys, so this is a real path — and it is the
    // only one that works at the width where the strip lays its names out:
    // there the panel is a full-screen layer and the shell's sidebar resize
    // handle is painted over it, swallowing the click (pinned in `room-strip`).
    await panel.getByRole('radio', { checked: true }).first().focus()
    for (let step = 0; step <= 8; step += 1) {
      const landed = await panel
        .getByRole('radio', { checked: true, exact: true, name: agent.name }).count()
      if (landed === 1) break
      assert.notEqual(step, 8, `the strip would not rove to ${agent.name}`)
      await page.keyboard.press('ArrowRight')
    }
  }
  await page.locator(`[aria-label="Conversations with ${agent.name}"]`)
    .waitFor({ timeout: 30_000 })
  // The control says which one it is, not only the panel it narrows: the
  // strip marks its `radiogroup` with `aria-checked`, and the collapsed form
  // names the selection on its own face.
  if (collapsed) {
    assert.ok(
      (await trigger.first().innerText()).includes(agent.name),
      `the collapsed strip names ${agent.name} on its trigger`,
    )
  } else {
    assert.equal(
      await panel.getByRole('radio', { checked: true, exact: true, name: agent.name }).count(),
      1,
      `the strip marks ${agent.name} as the one chosen`,
    )
  }
  return collapsed
}

/**
 * Open the rename dialog from the header action a person can actually press.
 *
 * The action is deliberately not `primary` (`rename-conversation.ts`), so a
 * narrow header sweeps it into "More" rather than dropping it — which is the
 * behaviour worth pinning: both routes reach the same dialog.
 */
const openRenameDialog = async (page) => {
  const direct = page.locator('[data-page-header-action="rename-conversation"]:visible')
  if (await direct.count() > 0) {
    await direct.last().click()
  } else {
    await page.getByRole('button', { name: 'More page actions' }).last().click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
  }
  const dialog = page.getByRole('dialog').filter({ hasText: 'Rename conversation' }).last()
  await dialog.waitFor({ timeout: 30_000 })
  return dialog
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
    // Agent X's own room with A: one agent, so the rail names it without a
    // strip. The ordinary rooms get their own cases at the end.
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
      // Three General rows and no conversations yet: the list rule's second arm
      // is what puts a room the agent merely works in on the list, so both
      // ordinary rooms appear here beside this DM.
      const titles = await settledRows(page, 3,
        `every room the agent is bound to is listed (${viewport})`)
      assert.ok(titles.some((title) => title.includes(fixture.agent.name)),
        'this room’s own General row is named by the room')
      assert.ok(titles.some((title) => title.includes('Pricing room')),
        'and so is the private room the agent is also bound to')
      assert.ok(titles.some((title) => title.includes('Team desk')),
        'and the public room it shares with a second agent')
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
      // Nothing renames these: the first thing said in an empty conversation
      // is its name (`titleConversationFromFirstMessage`), which is what makes
      // two "New conversation" rows tellable apart without anybody typing a
      // title. Asserted three times over, because three different readers
      // depend on it — the send's own response, the header, and the list.
      const named = await sendNamingMessage(desktop, threadId, question)
      assert.equal(named, question,
        'the send that named the conversation reports the name it chose')
      // GAP, pinned rather than glossed — once, on the first conversation:
      // the header goes on saying "New conversation" to the very person who
      // just named it. Not repeated for the second, because the wait it needs
      // would close the window the live-dot case wants a run to still be in.
      //
      // Why: `ChannelsPage` takes the title from `useConversation(threadId)`
      // (`admin/src/facades/threads/hooks.ts`) and nothing on the send path
      // touches that key — `threadKeys.conversation` is written only by
      // `useRenameThread`, and the 201's `conversationTitle` is not read
      // anywhere in the admin. The name IS real (asserted on reload below and
      // in the list), so this is a cache-invalidation gap, not a server one.
      if (started.length === 0) {
        // A settle first, so "still the placeholder" means still.
        await desktop.waitForTimeout(1_500)
        assert.equal(
          (await desktop.locator('h1:visible').last().innerText()).trim(),
          'New conversation',
          'GAP: the conversation header does not take the name its first message'
          + ' just gave it — nothing invalidates threadKeys.conversation on send,'
          + ' and the 201’s conversationTitle is read by nobody. If this now reads'
          + ' the title, the gap is closed: assert `question` instead.',
        )
      }
      started.push(threadId)
    }
    const [alphaThreadId, betaThreadId] = started


    // The same door, refusing the thread that may not be renamed.
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

    // The name is real, and a reader who arrives after it is shown it. This is
    // the positive half of the GAP above: the server named the thread, the
    // header simply never re-read it.
    for (const [namedThreadId, question] of [
      [alphaThreadId, ALPHA_QUESTION], [betaThreadId, BETA_QUESTION],
    ]) {
      await goto(desktop, `${room}/threads/${namedThreadId}`)
      await expectTopHeading(desktop, question,
        'a conversation opened after its first message is named by it')
    }

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
      const titles = await settledRows(page, 5,
        `two conversations and three General rows (${viewport})`)
      assert.ok(titles.some((title) => title.includes(ALPHA_QUESTION)),
        `the first is listed under the name its first message gave it (${viewport})`)
      assert.ok(titles.some((title) => title.includes(BETA_QUESTION)), 'and so is the second')
      if (viewport === 'phone') return
      // Only a layout that shows both at once can mark the one on screen. On a
      // phone the list *is* the screen, so its `aria-current` is the room's
      // General row and marking Beta there would be a lie.
      const open = await page.locator(
        '[data-testid="agent-conversation-row"][aria-current="true"]',
      ).innerText()
      assert.ok(open.includes(BETA_QUESTION), 'the conversation on screen is the marked row')
    })

    // ---- rename -----------------------------------------------------------
    // The doorway, not the endpoint. `PATCH /api/threads/:id` has always taken
    // a rename and `useRenameThread` has always been wired to it; until the
    // header action existed there was nothing a person could press that reached
    // either, which is exactly what Rule zero calls unfinished. So the case
    // presses the control, at every width — on a phone that means through
    // "More", because the action is deliberately not primary.
    await gallery.capture('rename', async (page, viewport) => {
      await goto(page, `${room}/threads/${alphaThreadId}`)
      await expectTopHeading(page, ALPHA_QUESTION, `the header shows the current name (${viewport})`)
      const dialog = await openRenameDialog(page)
      const field = dialog.locator('input').first()
      assert.equal(await field.inputValue(), ALPHA_QUESTION,
        `the field arrives holding the name being changed (${viewport})`)
      assert.equal(await field.getAttribute('maxlength'), '80',
        'and holds the server’s own bound rather than letting a refusal be typed')
      assert.equal(
        await dialog.getByRole('button', { name: 'Save' }).isDisabled(), true,
        'Save commits nothing until something has changed',
      )
    })
    // Cancel closes the desktop copy; the rename itself is done once, there.
    await desktop.getByRole('dialog').last().getByRole('button', { name: 'Cancel' }).click()
    const renameDialog = await openRenameDialog(desktop)
    const renameField = renameDialog.locator('input').first()
    await renameField.press('ControlOrMeta+A')
    await renameField.pressSequentially(RENAMED_TITLE)
    const save = renameDialog.getByRole('button', { name: 'Save' })
    assert.equal(await save.isDisabled(), false, 'a changed title enables Save')
    await save.click()
    await renameDialog.waitFor({ state: 'detached', timeout: 30_000 })
    await expectTopHeading(desktop, RENAMED_TITLE, 'the header takes the new name')
    await openConversationsColumn(desktop, 'desktop', fixture.agent.name)
    await desktop.waitForFunction((needle) => [...document.querySelectorAll(
      '[data-testid="agent-conversation-row"]',
    )].some((row) => row.textContent?.includes(needle)), RENAMED_TITLE, { timeout: 30_000 })
    await desktop.screenshot({ path: resolve(SCREENSHOTS, 'rename', 'desktop-renamed.png') })
    const renamed = await apiOk(`/api/threads/${alphaThreadId}/conversation`, ownerToken)
    assert.equal(renamed.title, RENAMED_TITLE, 'and so does the record behind it')
    // The rule is the server's, not the header's: a reader who cannot see the
    // conversation cannot rename it either, however the request is made.
    const outsiderRename = await api(`/api/threads/${alphaThreadId}`, outsiderToken, {
      body: JSON.stringify({ title: 'Not yours' }), method: 'PATCH',
    })
    assert.ok([403, 404].includes(outsiderRename.status),
      `a reader outside the room may not rename it: ${outsiderRename.status}`)
    assert.equal(outsiderRename.body.includes(RENAMED_TITLE), false,
      'and the refusal leaks no title')

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
    // The same agent, two readers, two lists. B can see X at all only because
    // X is bound to the public room, and what B gets is that room and nothing
    // else: a conversation's audience is its own room's.
    const outsiderList = await apiOk(
      `/api/agents/${fixture.agent.id}/conversations`, outsiderToken,
    )
    assert.equal(outsiderList.length, 1,
      `B sees only the room B is in: ${JSON.stringify(outsiderList.map((row) => row.title))}`)
    assert.equal(outsiderList[0]?.isGeneral, true, 'and sees it as the room’s own thread')
    assert.equal(outsiderList[0]?.channel.id, fixture.publicRoom.id, 'the public room')
    // An agent B may not see at all is not confirmed to exist. A's Personal
    // Assistant is that agent: system-managed, and bound only to A's own DM.
    const outsiderAssistant = await api(
      `/api/agents/${fixture.assistant.agentId}/conversations`, outsiderToken,
    )
    assert.equal(outsiderAssistant.status, 404,
      'another person’s assistant is not confirmed to exist')
    assert.equal(outsiderAssistant.payload?.error?.code, 'AGENT_NOT_FOUND',
      'the refusal is the ordinary not-found, not a forbidden')
    for (const threadId of [alphaThreadId, betaThreadId]) {
      const read = await api(`/api/threads/${threadId}/conversation`, outsiderToken)
      assert.equal(read.status, 404, 'a conversation in a private room reads as absent')
      assert.equal(read.payload?.error?.code, 'THREAD_NOT_FOUND', 'in the same words as every thread read')
      assert.equal(read.body.includes(RENAMED_TITLE) || read.body.includes(BETA_QUESTION), false,
        'the refusal leaks no title')
    }
    // A person-started conversation previews its newest message, which is the
    // control for the delegated path the card case reads.
    const started2 = await apiOk(`/api/threads/${alphaThreadId}/conversation`, ownerToken)
    assert.equal(started2.lastMessagePreview, `Echo: ${ALPHA_QUESTION}`,
      'a person-started conversation previews its newest message')
    assert.equal(started2.lastRunOutcome, 'completed', 'and carries how its last run ended')
    assert.equal(started2.activeRun, null, 'with nothing still in flight')

    const ownerConversations = await apiOk(
      `/api/agents/${fixture.agent.id}/conversations`, ownerToken,
    )
    assert.equal(ownerConversations.length, 5,
      'the member sees both conversations and all three rooms the agent works in')
    assert.equal(
      ownerConversations.filter((record) => record.isGeneral).length, 3,
      'the three General rows arrive through the binding arm of the list rule',
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
      assert.ok(body.includes(RENAMED_TITLE), `the member can read it (${viewport})`)
    })
    await goto(outsiderPage, `${room}/threads/${alphaThreadId}`)
    await outsiderPage.waitForTimeout(2_500)
    const outsiderBody = await outsiderPage.locator('body').innerText()
    assert.equal(outsiderBody.includes(ALPHA_QUESTION), false,
      'a non-member’s browser is shown none of the conversation')
    assert.equal(outsiderBody.includes(RENAMED_TITLE), false,
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
      const titles = await settledRows(page, 6,
        `the agent's page lists every conversation the reader may see (${viewport})`)
      assert.ok(titles.some((title) => title.includes(RENAMED_TITLE)),
        `the agent's own page lists the same conversations (${viewport})`)
      assert.ok(titles.some((title) => title.includes(BETA_QUESTION)), 'both of them')
      const assistantStarted = titles.find((title) => title.includes(card.title))
      assert.ok(assistantStarted, 'including the one the assistant started')
      // The row and the card agree, because they read the same record: the
      // preview is the newest message *this viewer* may read, and the person
      // who asked for the work may read the answer to it.
      assert.ok(assistantStarted.includes(card.preview),
        `the row previews the target's reply (${viewport}): ${JSON.stringify(assistantStarted)}`)
    })

    // ---- room-rail --------------------------------------------------------
    // A room the agent merely works in, and its own way in.
    //
    // This case used to pin the opposite: an ordinary channel had no rail, no
    // header doorway and no "New conversation", because `resolveChatToolAgents`
    // did not exist and the rail insisted on the single subject only a DM has.
    // The rail's agents are now a set, so the room the API has always listed
    // (asserted in `rail`) is reachable from inside itself.
    await gallery.capture('room-rail', async (page, viewport) => {
      await goto(page, `/channels/${fixture.privateRoom.id}`)
      await composer(page).waitFor({ timeout: 60_000 })
      if (viewport !== 'phone') {
        // The rail here is derived from the room's *bindings*, so it lands with
        // `GET /api/agents` rather than with the channel: a rendered composer
        // does not mean the rail has been decided. Reading it without this wait
        // passed on the dev server and failed against the built bundle.
        const labels = page.locator('aside[aria-label="Agent tools"] .admin-rail-btn-label')
        await labels.first().waitFor({ timeout: 30_000 })
        assert.deepEqual(await labels.allInnerTexts(), ['Conversations'],
          `an ordinary room offers the tools its one bound agent has (${viewport})`)
      }
      // Presses this width's own doorway and waits for the panel, the list and
      // the start button — on a phone that press navigates, so the assertion
      // that `/channels/:id/tools/conversations` renders the list is the URL
      // wait inside it.
      await openConversationsColumn(page, viewport, fixture.agent.name)
      assert.equal(
        await conversationsPanel(page).getByRole('radiogroup').count(), 0,
        'a room with one bound agent needs no strip to say whose list this is',
      )
      const titles = await settledRows(page, 6,
        `the room's own doorway opens the agent's whole list (${viewport})`)
      assert.ok(titles.some((title) => title.includes('Pricing room')),
        'including this room’s own General row')
    })

    // ---- room-strip -------------------------------------------------------
    // Two agents in one room: the column is about one of them at a time, and
    // the strip is how a person says which.
    const publicRoom = `/channels/${fixture.publicRoom.id}`
    await gallery.capture('room-strip', async (page, viewport) => {
      await goto(page, publicRoom)
      await composer(page).waitFor({ timeout: 60_000 })
      // It opens on the first-bound agent, so the strip is a real change of
      // subject rather than a confirmation of one.
      await openConversationsColumn(page, viewport, fixture.agent.name)
      await expectStripAgents(page, [fixture.agent, fixture.secondAgent], viewport)
      // GAP, pinned rather than worked around: where this panel opens as a
      // full-screen layer — the tablet band, `split` shell but layered panel —
      // the shell's own sidebar resize handle is still painted over it. It is a
      // full-height rule down the middle of the panel, and it takes the pointer
      // events of everything under its line: here the strip's second agent and
      // part of "New conversation". Reproduced by clicking a strip item whose
      // centre falls on the line; the click times out with the separator named
      // as the interceptor. This is why `selectStripAgent` roves the strip from
      // the keyboard instead.
      const handleOverPanel = await page.evaluate(() => {
        const panel = document.querySelector('[aria-label^="Conversations with "]')
        const handle = document.querySelector('[aria-label="Resize sidebar"]')
        if (!panel || !handle) return null
        const panelBox = panel.getBoundingClientRect()
        const handleBox = handle.getBoundingClientRect()
        return {
          handle: { left: Math.round(handleBox.left), right: Math.round(handleBox.right) },
          over: handleBox.left < panelBox.right && handleBox.right > panelBox.left
            && handleBox.top < panelBox.bottom && handleBox.bottom > panelBox.top,
          panel: { left: Math.round(panelBox.left), right: Math.round(panelBox.right) },
        }
      })
      if (viewport === 'tablet') {
        assert.equal(handleOverPanel?.over, true,
          'GAP: the shell’s sidebar resize handle is drawn over the full-screen'
          + ' conversations panel and swallows every click along its line'
          + ` (${JSON.stringify(handleOverPanel)}). If this is now false the gap`
          + ' is closed: assert false, and click the strip rather than roving it.')
      }
      if (viewport === 'desktop') {
        assert.equal(handleOverPanel?.over ?? false, false,
          'beside a wide conversation the handle stands to the panel’s left')
      }
      await selectStripAgent(page, fixture.secondAgent)
      // The panel's accessible name follows the selection, which is the whole
      // claim: everything below the strip is about the agent it names.
      assert.equal(
        await page.locator(
          `[aria-label="Conversations with ${fixture.agent.name}"]`,
        ).count(), 0,
        `the column stops being about the other agent (${viewport})`,
      )
      await page.locator('[data-testid="start-agent-conversation"]').waitFor({ timeout: 30_000 })
      // The strip's own mark is a pill that *slides*, so a shot taken the
      // instant it is clicked catches it between the two names. The DOM is
      // already correct by then (asserted above); this is for the photograph.
      await page.waitForTimeout(400)
    })

    // Starting one goes to the *selected* agent, not to the room's first.
    const beforeStart = desktop.url()
    await desktop.locator('[data-testid="start-agent-conversation"]').click()
    await desktop.waitForURL((url) => url.href !== beforeStart
      && new RegExp(`${fixture.publicRoom.id}/threads/[0-9a-f-]{36}$`, 'u').test(url.pathname))
    const stripThreadId = desktop.url().split('/threads/')[1]
    const stripThread = await pipeline.prisma.thread.findUniqueOrThrow({
      where: { id: stripThreadId }, select: { agentId: true, channelId: true },
    })
    assert.equal(stripThread.agentId, fixture.secondAgent.id,
      'the new conversation is with the agent the strip named, not the room’s first')
    assert.equal(stripThread.channelId, fixture.publicRoom.id, 'and lives in the room it started from')

    // The choice survives a reload: it is stored per room
    // (`nessie.chatToolAgent.<channelId>`), and the gallery clears only the
    // open-tool key, so reopening the column here reads the stored selection.
    await goto(desktop, publicRoom)
    await composer(desktop).waitFor({ timeout: 60_000 })
    await openConversationsColumn(desktop, 'desktop', fixture.secondAgent.name)

    // A message in a conversation engages that thread's agent structurally —
    // no mention, no judgement — even in a room several agents share.
    await goto(desktop, `${publicRoom}/threads/${stripThreadId}`)
    const STRIP_QUESTION = 'Gamma question three'
    const stripNamed = await sendNamingMessage(desktop, stripThreadId, STRIP_QUESTION)
    assert.equal(stripNamed, STRIP_QUESTION, 'the first message names this one too')
    const stripRun = await waitForRun(pipeline, {
      agentId: fixture.secondAgent.id, threadId: stripThreadId,
    })
    runIds.push(stripRun.id)
    const stripTerminal = await pipeline.waitForTerminalRuns([stripRun.id], 90_000)
    assert.equal(stripTerminal.get(stripRun.id), 'completed',
      'the second agent answered in a room it shares')
    await desktop.waitForFunction((needle) => document.body.innerText.includes(needle),
      `Echo: ${STRIP_QUESTION}`, { timeout: 60_000 })
    const stripReplies = await pipeline.prisma.message.findMany({
      select: { agentId: true, content: true, role: true },
      where: { threadId: stripThreadId, role: 'assistant' },
    })
    assert.ok(stripReplies.length > 0, 'the conversation holds an answer')
    for (const reply of stripReplies) {
      assert.equal(reply.agentId, fixture.secondAgent.id,
        'and only the conversation’s own agent wrote in it — the other bound agent stayed out')
    }
    await desktop.screenshot({ path: resolve(SCREENSHOTS, 'room-strip', 'desktop-answered.png') })

    // Visibility is the room's, not the starter's: B never touched this
    // conversation and is not its starter, and B is in the room.
    const outsiderStrip = await apiOk(
      `/api/agents/${fixture.secondAgent.id}/conversations`, outsiderToken,
    )
    const outsiderStripRow = outsiderStrip.find((record) => record.id === stripThreadId)
    assert.ok(outsiderStripRow,
      `a member of the room reads a conversation somebody else started: ${
        JSON.stringify(outsiderStrip.map((row) => row.title))}`)
    assert.equal(outsiderStripRow.title, STRIP_QUESTION, 'under the name its first message gave it')
    assert.equal(outsiderStripRow.startedByUserId, fixture.owner.id, 'and says who opened it')

    console.log(
      '[agent-conversations e2e] PASS: rail → two isolated conversations, named by their'
      + ' first message → rename → concurrent runs → scoped visibility → live card'
      + ' → phone column → agent page → an ordinary room’s own doorway → the agent strip',
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
