// Driving the admin the way a person does: the same rows, the same Back
// button, the same tab strip. Selectors are the ones the components already
// publish (a channel row is `button.admin-sb-item`; Back carries its
// destination as the aria-label; the channel tab strip is labelled "Channel
// sections"), so nothing here needs a test-only hook in admin/src.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ADMIN_URL, SCREENSHOT_ROOT } from './config.mjs'

// A client-side route change still in flight — the tail of a committed swipe,
// say — aborts a document load that starts on top of it. That is a race in
// the harness, not a defect in the app, so the load is retried rather than
// reported.
const gotoStable = async (page, url, attempts = 3) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      return
    } catch (error) {
      const aborted = String(error).includes('ERR_ABORTED')
      if (!aborted || attempt >= attempts) throw error
      await page.waitForTimeout(250)
    }
  }
}

export const gotoChannels = async (page) => {
  await gotoStable(page, `${ADMIN_URL}/channels`)
  await page.waitForSelector('button.admin-sb-item', { timeout: 60_000 })
}

// Any in-shell path, settled: the stack has mounted and its first layer is
// current.
export const gotoPath = async (page, path) => {
  await gotoStable(page, `${ADMIN_URL}${path}`)
  await page.waitForSelector('[data-phone-navigation-viewport] [data-phone-navigation-layer="current"]', { timeout: 60_000 })
}

// A client-side push without a row to tap (the designer has no list entry):
// the same history push a Link performs, followed by the popstate the router
// listens to.
export const pushPath = (page, path) => page.evaluate((next) => {
  window.history.pushState({}, '', next)
  window.dispatchEvent(new PopStateEvent('popstate'))
}, path)

export const gotoChannel = async (page, channelId) => {
  await gotoStable(page, `${ADMIN_URL}/channels/${channelId}`)
  await page.waitForSelector('[aria-label="Channel sections"] button', { timeout: 60_000 })
}

const elementWithText = async (page, selector, text) => {
  const candidates = await page.$$(selector)
  for (const candidate of candidates) {
    const content = (await candidate.textContent()) ?? ''
    if (content.toLowerCase().includes(text.toLowerCase())) return candidate
  }
  return null
}

export const clickChannelRow = async (page, label) => {
  const row = await elementWithText(page, 'button.admin-sb-item', label)
  if (!row) throw new Error(`no channel row matching "${label}" in the list`)
  await row.click()
}

export const clickBackTo = async (page, label) => {
  const selector = `button[aria-label="${label}"]`
  await page.waitForSelector(selector, { timeout: 30_000 })
  await page.click(selector)
}

export const clickChannelTab = async (page, label) => {
  await page.waitForSelector('[aria-label="Channel sections"] button', { timeout: 30_000 })
  const tab = await elementWithText(page, '[aria-label="Channel sections"] button', label)
  if (!tab) throw new Error(`no channel tab named "${label}"`)
  await tab.click()
}

export const selectedChannelTab = (page) => page.evaluate(() => {
  const strip = document.querySelector('[aria-label="Channel sections"]')
  if (!strip) return null
  const selected = [...strip.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-selected') === 'true'
      || button.getAttribute('aria-checked') === 'true',
  )
  return selected?.textContent?.trim() ?? null
})

export const shot = async (page, caseName, frame) => {
  const directory = join(SCREENSHOT_ROOT, caseName)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${frame}.png`)
  await page.screenshot({ path })
  return path
}

// A real edge swipe, dispatched as touchscreen input through CDP so the
// gesture hook receives genuine TouchEvents (every phone/tablet context is
// created with hasTouch). Left edge inwards, then release. Returns the
// released displacement in pixels, which is what decides the settle.
export const edgeSwipe = async (page, { from = 8, steps = 6, to = 300, y = 420 } = {}) => {
  const client = await page.context().newCDPSession(page)
  try {
    const point = (x) => ({ touchPoints: [{ x, y }] })
    await client.send('Input.dispatchTouchEvent', { ...point(from), type: 'touchStart' })
    for (let step = 1; step <= steps; step += 1) {
      const x = from + ((to - from) * step) / steps
      await client.send('Input.dispatchTouchEvent', { ...point(x), type: 'touchMove' })
    }
    await client.send('Input.dispatchTouchEvent', { touchPoints: [], type: 'touchEnd' })
  } finally {
    await client.detach()
  }
  return to - from
}
