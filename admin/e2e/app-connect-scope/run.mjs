import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const menuScreenshotPath = resolve(REPO_ROOT, 'e2e/screenshots/apps/project-audience-compact-menu.png')
const projectScreenshotPath = resolve(REPO_ROOT, 'e2e/screenshots/apps/project-audience-compact-project.png')
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
  await context.close()
  console.log(`App connection compact audience proof passed: ${menuScreenshotPath}, ${projectScreenshotPath}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
