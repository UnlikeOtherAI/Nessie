import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT, adminMode } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/channel-confirmations')
const admin = await startAdmin({ reuseExisting: false })
const browser = await launchBrowser()
const errors = []
try {
  const html = await (await fetch(ADMIN_URL)).text()
  if (adminMode() === 'dev') assert.ok(html.includes('@vite/client'))
  await mkdir(screenshots, { recursive: true })
  const author = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  author.on('pageerror', (error) => errors.push(String(error)))
  await author.goto(`${ADMIN_URL}/e2e/channel-confirmations/index.html?role=author`, {
    timeout: 120_000, waitUntil: 'domcontentloaded',
  })
  await author.getByRole('button', { name: 'View confirmations' }).click()
  await author.getByRole('heading', { name: 'Acknowledged (1)' }).waitFor()
  assert.equal(await author.getByRole('heading', { name: 'Seen, awaiting confirmation (1)' }).count(), 1)
  assert.equal(await author.getByRole('heading', { name: 'Not seen (1)' }).count(), 1)
  await author.getByRole('button', { name: 'Remind unconfirmed' }).click()
  await author.getByRole('status', { name: '' }).filter({ hasText: 'Reminders queued' }).waitFor()
  await author.getByRole('button', { name: 'Remind unconfirmed' }).waitFor({ state: 'hidden' })
  assert.equal(await author.evaluate(() => window.__confirmationFixture.writes
    .filter((path) => path.endsWith('/remind-unconfirmed')).length), 1)
  await author.screenshot({ path: resolve(screenshots, 'desktop-status.png') })
  await author.setViewportSize({ width: 390, height: 844 })
  await author.screenshot({ path: resolve(screenshots, 'phone-status.png') })
  assert.ok(await author.getByRole('region', { name: 'Confirmation status' })
    .evaluate((node) => node.scrollWidth <= node.clientWidth + 1))

  const recipient = await browser.newPage({ viewport: { width: 390, height: 844 } })
  recipient.on('pageerror', (error) => errors.push(String(error)))
  await recipient.goto(`${ADMIN_URL}/e2e/channel-confirmations/index.html?role=recipient`, {
    timeout: 120_000, waitUntil: 'domcontentloaded',
  })
  await recipient.getByRole('button', { name: 'Acknowledge' }).waitFor()
  await recipient.waitForFunction(() => window.__confirmationFixture.writes
    .some((path) => path.endsWith('/seen')))
  await recipient.getByRole('button', { name: 'Acknowledge' }).click()
  await recipient.getByRole('button', { name: 'Acknowledged' }).waitFor()
  assert.equal(await recipient.getByRole('button', { name: 'View confirmations' }).count(), 0)
  await recipient.screenshot({ path: resolve(screenshots, 'phone-acknowledged.png') })
  assert.deepEqual(errors, [])
  console.log(`Confirmation controls passed. Screenshots: ${screenshots}`)
} catch (error) {
  console.error('Confirmation browser errors:', errors)
  console.error(admin.output())
  throw error
} finally {
  await browser.close()
  await stopProcess(admin)
}
