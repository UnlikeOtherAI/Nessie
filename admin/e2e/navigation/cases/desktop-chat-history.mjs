// A real 50-row cursor boundary in the desktop chat. The first page must open
// at the newest message; reaching its top requests older rows and preserves the
// first existing row at the same visual offset while those rows prepend.
import { createChecks } from '../lib/expect.mjs'
import { gotoChannel, shot } from '../lib/page.mjs'
import { seedMessageHistory } from '../lib/seed.mjs'

const SCROLLER = '[data-testid="channel-content-scroll"]'
const ROW = `${SCROLLER} [data-message-id]`

export const desktopChatHistory = {
  name: 'desktop-chat-history',
  run: async ({ page, seed }) => {
    const checks = createChecks('desktop-chat-history')
    const channel = seed.channels[0]
    await seedMessageHistory(seed.token, channel.defaultThreadId)

    // Hold the cursor response briefly so the loading state is real and can be
    // inspected in the saved frame; the request and response still hit the API.
    await page.route('**/api/threads/**/messages?before=*', async (route) => {
      await new Promise((done) => { setTimeout(done, 400) })
      await route.continue()
    })
    await gotoChannel(page, channel.id)
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 50,
      ROW,
      { timeout: 60_000 },
    )

    const initialCount = await page.locator(ROW).count()
    const response = page.waitForResponse((candidate) => {
      const url = new URL(candidate.url())
      return url.pathname === `/api/threads/${channel.defaultThreadId}/messages`
        && url.searchParams.has('before')
        && candidate.ok()
    })
    const anchor = await page.evaluate(({ row, scroller }) => {
      const container = document.querySelector(scroller)
      if (!(container instanceof HTMLElement)) return null
      container.scrollTop = 0
      const first = document.querySelector(row)
      if (!(first instanceof HTMLElement)) return null
      const offset = first.getBoundingClientRect().top - container.getBoundingClientRect().top
      container.dispatchEvent(new Event('scroll'))
      return { id: first.dataset.messageId, offset }
    }, { row: ROW, scroller: SCROLLER })

    await page.getByText('Loading earlier messages…').waitFor({ state: 'visible' })
    const frames = [await shot(page, 'desktop-chat-history', '00-loading')]
    const olderResponse = await response
    await page.waitForFunction(
      ({ count, selector }) => document.querySelectorAll(selector).length > count,
      { count: initialCount, selector: ROW },
      { timeout: 30_000 },
    )

    const settled = await page.evaluate(({ anchorId, scroller }) => {
      const container = document.querySelector(scroller)
      const anchorRow = anchorId
        ? document.querySelector(`[data-message-id="${CSS.escape(anchorId)}"]`)
        : null
      if (!(container instanceof HTMLElement) || !(anchorRow instanceof HTMLElement)) return null
      return {
        count: container.querySelectorAll('[data-message-id]').length,
        offset: anchorRow.getBoundingClientRect().top - container.getBoundingClientRect().top,
        scrollTop: container.scrollTop,
      }
    }, { anchorId: anchor?.id, scroller: SCROLLER })

    checks.equal('the newest API window contains 50 rows', initialCount, 50)
    checks.ok('scrolling upward sends an opaque before cursor', new URL(olderResponse.url()).searchParams.has('before'))
    checks.ok('the older page adds rows to the rendered history', Boolean(settled && settled.count > initialCount), JSON.stringify(settled))
    checks.near('the existing top row keeps its viewport offset', settled?.offset, anchor?.offset, 1)
    checks.ok('the prepend compensation moves the scroll position down', Boolean(settled && settled.scrollTop > 0), JSON.stringify(settled))

    await page.locator(SCROLLER).evaluate((element) => { element.scrollTop = 0 })
    frames.push(await shot(page, 'desktop-chat-history', '01-older-history'))
    checks.close()
    return { checks: checks.checks, frames }
  },
  viewport: 'desktop',
}
