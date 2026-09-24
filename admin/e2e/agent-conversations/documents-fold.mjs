import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

/**
 * A document trigger's review threads are the agent's conversations too, and
 * fold under **Documents** on its list as a ticket's work threads fold under
 * Tickets: closed until asked for, or until one is on screen
 * (docs/standards/document-triggers.md → "Where a change lands").
 *
 * The thread and its wake row are written by the functions the document
 * dispatch writes them with (`ensureDocumentReviewThread`,
 * `writeTicketWorkThreadRow`); the trigger is inserted, because what wakes a
 * real review is a save through the dispatcher — the worker DB suites' claim —
 * and this one is about where the thread lands in a conversation list.
 */
export const seedDocumentReviewThread = async (
  prisma,
  fixture,
  { ensureDocumentReviewThread, writeTicketWorkThreadRow },
) => {
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: fixture.agent.id,
      config: { spaceId: randomUUID(), instructions: { general: 'Review the edit.' } },
      name: 'Review spec edits',
      scopeProjectId: fixture.scope.projectId,
      targetChannelId: fixture.publicRoom.id,
      type: 'document_changed',
    },
  })
  const title = 'Review: Login spec'
  const thread = await prisma.$transaction((tx) => ensureDocumentReviewThread(tx, {
    agentId: fixture.agent.id,
    channelId: fixture.publicRoom.id,
    pageId: randomUUID(),
    title,
    triggerId: trigger.id,
  }))
  await writeTicketWorkThreadRow(prisma, {
    event: {
      kind: 'document_woken', reason: 'document_changed', triggerId: trigger.id,
      summary: 'a person edited the document "Login spec" (v2 → v3)',
    },
    threadId: thread.id,
  })
  return { threadId: thread.id, title }
}

/**
 * On every viewport: the fold arrives closed and counted, its thread is not
 * among the listed conversations, opening it lists the thread; then the
 * thread itself with its wake row, where the Documents fold is open because
 * the thread on screen is in it.
 */
export const exerciseDocumentsFold = async ({
  conversationsPanel, desktop, fixture, gallery, goto, openConversationsColumn, room, rowTitles, screenshots, seeded,
  waitForComposer,
}) => {
  await gallery.capture('documents-fold', async (page, viewport) => {
    await goto(page, room)
    await waitForComposer(page)
    await openConversationsColumn(page, viewport, fixture.agent.name)
    const fold = conversationsPanel(page).last().getByTestId('agent-conversation-documents')
    const toggle = fold.getByRole('button', { name: /Documents/ })
    await toggle.waitFor({ timeout: 30_000 })
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', `the fold arrives closed (${viewport})`)
    assert.match((await toggle.innerText()).replace(/\s+/g, ' '), /Documents 1/i, `it counts its reviews (${viewport})`)
    assert.ok(!(await rowTitles(page)).some((row) => row.includes(seeded.title)),
      `the review thread is folded, not listed among the conversations (${viewport})`)
    await toggle.click()
    const rows = fold.locator('[data-testid="agent-conversation-row"]')
    await rows.first().waitFor({ timeout: 30_000 })
    assert.deepEqual((await rows.allInnerTexts()).map((row) => row.includes(seeded.title)), [true],
      `the review thread opens under Documents (${viewport})`)
  })

  const thread = `/channels/${fixture.publicRoom.id}/threads/${seeded.threadId}`
  await goto(desktop, thread)
  await waitForComposer(desktop)
  const wake = desktop.locator('[data-testid="ticket-work-event-row"]:visible')
  await wake.first().waitFor({ timeout: 30_000 })
  assert.match((await wake.first().innerText()).replace(/\s+/g, ' '),
    /^Woken: a person edited the document "Login spec"/)
  await openConversationsColumn(desktop, 'desktop', fixture.agent.name)
  const open = conversationsPanel(desktop).last().getByTestId('agent-conversation-documents')
    .getByRole('button', { name: /Documents/ })
  await open.waitFor({ timeout: 30_000 })
  assert.equal(await open.getAttribute('aria-expanded'), 'true', 'the fold opens by itself for the thread on screen')
  await desktop.screenshot({ path: resolve(screenshots, 'documents-fold', 'desktop-thread.png') })
}
