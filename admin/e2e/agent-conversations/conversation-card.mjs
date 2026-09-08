import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { plantConversationRef, waitForRun } from './fixture.mjs'
import { CONVERSATION_ROUTING_MARKER, START_PHRASE } from './mock-server.mjs'

/**
 * The assistant opens a conversation with another agent, and says so with a
 * card.
 *
 * Four claims, in order: the assistant was *told* it could (the routing block
 * and the tool are in its request, so nothing here is a lucky guess by a
 * scripted model); the doorway is server-written metadata rather than model
 * text; the card renders the run's live state and then its outcome without
 * holding either; and a reader who is not privy to the destination gets the
 * withheld idiom instead of a silent gap.
 */
export const exerciseConversationCard = async ({
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
  screenshots,
  sendMessage,
  title,
}) => {
  const desktop = gallery.pages.desktop
  const assistantRoom = `/channels/${fixture.assistant.channelId}`
  await goto(desktop, assistantRoom)

  const ask = `Please ${START_PHRASE} ${fixture.agent.name} about the pricing page copy`
  await sendMessage(desktop, ask)

  const assistantRun = await waitForRun(pipeline, {
    agentId: fixture.assistant.agentId,
    threadId: fixture.assistant.threadId,
  })
  runIds.push(assistantRun.id)

  // The doorway message, written in the same transaction as the opener.
  const doorway = await waitForDoorway(pipeline, fixture.assistant.threadId)
  const reference = doorway.metadata.conversationRef
  assert.equal(reference.schemaVersion, 1, 'the doorway declares its schema version')
  assert.equal(reference.agentId, fixture.agent.id, 'the doorway names the agent it points at')
  assert.equal(
    doorway.content,
    `Started a conversation with ${fixture.agent.name}: "${title}".`,
    'the doorway says what was started, in the server’s own words',
  )
  runIds.push(...(await pipeline.prisma.run.findMany({
    select: { id: true }, where: { threadId: reference.threadId },
  })).map((run) => run.id))

  // The assistant was told about the door before it opened it. Read from the
  // request the mock captured, not from the source: a prompt block that stopped
  // being assembled would still be in the file.
  const assistantRequests = model.requests().filter((request) =>
    request.messages.some((message) => message.content.includes(ask)))
  assert.ok(assistantRequests.length > 0, 'the assistant’s ask reached the model')
  const first = assistantRequests[0]
  assert.ok(
    first.messages.some((message) =>
      message.role === 'system' && message.content.includes(CONVERSATION_ROUTING_MARKER)),
    'the assistant’s system prompt carries the conversation-routing block',
  )
  assert.ok(
    first.toolNames.includes('agent_conversation_start'),
    `the tool was offered in the request: ${JSON.stringify(first.toolNames.slice(0, 40))}`,
  )
  // The block is keyed on the toolset, so an agent without the tool must not
  // carry it — the target agent's own request is the control.
  const targetRequests = model.requests().filter((request) =>
    request.messages.some((message) => message.content.includes('pricing page copy'))
    && !request.toolNames.includes('agent_conversation_start'))
  if (targetRequests.length > 0) {
    assert.equal(
      targetRequests[0].messages.some((message) =>
        message.content.includes(CONVERSATION_ROUTING_MARKER)),
      false,
      'an agent without the tool is not told about the door',
    )
  }

  // Where the card actually is.
  //
  // Not the room's own feed: an assistant run answers under the message that
  // triggered it (`replyPlacement: 'thread'` →
  // `worker/src/run/execute/reply-placement.ts` attaches to the trigger), and
  // the doorway is written through the same door as the answer. So the card
  // sits inside the reply thread under the person's request, behind a
  // "2 replies" summary — which is not what
  // docs/plans/2026-09-08-agent-conversations.md § "The conversation card"
  // describes ("a live card in its own chat … without being told to go and
  // look"). The suite opens that reply thread rather than pretending the card
  // is one screen closer than it is.
  const cardSurface = doorway.rootMessageId
    ? `${assistantRoom}/threads/${fixture.assistant.threadId}`
      + `/replies/${doorway.rootMessageId}`
    : assistantRoom

  // Running — while the target's answer is still delayed by the mock.
  await gallery.capture('card-running', async (page, viewport) => {
    await goto(page, cardSurface)
    const card = page.locator('[data-testid="conversation-card"]').first()
    await card.waitFor({ timeout: 60_000 })
    // The loading shell carries the same testid as the resolved card — by
    // design, so the doorway never flickers in and out of the feed — so the
    // wait is for the title, not for the element.
    await page.waitForFunction((needle) => {
      const node = document.querySelector('[data-testid="conversation-card"]')
      return (node?.textContent ?? '').includes(needle)
    }, title, { timeout: 60_000 }).catch(() => {})
    assert.ok((await card.innerText()).includes(title),
      `the card names the conversation it points at (${viewport})`)
  })

  const targetRun = await waitForRun(pipeline, {
    agentId: fixture.agent.id, threadId: reference.threadId,
  })
  const terminal = await pipeline.waitForTerminalRuns(
    [assistantRun.id, targetRun.id], 90_000,
  )
  assert.equal(terminal.get(targetRun.id), 'completed', 'the conversation the assistant started completes')

  // Done — the same card, no reload of its own state, just the record moving on.
  await gallery.capture('card-done', async (page, viewport) => {
    await goto(page, cardSurface)
    const card = page.locator('[data-testid="conversation-card"]').first()
    await card.waitFor({ timeout: 60_000 })
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="conversation-card"]')
      return (node?.textContent ?? '').includes('Done')
    }, undefined, { timeout: 60_000 })
    const text = await card.innerText()
    assert.ok(text.includes('Done'), `a finished conversation reads Done (${viewport})`)
    // GAP, pinned rather than glossed: the body line should be the newest
    // readable message and instead reads "Nothing said yet" for every
    // conversation the assistant starts.
    //
    // Why: this tool stamps the opener with the requester's PA-DM lineage
    // (`insertPrivateConversationSources`, worker/src/run/pa-tools/agent-conversations.ts),
    // the target's run consumes that source when it reads the opener
    // (worker/src/run/execute/prompt.ts:392), and its reply therefore carries a
    // `message_basis_scopes` row for the assistant's DM — a scope this very
    // reader satisfies. `loadLastMessagePreviews`
    // (packages/team-admin/src/agent-conversations.ts:241) then fails closed on
    // *any* basis rather than on an unsatisfied one, so the preview is null.
    // A person-started conversation is unaffected (see `start-two`), which is
    // what localises this to the delegated path.
    assert.ok(
      text.includes('Nothing said yet'),
      'GAP: an assistant-started conversation shows no preview on its own card'
      + ` (${viewport}); if this now shows the reply, the gap is closed —`
      + ` assert the reply instead. Card read: ${JSON.stringify(text)}`,
    )
  })

  // The whole card is the way in.
  await desktop.locator('[data-testid="conversation-card"]').first()
    .getByRole('link', { name: `Open ${title}` }).click()
  await desktop.waitForURL(new RegExp(`/threads/${reference.threadId}$`, 'u'))

  // The other reader. The API is the boundary; the planted doorway proves the
  // card itself resolves per viewer rather than trusting what it was handed.
  const outsiderRead = await api(`/api/threads/${reference.threadId}/conversation`, outsiderToken)
  assert.equal(outsiderRead.status, 404, 'the assistant’s DM conversation reads as absent to anyone else')
  const ownerRead = await apiOk(`/api/threads/${reference.threadId}/conversation`, ownerToken)
  assert.equal(ownerRead.title, title, 'and as itself to the person it belongs to')
  assert.equal(ownerRead.lastRunOutcome, 'completed', 'carrying the outcome the card shows')
  assert.equal(
    ownerRead.lastMessagePreview, null,
    'GAP (the record behind the card): the preview the reader is entitled to is'
    + ' withheld — see the note on the card-done case',
  )

  await plantConversationRef(pipeline.prisma, {
    agentId: fixture.agent.id,
    channelId: reference.channelId,
    into: fixture.publicThread.id,
    threadId: reference.threadId,
  })
  const publicRoom = `/channels/${fixture.publicRoom.id}`
  await gallery.capture('card-withheld', async (page, viewport) => {
    await goto(page, publicRoom)
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="conversation-card"]')
      return (node?.textContent ?? '').includes('Done')
    }, undefined, { timeout: 60_000 })
    assert.ok(
      (await page.locator('[data-testid="conversation-card"]').first().innerText()).includes(title),
      `the same pointer resolves for the person who may read it (${viewport})`,
    )
  })
  await goto(outsiderPage, publicRoom)
  await outsiderPage.locator('[data-testid="conversation-card"]').first().waitFor({ timeout: 60_000 })
  // The skeleton and the resolved card share a testid, so wait for the verdict
  // rather than for the element.
  await outsiderPage.waitForFunction(() => {
    const node = document.querySelector('[data-testid="conversation-card"]')
    return (node?.textContent ?? '').trim().length > 0
  }, undefined, { timeout: 60_000 })
  const withheld = await outsiderPage.locator('[data-testid="conversation-card"]').first().innerText()
  assert.ok(withheld.includes('conversation you can’t see'),
    `a reader outside the room gets the withheld idiom, not a gap: ${withheld}`)
  assert.equal(withheld.includes(title), false, 'and is not told the title through the placeholder')
  await outsiderPage.screenshot({ path: resolve(screenshots, 'card-withheld', 'outsider.png') })

  return { threadId: reference.threadId, title }
}

const waitForDoorway = async (pipeline, threadId, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const message = await pipeline.prisma.message.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { content: true, id: true, metadata: true, rootMessageId: true },
      where: { metadata: { path: ['conversationRef', 'schemaVersion'], equals: 1 }, threadId },
    })
    if (message) return message
    await new Promise((done) => { setTimeout(done, 200) })
  }
  throw new Error(`No conversation doorway was written into thread ${threadId}`)
}
