#!/usr/bin/env node
// Browser proof for the server-authored chat doorway into the address-first
// email form. It drives a durable EmailAccountConnectCard in the real admin
// and captures both desktop and phone states of the reused modal.
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

const verifyViewport = async (browser, seed, viewport) => {
  await mkdir(SCREENSHOT_ROOT, { recursive: true })
  const shell = await openViewportContext(browser, { name: viewport, token: seed.token })
  const target = await shell.newPage()
  try {
    const { page } = target
    await page.goto(`${ADMIN_URL}/channels/${seed.emailConnectChannel.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.getByText('Connect email securely', { exact: true }).waitFor()
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

    if (viewport === 'desktop') {
      await page.screenshot({
        fullPage: true,
        path: resolve(SCREENSHOT_ROOT, 'desktop-chat-doorway-address-first.png'),
      })
    }

    if (viewport === 'desktop') {
      await dialog.getByPlaceholder('name@company.com').fill('duplicate-navigation@gmail.com')
      await dialog.getByRole('button', { exact: true, name: 'Continue' }).click()
      await dialog.getByText('This email account is already connected.', { exact: true }).waitFor()
      await dialog.getByRole('button', { exact: true, name: 'Open existing' }).click()

      await page.waitForURL(new RegExp(`/settings/connections#connection-${seed.mailboxConnectionId}$`))
      const existingCard = page.locator(`#connection-${seed.mailboxConnectionId}`)
      await existingCard.getByText('Duplicate navigation mailbox', { exact: true }).waitFor()
      await existingCard.scrollIntoViewIfNeeded()
      if (target.errors.length > 0) {
        fail(`desktop duplicate navigation page errors: ${target.errors.join(' | ')}`)
      }

      const recoveryCard = page.locator(`#connection-${seed.recoveryMailboxConnectionId}`)
      await recoveryCard.getByText('Reconnect navigation mailbox', { exact: true }).waitFor()
      await recoveryCard.getByText('Needs reconnecting', { exact: true }).waitFor()
      await recoveryCard.getByRole('button', { exact: true, name: 'Reconnect' }).click()

      const reconnectDialog = page.getByRole('dialog', { name: 'Reconnect email' })
      await reconnectDialog.waitFor()
      const reconnectAddress = reconnectDialog.getByPlaceholder('name@company.com')
      if (await reconnectAddress.inputValue() !== 'reconnect-navigation@example.test') {
        fail('reconnect does not retain the existing mailbox address')
      }
      if (await reconnectAddress.getAttribute('readonly') !== '') {
        fail('reconnect permits changing the existing mailbox address')
      }
      if (await reconnectDialog.locator('input[type="password"]').count() !== 0) {
        fail('reconnect exposes a credential before the person continues')
      }
      await reconnectDialog.screenshot({
        path: resolve(SCREENSHOT_ROOT, 'desktop-reconnect-address-readonly.png'),
      })
      await reconnectDialog.getByRole('button', { exact: true, name: 'Cancel' }).click()
    }

    if (viewport !== 'desktop') {
      await page.screenshot({
        fullPage: true,
        path: resolve(SCREENSHOT_ROOT, `${viewport}-chat-doorway-address-first.png`),
      })
    }
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
    api = await startApi({ requireOwned: true })
    admin = await startAdmin({ requireOwned: true })
    const seed = await seedTeam(api)
    browser = await launchBrowser()
    await verifyViewport(browser, seed, 'desktop')
    await verifyViewport(browser, seed, 'phone')
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
