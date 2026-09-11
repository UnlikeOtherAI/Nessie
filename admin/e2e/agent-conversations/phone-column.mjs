import assert from 'node:assert/strict'

import { RENAMED_TITLE } from './fixture.mjs'
import { shot } from './viewports.mjs'

/**
 * The phone's own path to a conversation, which shares no control with the
 * desktop's.
 *
 * There is no rail below `md`: the doorway is a header action, the column is a
 * full screen at its own URL, and Back is the framework's, resolving to the
 * surface's declared parent. That parent is the *room*, not the list — a
 * conversation is a second thread in the channel, and the channel is what it
 * came from — so this asserts one Back, not two.
 *
 * The header renders a hidden measuring copy of every action and of Back, and
 * the room's layer is retained beneath a pushed conversation, so every control
 * here is taken from the visible set and the topmost layer (`.last()`).
 */
export const exercisePhoneColumn = async ({ fixture, goto, page, screenshots }) => {
  const room = `/channels/${fixture.dmRoom.id}`
  await goto(page, room)
  await page.locator('form.admin-compose:visible [contenteditable="true"]').last()
    .waitFor({ timeout: 60_000 })
  await shot(page, screenshots, 'phone', '1-room')

  // `.last()` is the topmost layer's copy; the retained room beneath keeps its
  // own visible one earlier in the DOM.
  const doorway = page.locator('[data-page-header-action="chat-tool-conversations"]:visible').last()
  await doorway.waitFor()
  await doorway.click()
  await page.waitForURL(new RegExp(`/channels/${fixture.dmRoom.id}/tools/conversations$`, 'u'))
  const column = page.locator(`[aria-label="Conversations with ${fixture.agent.name}"]`)
  await column.waitFor()
  const rows = page.locator('[data-testid="agent-conversation-row"]')
  await rows.first().waitFor()
  assert.ok(await rows.count() >= 4, 'the full-screen column lists every conversation')
  await shot(page, screenshots, 'phone', '2-column')

  const target = rows.filter({ hasText: RENAMED_TITLE }).first()
  await target.click()
  await page.waitForURL(/\/channels\/[^/]+\/threads\/[0-9a-f-]{36}$/u)
  await page.waitForFunction(() => document.body.innerText.includes('Alpha question one'),
    undefined, { timeout: 60_000 })
  await expectHeading(page, RENAMED_TITLE,
    'the conversation names itself in the header, not the room it lives in')
  await shot(page, screenshots, 'phone', '3-conversation')

  await page.getByRole('button', { name: 'Back to conversation' }).last().click()
  await page.waitForURL(new RegExp(`/channels/${fixture.dmRoom.id}$`, 'u'))
  await expectHeading(page, fixture.agent.name, 'Back from a conversation lands in its room')
  await shot(page, screenshots, 'phone', '4-back')
}

/**
 * The heading of the screen actually on top.
 *
 * `h1:visible` is not enough on a phone: the layer being left is still mounted
 * and still visible while it slides out, and the header's own title arrives
 * with `GET /api/threads/:id/conversation` rather than with the navigation. So
 * this reads the current layer and waits for it to settle before judging.
 */
const expectHeading = async (page, expected, message) => {
  const heading = page.locator('[data-phone-navigation-layer="current"] h1').last()
  await page.waitForFunction((needle) => {
    const nodes = document.querySelectorAll('[data-phone-navigation-layer="current"] h1')
    return nodes.length > 0 && nodes[nodes.length - 1].textContent?.trim() === needle
  }, expected, { timeout: 30_000 }).catch(() => {})
  assert.equal((await heading.innerText()).trim(), expected, message)
}
