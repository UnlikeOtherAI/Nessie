import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = resolve(here, 'fixture.tsx').replaceAll('\\', '/')
const screenshotPath = resolve(REPO_ROOT, 'e2e/screenshots/apps/project-audience-compact.png')
const admin = await startAdmin()
const browser = await launchBrowser()
let page
try {
  const context = await browser.newContext({ viewport: { height: 700, width: 440 } })
  page = await context.newPage()
  await page.goto(ADMIN_URL)
  await page.setContent(`<!doctype html><div id="root"></div><script type="module">import "/@fs/${fixturePath}"</script>`)
  const audience = page.getByLabel('Choose who this app connection is for')
  await audience.waitFor()
  await audience.click()
  const project = page.getByTestId('app-connect-scope-project')
  await project.waitFor()
  const topmost = await project.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)[0] === element
  })
  assert.equal(topmost, true, 'project option must be topmost over its modal owner')
  await page.keyboard.press('Escape')
  await page.getByRole('listbox', { name: 'Choose who this app connection is for' }).waitFor({ state: 'hidden' })
  await page.getByRole('heading', { name: 'Review connection to KiloTalk fixture' }).waitFor()
  await audience.click()
  await project.waitFor()
  await project.click()
  await page.getByTestId('app-connect-project-picker').waitFor()
  assert.equal(await page.getByTestId('app-connect-confirm').isDisabled(), true)
  assert.equal(await page.evaluate(() => window.__appConnectScopeFixture.calls.length), 0)
  await page.screenshot({ fullPage: true, path: screenshotPath })
  await context.close()
  console.log(`App connection compact audience proof passed: ${screenshotPath}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
