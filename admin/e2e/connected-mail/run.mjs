#!/usr/bin/env node
// Connected mail is deliberately proven through the real admin application.
// The provider boundary is intercepted with stable data so this suite neither
// needs a human mailbox nor risks reading or sending real email.
//
//   pnpm --filter @nessie/admin test:e2e:connected-mail

import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

import { createMailFixtures } from './fixtures.mjs'
import { adminUrl, startAdmin } from './servers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const screenshots = resolve(here, '..', '..', '..', 'e2e', 'screenshots', 'connected-mail')
const chromiumPath = process.env.CHROMIUM_PATH?.trim() || undefined

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const shot = (page, name) => page.screenshot({ path: resolve(screenshots, `${name}.png`), fullPage: true })

const newPage = async (browser, fixture, { height, name, width }) => {
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    hasTouch: name !== 'desktop',
    viewport: { height, width },
  })
  await context.addInitScript(() => {
    localStorage.setItem('nessie.admin.token', 'connected-mail-e2e-token')
    // The shell's realtime subscription is outside mail's assertion boundary.
    // A quiet, protocol-shaped socket preserves the running shell without a
    // failed network connection masquerading as a page error.
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
  await context.route('https://tracker.example/**', (route) => route.fulfill({
    body: 'fixture-image', contentType: 'image/png', status: 200,
  }))
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(`page: ${String(error)}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()} (${message.location().url})`)
  })
  return { close: () => context.close(), errors, page }
}

const expectNoErrors = (errors, fixture) => {
  assert(fixture.unhandled.length === 0, `unexpected API calls:\n${JSON.stringify(fixture.unhandled)}`)
  assert(errors.length === 0, `browser errors:\n${errors.join('\n')}`)
}

const waitForThreads = (page, source, accountId, expected) => page.waitForResponse((response) => {
  if (response.request().method() !== 'GET') return false
  const url = new URL(response.url())
  if (url.pathname !== `/api/mail/accounts/${source}/${accountId}/threads`) return false
  return Object.entries(expected).every(([key, value]) =>
    value === undefined ? !url.searchParams.has(key) : url.searchParams.get(key) === String(value))
})

const fillCompose = async (page, subject) => {
  await page.getByRole('textbox', { name: 'To', exact: true }).fill('casey@acme.example')
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill(subject)
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Thanks — I will take this from here.')
}

const desktopMail = async ({ browser, fixture }) => {
  const target = await newPage(browser, fixture, { height: 800, name: 'desktop', width: 1280 })
  const { page } = target
  try {
    await page.goto(`${adminUrl}/mail`)
    await page.getByRole('heading', { name: 'Mail' }).waitFor()
    await page.getByText('Alex work').waitFor()
    await shot(page, 'desktop-account-chooser')

    await page.getByRole('button', { name: 'Open mail' }).first().click()
    await page.getByRole('listbox', { name: 'Mail conversations' }).waitFor()
    await page.getByText('Launch checklist').waitFor()
    const first = page.locator('#mailbox-thread-thread-1')
    assert(await first.getAttribute('tabindex') === '0', 'the first unselected conversation must be the keyboard tab stop')
    await first.focus()
    assert(await first.evaluate((element) => document.activeElement === element), 'the first conversation could not receive keyboard focus')

    const refresh = waitForThreads(page, 'gmail', 'gmail-1', { cursor: undefined, pageSize: 25, query: undefined })
    await page.getByRole('button', { name: 'Refresh' }).click()
    await refresh
    assert(!new URL(page.url()).searchParams.has('query'), 'Refresh leaked a provider query into the address bar')

    const nextPage = waitForThreads(page, 'gmail', 'gmail-1', { cursor: 'next-page', pageSize: 25, query: undefined })
    await page.getByRole('button', { name: 'Next' }).click()
    await nextPage
    for (const pageSize of [10, 25, 50, 100]) {
      await page.getByLabel('Items per page').selectOption(String(pageSize))
      // A previously viewed size may already be React Query-cached. Refresh
      // makes this control's provider request observable either way.
      const resizedPage = waitForThreads(page, 'gmail', 'gmail-1', { cursor: undefined, pageSize, query: undefined })
      await page.getByRole('button', { name: 'Refresh' }).click()
      await resizedPage
      assert(new URL(page.url()).searchParams.get('pageSize') === (pageSize === 25 ? null : String(pageSize)), `page size ${pageSize} was not reflected in the mailbox state`)
    }

    const mailboxThreads = waitForThreads(page, 'mailbox', 'mailbox-1', { cursor: undefined, pageSize: 100, query: undefined })
    const mailboxNavigation = page.waitForURL(/\/mail\/mailbox\/mailbox-1/)
    await page.getByLabel('Mail account').selectOption('mailbox:mailbox-1')
    await Promise.all([mailboxThreads, mailboxNavigation])
    assert(new URL(page.url()).pathname === '/mail/mailbox/mailbox-1', 'account switching did not navigate to the selected mailbox')
    const gmailNavigation = page.waitForURL(/\/mail\/gmail\/gmail-1/)
    await page.getByLabel('Mail account').selectOption('gmail:gmail-1')
    await gmailNavigation
    const gmailThreads = waitForThreads(page, 'gmail', 'gmail-1', { cursor: undefined, pageSize: 100, query: undefined })
    await page.getByRole('button', { name: 'Refresh' }).click()
    await gmailThreads

    await page.getByLabel('Items per page').selectOption('25')
    const defaultPage = waitForThreads(page, 'gmail', 'gmail-1', { cursor: undefined, pageSize: 25, query: undefined })
    await page.getByRole('button', { name: 'Refresh' }).click()
    await defaultPage
    await page.getByLabel('Search mail').fill('private provider query')
    const search = waitForThreads(page, 'gmail', 'gmail-1', { cursor: undefined, pageSize: 25, query: 'private provider query' })
    await page.getByRole('button', { name: 'Search' }).click()
    await search
    assert(!new URL(page.url()).searchParams.has('query'), 'provider query leaked into the address bar')

    await first.focus()
    await first.press('ArrowDown')
    await page.waitForURL(/threads\/thread-2/)
    await page.locator('#mailbox-thread-thread-2').waitFor({ state: 'attached' })
    await page.waitForFunction(() => document.querySelector('#mailbox-thread-thread-2')?.getAttribute('aria-selected') === 'true')
    await page.locator('#mailbox-thread-thread-1').click()
    await page.getByText('Remote images are blocked so the sender cannot tell you opened this.').waitFor()
    assert(await page.locator('.email-body img').getAttribute('data-blocked-src') === 'https://tracker.example/pixel.png', 'remote image was not held behind the sanitizer affordance')
    await page.getByRole('button', { name: 'Load images' }).click()
    assert(await page.locator('.email-body img').getAttribute('src') === 'https://tracker.example/pixel.png', 'remote image did not reveal after explicit consent')
    await shot(page, 'desktop-thread-reader')

    await page.getByRole('button', { name: 'Reply' }).click()
    await page.getByRole('heading', { name: 'Compose email' }).waitFor()
    const from = page.getByRole('textbox', { name: 'From', exact: true })
    assert(await from.isDisabled(), 'From must be pinned by the account')
    assert(await from.inputValue() === 'alex@example.com', 'From must display the selected account')
    await fillCompose(page, 'Re: Launch checklist')
    await page.getByRole('button', { name: 'Send email' }).click()
    await page.getByTestId('connected-mail-sent').waitFor()
    await page.getByText('Your email is queued to send.').waitFor()
    assert(fixture.calls.some((call) => call.method === 'POST' && call.pathname.endsWith('/gmail/gmail-1/drafts')), 'Gmail draft creation was not driven')
    assert(fixture.calls.some((call) => call.method === 'POST' && call.pathname.endsWith('/gmail/gmail-1/send')), 'Gmail held send was not driven')
    await shot(page, 'desktop-gmail-held-send')
    await page.getByRole('button', { name: 'Undo send' }).click()
    await page.waitForURL(/\/mail\/gmail\/gmail-1$/)
    assert(fixture.calls.some((call) => call.method === 'POST' && call.pathname.endsWith('/draft-created/undo')), 'Gmail undo did not reach the held provider draft')

    await page.goto(`${adminUrl}/mail/mailbox/mailbox-1/compose`)
    await page.getByRole('heading', { name: 'Compose email' }).waitFor()
    await fillCompose(page, 'Operations update')
    await page.getByRole('button', { name: 'Send email' }).click()
    await page.getByText('Your email was sent.').waitFor()
    assert(fixture.calls.some((call) => call.method === 'POST' && call.pathname.endsWith('/mailbox/mailbox-1/send')), 'mailbox send was not driven')
    assert(!fixture.calls.some((call) => call.method === 'POST' && call.pathname.endsWith('/mailbox/mailbox-1/drafts')), 'mailbox incorrectly requested a Gmail-style provider draft')
  } finally {
    expectNoErrors(target.errors, fixture)
    await target.close()
  }
}

const responsiveMail = async ({ browser, fixture }) => {
  const tablet = await newPage(browser, fixture, { height: 1024, name: 'tablet', width: 768 })
  try {
    await tablet.page.goto(`${adminUrl}/mail/gmail/gmail-1/threads/thread-1`)
    await tablet.page.getByTestId('mailbox-workspace').waitFor()
    assert(await tablet.page.getByTestId('mailbox-workspace').getAttribute('data-layout') === 'split', 'tablet must keep list and reader split')
    const readerBounds = await tablet.page.getByTestId('connected-mail-conversation').boundingBox()
    const readerWidth = Math.round(readerBounds?.width ?? 0)
    assert(readerWidth >= 240, `tablet reader is too narrow to read email copy (${readerWidth}px)`)
    console.log(`connected-mail e2e: tablet reader ${readerWidth}px wide`)
    await shot(tablet.page, 'tablet-thread-split')
  } finally {
    expectNoErrors(tablet.errors, fixture)
    await tablet.close()
  }

  const phone = await newPage(browser, fixture, { height: 844, name: 'phone', width: 390 })
  try {
    await phone.page.emulateMedia({ reducedMotion: 'reduce' })
    await phone.page.goto(`${adminUrl}/mail/gmail/gmail-1`)
    await phone.page.getByRole('listbox', { name: 'Mail conversations' }).waitFor()
    await phone.page.locator('body').evaluate((body) => { body.style.zoom = '200%' })
    await shot(phone.page, 'phone-list-200-percent-reduced-motion')
    await phone.page.locator('[role="option"]', { hasText: 'Launch checklist' }).click()
    await phone.page.waitForURL(/threads\/thread-1/)
    await phone.page.getByTestId('connected-mail-conversation').waitFor()
    assert(await phone.page.getByTestId('connected-mail-conversation').isVisible(), 'phone reader did not become the active nested flow')
    await phone.page.goBack()
    await phone.page.waitForURL(/\/mail\/gmail\/gmail-1$/)
    await phone.page.getByRole('listbox', { name: 'Mail conversations' }).waitFor()
    await shot(phone.page, 'phone-back-to-list')
  } finally {
    expectNoErrors(phone.errors, fixture)
    await phone.close()
  }
}

const chatDoorway = async ({ browser, fixture }) => {
  const target = await newPage(browser, fixture, { height: 800, name: 'desktop', width: 1280 })
  const { page } = target
  try {
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    await page.getByRole('heading', { name: 'Email triage' }).waitFor()
    assert(await page.getByTestId('mail-surface-doorway').count() === 0, 'doorway should not exist before the message refetch')
    fixture.showDoorway()
    // The response changes after the conversation has already mounted; a
    // product reload is the stable browser-level refetch seam (and avoids
    // reaching into React Query internals from the test).
    await page.reload()
    await page.getByTestId('mail-surface-doorway').waitFor()
    await page.getByRole('dialog', { name: 'Email ready to review' }).waitFor()
    await page.getByTestId('connected-mail-conversation').waitFor()
    await shot(page, 'chat-doorway-auto-popup')

    await page.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await page.reload()
    await page.getByTestId('mail-surface-doorway').waitFor()
    assert(await page.getByRole('dialog').count() === 0, 'the same message reopened a session-scoped automatic popup')

    fixture.denyDoorway()
    const opener = page.getByRole('button', { name: 'Open mail' })
    await opener.click()
    await page.getByText('This email is no longer available to you.').waitFor()
    assert(await page.getByRole('dialog').count() === 0, 'doorway opened after live entitlement was removed')
    fixture.allowDoorway()
    await opener.click()
    await page.getByRole('dialog', { name: 'Email ready to review' }).waitFor()
    await page.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    assert(await opener.evaluate((element) => document.activeElement === element), 'dialog close did not restore focus to the mail doorway')

    await opener.click()
    await page.getByRole('dialog', { name: 'Email ready to review' }).waitFor()
    await page.getByRole('button', { name: 'Open full mail' }).click()
    await page.waitForURL(/\/mail\/gmail\/gmail-1\/threads\/thread-1$/)
    await page.getByTestId('connected-mail-conversation').waitFor()

    // A second chat render carries a Gmail draft pointer. The form is the
    // same production composer used by Mail; it is not an email-shaped card.
    fixture.showComposeDoorway()
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    const composeOpener = page.getByRole('button', { name: 'Open mail' })
    await composeOpener.waitFor()
    await composeOpener.click()
    await page.getByRole('dialog', { name: 'Email draft ready' }).waitFor()
    assert(await page.getByRole('textbox', { name: 'From', exact: true }).isDisabled(), 'chat draft form exposed a mutable From field')
    await page.getByRole('textbox', { name: 'Subject', exact: true }).waitFor()
    await shot(page, 'chat-doorway-compose-form')
    await page.getByRole('button', { name: 'Close' }).click()

    // Account doorways carry the real, entitlement-scoped mailbox list into
    // chat. Selecting its row must enter the normal reader route, not an
    // email-shaped summary card with a second navigation implementation.
    fixture.showAccountDoorway()
    await page.goto(`${adminUrl}/channels/${fixture.ids.channel}`)
    const accountOpener = page.getByRole('button', { name: 'Open mail' })
    await accountOpener.click()
    const accountDialog = page.getByRole('dialog', { name: 'Mail ready to review' })
    await accountDialog.waitFor()
    const accountPreview = accountDialog.getByTestId('mailbox-workspace')
    await accountPreview.waitFor()
    assert(await accountPreview.getAttribute('data-layout') === 'single', 'account doorway did not embed the canonical mailbox list')
    await accountDialog.getByRole('listbox', { name: 'Mail conversations' }).waitFor()
    await shot(page, 'chat-doorway-account-preview')
    await accountDialog.locator('#mailbox-thread-thread-1').click()
    await page.waitForURL(/\/mail\/gmail\/gmail-1\/threads\/thread-1$/)
    await page.getByTestId('connected-mail-conversation').waitFor()
  } finally {
    expectNoErrors(target.errors, fixture)
    await target.close()
  }
}

const main = async () => {
  await rm(screenshots, { force: true, recursive: true })
  await mkdir(screenshots, { recursive: true })
  const server = await startAdmin()
  const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}), headless: true })
  const fixture = createMailFixtures()
  try {
    await desktopMail({ browser, fixture })
    await responsiveMail({ browser, fixture })
    await chatDoorway({ browser, fixture })
  } finally {
    await browser.close()
    await server.stop()
  }
  assert(fixture.unhandled.length === 0, `unhandled API requests: ${JSON.stringify(fixture.unhandled)}`)
  console.log(`connected-mail e2e: passed; screenshots in ${screenshots}`)
}

await main()
