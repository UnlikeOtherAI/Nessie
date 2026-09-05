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

// The shared selection strip (components/primitives/TabBar) becomes a dropdown
// when its labels stop fitting the width it is given — which on a phone is
// exactly what the channel's six sections do. Both shapes carry the same
// accessible name, so a test names the strip and lets these helpers drive
// whichever one is mounted, instead of encoding a shape that depends on how
// wide the labels happen to render.
const stripItems = (label) => `[aria-label="${label}"] button`
const stripTrigger = (label) => `button.tabbar-trigger[aria-label="${label}"]`
const menuOptions = (label) => `[role="listbox"][aria-label="${label}"] .tabbar-option`

export const waitForTabBar = (page, label) => page.waitForSelector(
  `${stripItems(label)}, ${stripTrigger(label)}`,
  { timeout: 60_000 },
)

export const selectedTab = (page, label) => page.evaluate((name) => {
  // The trigger is itself the element carrying the name, so it must be read
  // before the strip lookup — which would otherwise match the trigger and find
  // no selected item inside it.
  const trigger = document.querySelector(`button.tabbar-trigger[aria-label="${name}"]`)
  if (trigger) return trigger.querySelector('.tabbar-trigger-label')?.textContent?.trim() ?? null
  const strip = document.querySelector(`[aria-label="${name}"]`)
  const selected = strip?.querySelector('[aria-selected="true"], [aria-checked="true"]')
  return selected?.textContent?.trim() ?? null
}, label)

export const clickTab = async (page, label, text) => {
  await waitForTabBar(page, label)
  const trigger = await page.$(stripTrigger(label))
  if (!trigger) {
    const tab = await elementWithText(page, stripItems(label), text)
    if (!tab) throw new Error(`no "${label}" tab named "${text}"`)
    await tab.click()
    return
  }
  await trigger.click()
  await page.waitForSelector(menuOptions(label), { timeout: 30_000 })
  const option = await elementWithText(page, menuOptions(label), text)
  if (!option) throw new Error(`no "${label}" option named "${text}"`)
  await option.click()
  // The menu closes through the shared overlay's closing motion, so the tab
  // switch is not settled the moment the option is released.
  await page.waitForSelector(menuOptions(label), { state: 'hidden', timeout: 30_000 })
}

export const gotoChannel = async (page, channelId) => {
  await gotoStable(page, `${ADMIN_URL}/channels/${channelId}`)
  await waitForTabBar(page, 'Channel sections')
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
  // The navigation shell mounts before its channel query resolves. Waiting for
  // any sidebar button in gotoChannels is enough for a page load, but not to
  // act on one of the freshly seeded rows.
  await page.waitForFunction(
    ({ selector, text }) => [...document.querySelectorAll(selector)].some(
      (row) => row.textContent?.toLowerCase().includes(text.toLowerCase()),
    ),
    { selector: 'button.admin-sb-item', text: label },
    { timeout: 30_000 },
  )
  const row = await elementWithText(page, 'button.admin-sb-item', label)
  if (!row) throw new Error(`no channel row matching "${label}" in the list`)
  await row.click()
}

export const clickBackTo = async (page, label) => {
  const selector = `button[aria-label="${label}"]`
  await page.waitForSelector(selector, { timeout: 30_000 })
  await page.click(selector)
}

export const clickChannelTab = (page, label) => clickTab(page, 'Channel sections', label)

export const selectedChannelTab = (page) => selectedTab(page, 'Channel sections')

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
