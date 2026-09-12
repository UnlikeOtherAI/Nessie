import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const screenshotDirectory = 'e2e/screenshots/project-usability/app-connect-scope'
const screenshots = resolve(REPO_ROOT, screenshotDirectory)
const menuScreenshotPath = resolve(screenshots, 'project-audience-compact-menu.png')
const projectScreenshotPath = resolve(screenshots, 'project-audience-compact-project.png')
const reviewScreenshotPath = resolve(screenshots, 'mixed-pending-review-doorway.png')
const recoveryScreenshotPath = resolve(screenshots, 'account-recovery-actions.png')
const recoveryFailureScreenshotPath = resolve(screenshots, 'account-recovery-failure.png')
const admin = await startAdmin()
const browser = await launchBrowser()
let page
try {
  const context = await browser.newContext({ viewport: { height: 720, width: 1280 } })
  page = await context.newPage()
  await page.goto(`${ADMIN_URL}/e2e/app-connect-scope/index.html`)
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--layer-modal') === '70')
  const audience = page.getByLabel('Choose who this app connection is for')
  await audience.waitFor()
  await audience.click()
  const menu = page.getByRole('listbox', { name: 'Choose who this app connection is for' })
  await menu.waitFor()
  const project = menu.getByRole('option', { name: 'A project' })
  await project.waitFor()
  await menu.evaluate(async (element) => {
    const animations = element.getAnimations({ subtree: true })
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
  })
  const hitTest = await project.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const elements = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      topmost: elements[0] === element || element.contains(elements[0]),
      stack: elements.slice(0, 3).map((node) => `${node.tagName}.${node.className}`),
    }
  })
  assert.equal(hitTest.topmost, true, `project option must be topmost over its modal owner: ${hitTest.stack.join(', ')}`)
  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ fullPage: true, path: menuScreenshotPath })
  await page.keyboard.press('Escape')
  await page.getByRole('listbox', { name: 'Choose who this app connection is for' }).waitFor({ state: 'hidden' })
  await page.getByRole('heading', { name: 'Review connection to KiloTalk fixture' }).waitFor()
  await audience.click()
  await project.waitFor()
  await project.click()
  await page.getByTestId('app-connect-project-picker').waitFor()
  assert.equal(await page.getByTestId('app-connect-confirm').isDisabled(), true)
  assert.equal(await page.evaluate(() => window.__appConnectScopeFixture.calls.length), 0)
  await page.screenshot({ fullPage: true, path: projectScreenshotPath })
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('heading', { name: 'Review connection to KiloTalk fixture' }).waitFor({ state: 'hidden' })
  const review = page.getByRole('link', { name: 'Review capabilities' })
  await review.waitFor()
  assert.equal(
    await review.getAttribute('href'),
    '/agents/tools?status=pending_review&instance=44444444-4444-4444-8444-444444444444',
  )
  await page.screenshot({ fullPage: true, path: reviewScreenshotPath })
  await page.evaluate(() => { window.__appConnectScopeFixture.policyCalls.length = 0 })
  await page.getByRole('switch').click()
  await page.waitForFunction(() => window.__appConnectScopeFixture.policyCalls.length >= 3)
  await page.waitForTimeout(150)
  const policyCalls = await page.evaluate(() => window.__appConnectScopeFixture.policyCalls)
  assert.deepEqual(
    policyCalls,
    [
      '/api/mcp/tools/tool-active-a/policy-targets/99999999-9999-4999-8999-999999999999',
      '/api/mcp/tools/tool-active-b/policy-targets/99999999-9999-4999-8999-999999999999',
      '/api/mcp/tools/tool-active-c/policy-targets/99999999-9999-4999-8999-999999999999',
      '/api/mcp/tools/policy-targets',
    ],
  )
  await page.evaluate(() => {
    window.__appConnectScopeFixture.failPolicyPatchAt = 2
    window.__appConnectScopeFixture.policyCalls.length = 0
  })
  await page.getByRole('switch').click()
  await page.waitForFunction(() => window.__appConnectScopeFixture.policyCalls.length >= 3)
  await page.waitForTimeout(150)
  assert.deepEqual(
    await page.evaluate(() => window.__appConnectScopeFixture.policyCalls),
    [
      '/api/mcp/tools/tool-active-a/policy-targets/99999999-9999-4999-8999-999999999999',
      '/api/mcp/tools/tool-active-b/policy-targets/99999999-9999-4999-8999-999999999999',
      '/api/mcp/tools/policy-targets',
    ],
  )
  await page.getByText('Only 1 of 3 capabilities changed — rate limited').waitFor()
  const recovery = page.getByLabel('Account recovery fixture')
  await recovery.getByRole('button', { name: 'Reconnect' }).waitFor()
  await page.screenshot({ fullPage: true, path: recoveryScreenshotPath })
  await recovery.getByRole('button', { name: 'Reconnect' }).click()
  await page.getByRole('heading', { name: 'Reconnect KiloTalk fixture' }).waitFor()
  await page.waitForFunction(
    () => window.__appConnectScopeFixture.calls.some((call) => call.path.endsWith('/reconnect')),
  )
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('heading', { name: 'Reconnect KiloTalk fixture' }).waitFor({ state: 'hidden' })
  await recovery.getByRole('button', { name: 'Refresh capabilities' }).click()
  const refreshStatus = page.getByText('Capabilities updated: 3 available.', { exact: true })
  await refreshStatus.waitFor()
  assert.equal(await refreshStatus.getAttribute('role'), 'status')
  await page.evaluate(() => { window.__appConnectScopeFixture.refreshFailure = 'probe' })
  await recovery.getByRole('button', { name: 'Refresh capabilities' }).click()
  await recovery.getByText('Capabilities could not be refreshed. Reconnect this account to repair it.').waitFor()
  await recovery.getByRole('button', { name: 'Reconnect' }).waitFor()
  await page.evaluate(() => { window.__appConnectScopeFixture.refreshFailure = 'request' })
  await recovery.getByRole('button', { name: 'Refresh capabilities' }).click()
  await recovery.getByText("We couldn't refresh capabilities. Try again.").waitFor()
  await page.screenshot({ fullPage: true, path: recoveryFailureScreenshotPath })
  assert.ok(
    (await page.evaluate(() => window.__appConnectScopeFixture.calls))
      .some((call) => call.path.endsWith('/refresh-capabilities')),
  )
  await context.close()
  console.log(`App connection scope proofs passed: ${menuScreenshotPath}, ${projectScreenshotPath}, ${reviewScreenshotPath}, ${recoveryScreenshotPath}, ${recoveryFailureScreenshotPath}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
