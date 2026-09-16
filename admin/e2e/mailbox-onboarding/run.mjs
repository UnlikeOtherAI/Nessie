#!/usr/bin/env node
// The connect ladder, walked in the real admin application.
//
//   pnpm --filter @nessie/admin test:e2e:mailbox-onboarding
//
// What this proves is a sequence, not a screen: each refusal must produce the
// *next* question and no more. Unit tests cover the step function; only the
// browser shows that the form actually asks what that function decided, and
// that it posts nothing the person did not type. The second part is the one a
// screenshot cannot show, so every step asserts the payload too — a placeholder
// port posted as a value would look right and silently disable the sweep.

import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

import { createOnboardingFixtures, verdicts } from './fixtures.mjs'
import { adminUrl, startAdmin } from '../connected-mail/servers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const screenshots = resolve(here, '..', '..', '..', 'e2e', 'screenshots', 'mailbox-onboarding')
const chromiumPath = process.env.CHROMIUM_PATH?.trim() || undefined

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const shot = (page, name) =>
  page.screenshot({ path: resolve(screenshots, `${name}.png`), fullPage: true })

/**
 * Everything is addressed inside the dialog. The Connections page carries its
 * own "Connect Slack" and "Connect Calendar or Meet" buttons, so an unscoped
 * "Connect" is ambiguous — and a test that reached one of those would be
 * asserting about the wrong panel entirely.
 */
const openConnectDialog = async (page) => {
  await page.goto(`${adminUrl}/settings/connections`)
  await page.getByRole('button', { name: 'Connect email' }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect email' })
  await dialog.waitFor()
  return dialog
}

const enterAddress = async (dialog, address) => {
  await dialog.getByPlaceholder('name@company.com').fill(address)
  await dialog.getByRole('button', { name: 'Continue' }).click()
}

const connect = (dialog) => dialog.getByRole('button', { exact: true, name: 'Connect' })

const run = async () => {
  await rm(screenshots, { force: true, recursive: true })
  await mkdir(screenshots, { recursive: true })

  const admin = await startAdmin()
  const browser = await chromium.launch({
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    headless: true,
  })
  const failures = []
  const check = async (name, body) => {
    try {
      await body()
      process.stdout.write(`  ✔ ${name}\n`)
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
      process.stdout.write(`  ✖ ${name}\n    ${error.message}\n`)
    }
  }

  const newPage = async (fixture) => {
    const context = await browser.newContext({
      deviceScaleFactor: 2,
      viewport: { height: 900, width: 1280 },
    })
    await context.addInitScript(() => {
      localStorage.setItem('nessie.admin.token', 'mailbox-onboarding-e2e-token')
      class QuietWebSocket extends EventTarget {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3
        readyState = QuietWebSocket.OPEN
        close() { this.readyState = QuietWebSocket.CLOSED; this.dispatchEvent(new Event('close')) }
        send() {}
      }
      window.WebSocket = QuietWebSocket
    })
    await context.route('**/api/**', (route, request) => fixture.respond(route, request))
    const page = await context.newPage()
    return { close: () => context.close(), page }
  }

  try {
    await check('an undiscoverable domain asks for a password, not a form', async () => {
      const fixture = createOnboardingFixtures()
      fixture.scriptConnects([verdicts.ok])
      const { close, page } = await newPage(fixture)
      try {
        const dialog = await openConnectDialog(page)
        await shot(page, '01-address')
        await enterAddress(dialog, 'person@example.com')

        // The old behaviour put `requiresManualSettings` straight into the
        // ten-field advanced screen. It must now ask for one password.
        await dialog.getByRole('heading', { name: 'Enter your password' }).waitFor()
        assert(
          await dialog.getByPlaceholder('imap.example.com').count() === 0,
          'the password step showed server fields',
        )
        await shot(page, '02-password')

        await dialog.getByLabel('Password').fill('correct horse')
        await connect(dialog).click()
        await page.getByRole('dialog').waitFor({ state: 'detached' })

        const [attempt] = fixture.connectAttempts
        assert(attempt.address === 'person@example.com', 'the address was not posted')
        assert(attempt.password === 'correct horse', 'the password was not posted')
        for (const field of ['imapHost', 'imapPort', 'smtpHost', 'smtpPort', 'server']) {
          assert(attempt[field] === undefined, `${field} was posted without anybody typing it`)
        }
      } finally {
        await close()
      }
    })

    await check('nothing found escalates to one mail server, not to every field', async () => {
      const fixture = createOnboardingFixtures()
      fixture.scriptConnects([verdicts.bothLegsMissing, verdicts.ok])
      const { close, page } = await newPage(fixture)
      try {
        const dialog = await openConnectDialog(page)
        await enterAddress(dialog, 'person@example.com')
        await dialog.getByLabel('Password').fill('correct horse')
        await connect(dialog).click()

        await dialog.getByRole('heading', { name: 'Where does this mail live?' }).waitFor()
        await dialog.getByText('We could not find a mail server for this address.').waitFor()
        // The app-wide toast floor exists for mutations with no failure
        // surface. This one has a precise surface, and a generic "Something
        // went wrong" landing on top of it is strictly worse than the sentence
        // underneath.
        assert(
          await page.getByText('Something went wrong').count() === 0,
          'the generic failure toast fired over the dialog\'s own message',
        )
        assert(
          await dialog.getByLabel('Port').count() === 0,
          'the single-server step asked for a port',
        )
        await shot(page, '03-server')

        // The password is carried, not re-typed.
        assert(
          await dialog.getByLabel('Password').inputValue() === 'correct horse',
          'the password was cleared on the way to the server step',
        )
        await dialog.getByLabel('Mail server').fill('mail.example.com')
        await connect(dialog).click()
        await page.getByRole('dialog').waitFor({ state: 'detached' })

        const second = fixture.connectAttempts[1]
        assert(second.server === 'mail.example.com', 'the typed server was not posted')
        assert(second.imapPort === undefined, 'a port was posted from the single-server step')
      } finally {
        await close()
      }
    })

    await check('one working leg asks only for the other one', async () => {
      const fixture = createOnboardingFixtures()
      fixture.scriptConnects([verdicts.smtpMissing, verdicts.ok])
      const { close, page } = await newPage(fixture)
      try {
        const dialog = await openConnectDialog(page)
        await enterAddress(dialog, 'person@example.com')
        await dialog.getByLabel('Password').fill('correct horse')
        await connect(dialog).click()

        await dialog.getByRole('heading', { name: 'Outgoing mail server' }).waitFor()
        // The server's per-leg sentence must survive; the generic code-keyed
        // message for SERVER_UNAVAILABLE says nothing about which leg failed.
        await dialog.getByText('Your password is right and incoming mail is working on mail.example.com.').waitFor()
        assert(
          await dialog.getByLabel('Password').count() === 0,
          'the leg step asked for the password again after proving it works',
        )
        assert(
          await dialog.getByText('Incoming server (IMAP)').count() === 0,
          'the leg step showed the leg that already resolved',
        )
        await shot(page, '04-leg')

        await dialog.getByLabel('Outgoing server (SMTP)').fill('smtp.example.com')
        await connect(dialog).click()
        await page.getByRole('dialog').waitFor({ state: 'detached' })

        const second = fixture.connectAttempts[1]
        assert(second.smtpHost === 'smtp.example.com', 'the typed outgoing host was not posted')
        assert(second.smtpPort === undefined, 'an unasked-for outgoing port was posted')
        // The resolved leg is pinned so it is not swept again and cannot drift.
        assert(second.imapHost === 'mail.example.com', 'the working leg was not pinned')
        assert(second.imapPort === 993, 'the working leg lost its port')
      } finally {
        await close()
      }
    })

    await check('the advanced form is the last rung, and is reachable', async () => {
      const fixture = createOnboardingFixtures()
      fixture.scriptConnects([verdicts.smtpMissing, verdicts.smtpMissing, verdicts.ok])
      const { close, page } = await newPage(fixture)
      try {
        const dialog = await openConnectDialog(page)
        await enterAddress(dialog, 'person@example.com')
        await dialog.getByLabel('Password').fill('correct horse')
        await connect(dialog).click()
        await dialog.getByRole('heading', { name: 'Outgoing mail server' }).waitFor()

        await dialog.getByLabel('Outgoing server (SMTP)').fill('smtp.example.com')
        await connect(dialog).click()
        // A rung never repeats itself: a second failure on the leg screen is
        // the point at which there is nothing narrower left to ask.
        await dialog.getByRole('heading', { name: 'Advanced email settings' }).waitFor()
        await shot(page, '05-advanced')
      } finally {
        await close()
      }
    })

    await check('a rejected password keeps the person on the password screen', async () => {
      const fixture = createOnboardingFixtures()
      fixture.scriptConnects([verdicts.credentialRejected])
      const { close, page } = await newPage(fixture)
      try {
        const dialog = await openConnectDialog(page)
        await enterAddress(dialog, 'person@example.com')
        await dialog.getByLabel('Password').fill('wrong')
        await connect(dialog).click()

        await dialog.getByText('The email address or password was not accepted.').waitFor()
        // Escalating here would ask somebody to fix a server that is fine.
        await dialog.getByRole('heading', { name: 'Enter your password' }).waitFor()
        assert(
          await dialog.getByRole('heading', { name: 'Where does this mail live?' }).count() === 0,
          'a rejected credential escalated to the server step',
        )
        await shot(page, '06-credential-rejected')
      } finally {
        await close()
      }
    })

    await check('"Other provider" starts with the address like everything else', async () => {
      const fixture = createOnboardingFixtures()
      const { close, page } = await newPage(fixture)
      try {
        const dialog = await openConnectDialog(page)
        await dialog.getByRole('button', { name: 'Other provider' }).click()
        assert(
          await dialog.getByRole('heading', { name: 'Advanced email settings' }).count() === 0,
          'the Other provider row still jumps straight to the advanced form',
        )
        await dialog.getByText('Enter your email address and continue.').waitFor()
        await shot(page, '07-other-provider')
      } finally {
        await close()
      }
    })
  } finally {
    await browser.close()
    await admin.stop()
  }

  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} failing:\n${failures.map((line) => `  ${line}`).join('\n')}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`\nAll mailbox onboarding checks passed. Screenshots in ${screenshots}\n`)
}

await run()
