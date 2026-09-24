import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'

/**
 * What both halves of the agent-triggers runner share: where the shots go,
 * the two widths every state is shot at, and how a scenario is opened.
 */

export const SHOTS = resolve(REPO_ROOT, 'e2e/screenshots/agent-triggers')
export const VIEWPORTS = [
  { name: 'desktop', options: { viewport: { height: 800, width: 1280 } } },
  { name: 'phone', options: { hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } } },
]

export const shot = (name, width) => resolve(SHOTS, `${name}-${width}.png`)

export const settled = async (page) => {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'))
  await page.waitForTimeout(150)
}

export const openPage = async (browser, options, scenario) => {
  const context = await browser.newContext(options)
  // Nothing leaves for a real API: the session read is signed out, anything else is not in the fixture.
  await context.route('**/api/**', (route) => route.fulfill({
    body: '{"error":{"message":"not in fixture"}}', contentType: 'application/json',
    status: new URL(route.request().url()).pathname === '/api/auth/me' ? 401 : 404,
  }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${ADMIN_URL}/e2e/agent-triggers/index.html?scenario=${scenario}`)
  await page.locator('[data-ready="true"]').waitFor()
  return { context, errors, page }
}

export const openDialog = async (browser, options, scenario) => {
  const opened = await openPage(browser, options, scenario)
  const dialog = opened.page.getByRole('dialog', { name: 'Create a trigger' })
  await dialog.waitFor()
  await settled(opened.page)
  return { ...opened, dialog }
}

export const assertNoSidewaysScroll = async (page, label) => {
  const { inner, scroll } = await page.evaluate(() => ({
    inner: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  assert.ok(scroll <= inner, `${label}: the page scrolls sideways (${scroll} > ${inner})`)
}

export const fixtureState = (page) => page.evaluate(() => window.__agentTriggersFixture)

export const posted = async (page) => (await fixtureState(page)).posted
