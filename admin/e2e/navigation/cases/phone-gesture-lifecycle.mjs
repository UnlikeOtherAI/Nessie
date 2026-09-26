import assert from 'node:assert/strict'
import { webkit } from 'playwright-core'
import { call } from '../lib/seed.mjs'
import { clickChannelRow, gotoChannels, gotoPath, pushPath, shot } from '../lib/page.mjs'
import { waitForStackSettled } from '../lib/freeze.mjs'
import { startGesture } from '../lib/gesture.mjs'

const current = '[data-phone-navigation-layer="current"]'
const settle = async (page) => {
  await page.waitForFunction(() => {
    const viewport = document.querySelector('[data-phone-navigation-viewport]')
    return viewport && !viewport.dataset.phoneNavigationDirection
      && viewport.dataset.phoneNavigationGesture === 'idle'
  })
  await waitForStackSettled(page)
}
const shell = (page, platform) => page.addInitScript((platform) => {
  window.__nessieNativeShell = { formFactor: 'phone', platform }
  window.__navigationTransitions = []
  window.ReactNativeWebView = { postMessage: (raw) => {
    const message = JSON.parse(raw)
    if (message.type === 'nessie:screen-transition') window.__navigationTransitions.push(message)
  } }
}, platform)
const back = async (page, platform) => {
  await page.evaluate((platform) => {
    if (platform === 'android') window.__nessieNativeBack()
    else window.__nessieScreenBarBack()
  }, platform)
  await settle(page)
}

const runJourney = async (page, seed, name, platform) => {
  page.setDefaultNavigationTimeout(120_000)
  const checks = []
  const frames = []
  const check = (label, passed) => {
    assert.ok(passed, label)
    checks.push({ label, passed })
  }
  await shell(page, platform)
  await gotoChannels(page)
  await clickChannelRow(page, seed.channels[0].slug)
  await settle(page)
  const channelPath = `/channels/${seed.channels[0].id}`
  await page.waitForURL(`**${channelPath}`)

  const before = await page.evaluate(() => window.__navigationTransitions.length)
  let gesture = await startGesture(page)
  await gesture.move(60)
  await gesture.move(125)
  const dragX = await page.locator(current).evaluate((el) => el.getBoundingClientRect().x)
  check('screen follows the finger', dragX > 100 && dragX < 130)
  frames.push(await shot(page, name, 'channel-drag'))
  // A stationary release below the distance threshold must cancel.
  await page.waitForTimeout(150)
  await gesture.end(125)
  await settle(page)
  check('short swipe keeps the channel', new URL(page.url()).pathname === channelPath)
  check('cancel emits no false native header transition',
    await page.evaluate(() => window.__navigationTransitions.length) === before)

  gesture = await startGesture(page)
  await gesture.move(270)
  await gesture.move(200)
  await gesture.move(160)
  await gesture.end(160)
  await settle(page)
  check('reversed swipe keeps the channel', new URL(page.url()).pathname === channelPath)

  const channel = seed.channels[0]
  const { message: root } = await call(`/api/threads/${channel.defaultThreadId}/messages`, {
    body: { content: `Mobile navigation ${name}` }, method: 'POST', token: seed.token,
  })
  const message = page.locator(`${current} [data-message-id="${root.id}"]`)
  await message.tap()
  await message.getByRole('button', { name: 'Reply in thread', exact: true }).click()
  await settle(page)
  const panel = page.locator(`${current} .thread-panel`)
  await panel.waitFor({ state: 'visible' })
  await panel.getByText(`Mobile navigation ${name}`, { exact: true }).waitFor()
  const initial = await panel.boundingBox()
  frames.push(await shot(page, name, 'thread-rest'))
  gesture = await startGesture(page)
  await gesture.move(80)
  await gesture.move(130)
  const moving = await panel.boundingBox()
  check('fixed thread keeps its vertical position when a swipe starts', Math.abs(initial.y - moving.y) < 1)
  check('fixed thread follows its screen horizontally', moving.x - initial.x > 110)
  frames.push(await shot(page, name, 'thread-drag'))
  await page.waitForTimeout(150)
  await gesture.end(130)
  await settle(page)
  const cancelled = await panel.boundingBox()
  check('thread returns without a position jump', Math.abs(initial.y - cancelled.y) < 1
    && Math.abs(initial.x - cancelled.x) < 1)

  // Native Back (including Android hardware Back's exact bridge) uses the
  // same paired route animation as the visible Back control.
  await back(page, platform)
  check('native Back returns from thread to channel', new URL(page.url()).pathname === channelPath)
  // A history traversal completes in a later task. Hold that task back to
  // expose any frame where the released detail returns before popstate.
  await page.evaluate(() => {
    const go = history.go.bind(history)
    history.go = (delta) => {
      window.__releaseNavigationPop = () => { history.go = go; go(delta) }
    }
  })
  gesture = await startGesture(page)
  await gesture.move(120)
  await gesture.move(260)
  await gesture.move(335)
  await gesture.end(335)
  await page.waitForFunction(() => typeof window.__releaseNavigationPop === 'function')
  const held = await page.locator(current).boundingBox()
  check('finished swipe stays offscreen while browser Back is pending', held.x >= 389)
  frames.push(await shot(page, name, 'back-awaiting-history'))
  await page.evaluate(() => window.__releaseNavigationPop())
  await settle(page)
  check('committed swipe returns to the channel menu', new URL(page.url()).pathname === '/channels')
  check('no released layer survives the commit', await page.locator('[data-phone-navigation-layer="outgoing"]').count() === 0)
  frames.push(await shot(page, name, 'channel-menu'))

  await gotoPath(page, '/projects')
  await pushPath(page, `/projects/${seed.project.id}`)
  await settle(page)
  frames.push(await shot(page, name, 'project'))
  await back(page, platform)
  check('project Back returns to Projects', new URL(page.url()).pathname === '/projects')
  await pushPath(page, `/projects/${seed.project.id}`)
  await settle(page)
  gesture = await startGesture(page)
  await gesture.move(130)
  await gesture.move(320)
  await gesture.end(320)
  await settle(page)
  check('project swipe returns to Projects', new URL(page.url()).pathname === '/projects')
  frames.push(await shot(page, name, 'project-menu'))

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await pushPath(page, channelPath)
  await settle(page)
  gesture = await startGesture(page)
  await gesture.move(150)
  await gesture.move(330)
  await gesture.end(330)
  await settle(page)
  check('reduced-motion swipe still commits once', new URL(page.url()).pathname === '/channels')
  return { checks, frames }
}

export const phoneGestureLifecycleCases = ['ios', 'android', 'webkit'].map((kind) => ({
  name: `phone-gesture-${kind}`,
  viewport: 'phone',
  run: async ({ page, seed }) => {
    const name = `phone-gesture-${kind}`
    if (kind !== 'webkit') return runJourney(page, seed, name, kind)
    const browser = await webkit.launch({ headless: true })
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
      await context.addInitScript((token) => localStorage.setItem('nessie.admin.token', token), seed.token)
      return await runJourney(await context.newPage(), seed, name, 'ios')
    } finally {
      await browser.close()
    }
  },
}))
