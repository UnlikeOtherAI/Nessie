#!/usr/bin/env node
// Browser proof for the address-first email connection doorway. It drives the
// real admin and API on the fixed local development ports and captures both
// desktop and phone states of the shared MailboxConnectionForm.
import { mkdir } from 'node:fs/promises'
import { connect } from 'node:net'
import { resolve } from 'node:path'

import {
  ADMIN_URL,
  REPO_ROOT,
  databaseUrl,
  keepServers,
} from '../navigation/lib/config.mjs'
import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { seedTeam } from '../navigation/lib/seed.mjs'
import { startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'

const SCREENSHOT_ROOT = resolve(REPO_ROOT, 'e2e', 'screenshots', 'email-onboarding')

const reachable = (url) => new Promise((done) => {
  let target
  try {
    target = new URL(url)
  } catch {
    done(false)
    return
  }
  const socket = connect({
    host: target.hostname || '127.0.0.1',
    port: Number(target.port || 5432),
  })
  const finish = (result) => { socket.destroy(); done(result) }
  socket.setTimeout(3_000)
  socket.once('connect', () => finish(true))
  socket.once('timeout', () => finish(false))
  socket.once('error', () => finish(false))
})

const fail = (message) => { throw new Error(`email onboarding e2e: ${message}`) }

const verifyViewport = async (browser, token, viewport) => {
  const shell = await openViewportContext(browser, { name: viewport, token })
  const target = await shell.newPage()
  try {
    const { page } = target
    await page.goto(`${ADMIN_URL}/settings/connections`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Connected accounts' }).waitFor()
    await page.getByRole('button', { exact: true, name: 'Connect email' }).click()

    const dialog = page.getByRole('dialog', { name: 'Connect email' })
    await dialog.waitFor()
    await dialog.getByPlaceholder('name@company.com').waitFor()
    for (const provider of ['Google', 'Microsoft', 'iCloud', 'Other provider']) {
      if (await dialog.getByRole('button', { exact: true, name: provider }).count() !== 1) {
        fail(`${viewport} is missing the ${provider} provider choice`)
      }
    }
    if (await dialog.locator('input[type="password"]').count() !== 0) {
      fail(`${viewport} exposes a password before discovery`)
    }
    if (await dialog.getByText('Incoming mail', { exact: true }).count() !== 0) {
      fail(`${viewport} exposes server settings before discovery`)
    }

    await mkdir(SCREENSHOT_ROOT, { recursive: true })
    await page.screenshot({
      fullPage: true,
      path: resolve(SCREENSHOT_ROOT, `${viewport}-address-first.png`),
    })
    if (target.errors.length > 0) fail(`${viewport} page errors: ${target.errors.join(' | ')}`)
  } finally {
    await target.close()
    await shell.close()
  }
}

const main = async () => {
  const database = databaseUrl()
  if (!database || !(await reachable(database))) {
    console.log('email onboarding e2e: SKIPPED — DATABASE_URL is not reachable')
    return
  }

  let api = null
  let admin = null
  let browser = null
  try {
    api = await startApi()
    admin = await startAdmin()
    const seed = await seedTeam(api)
    browser = await launchBrowser()
    await verifyViewport(browser, seed.token, 'desktop')
    await verifyViewport(browser, seed.token, 'phone')
    console.log(`email onboarding e2e: PASS — screenshots in ${SCREENSHOT_ROOT}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (!keepServers()) {
      await stopProcess(admin)
      await stopProcess(api)
    }
  }
}

await main()
