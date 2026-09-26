#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'

import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, API_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { call, seedTeam } from '../navigation/lib/seed.mjs'
import { startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'

const shots = resolve(REPO_ROOT, 'e2e/screenshots/announcements')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/q4cAAAAASUVORK5CYII=',
  'base64',
)

const articleInput = (title) => ({
  body: 'An update for everyone in this installation.',
  imageUrl: null,
  published: true,
  title,
  youtubeUrl: null,
})

const visit = async (context, path) => {
  const { page, errors, close } = await context.newPage()
  await page.goto(`${ADMIN_URL}${path}`)
  return { page, errors, close }
}

let api = null
let admin = null
let browser = null
const prisma = new PrismaClient()

try {
  const databaseName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1)
  assert.match(databaseName, /^nessie_announcements(?:_[a-z0-9]+)?$/,
    'this browser suite only runs on a disposable announcements database')
  await mkdir(shots, { recursive: true })
  api = await startApi({ reuseExisting: false })
  admin = await startAdmin({ reuseExisting: false })
  const seed = await seedTeam(api)
  assert.ok(seed.origin === 'bootstrap' || process.env.ANNOUNCEMENTS_E2E_ALLOW_REUSE === '1',
    'the fixture must use a fresh disposable database unless explicitly reused for a rerun')
  if (process.env.ANNOUNCEMENTS_E2E_ALLOW_REUSE === '1') {
    await prisma.rateLimitBucket.deleteMany({ where: { bucket: { startsWith: 'auth.login.' } } })
  }
  const me = await call('/api/auth/me', { token: seed.token })
  await prisma.user.update({ where: { id: me.user.id }, data: { superAdmin: true } })
  const elevated = await call('/api/auth/me', { token: seed.token })
  assert.equal(elevated.user.superAdmin, true)
  await prisma.platformNewsReadState.deleteMany()
  await prisma.platformNewsArticle.deleteMany()
  await prisma.platformBanner.deleteMany()

  const memberEmail = 'announcements-reader@example.com'
  const memberPassword = 'announcements-reader-password'
  if (!await prisma.user.findUnique({ where: { email: memberEmail } })) {
    await call('/api/users', {
      body: { displayName: 'News reader', email: memberEmail, password: memberPassword, role: 'member' },
      method: 'POST', token: seed.token,
    })
  }
  const member = await call('/api/auth/session', {
    body: { email: memberEmail, password: memberPassword }, method: 'POST',
  })
  const denied = await fetch(`${API_URL}/api/platform/announcements`, {
    headers: { authorization: `Bearer ${member.token}` },
  })
  assert.equal(denied.status, 403, 'a member cannot open the operator editor')

  browser = await launchBrowser()
  const operatorContext = await openViewportContext(browser, { name: 'desktop', token: seed.token })
  const readerContext = await openViewportContext(browser, { name: 'desktop', token: member.token })
  const phoneContext = await openViewportContext(browser, { name: 'phone', token: seed.token })
  try {
    const operator = await visit(operatorContext, '/settings/announcements')
    const { page } = operator
    try {
      await page.getByRole('heading', { name: 'Announcements' }).waitFor()
    } catch (error) {
      console.error('operator page:', page.url(), (await page.locator('body').innerText()).slice(0, 1200))
      console.error('operator page errors:', operator.errors.slice(0, 4))
      await page.screenshot({ path: resolve(shots, 'operator-load-failure.png') })
      throw error
    }
    await page.getByLabel('Strip text').fill('Scheduled maintenance')
    await page.getByLabel('Link (optional)').fill('/projects')
    await page.getByLabel('Show this strip to everyone').check()
    await page.getByRole('button', { name: 'Save strip' }).click()
    await page.getByText('The strip is saved for this installation.').waitFor()
    await page.getByRole('region', { name: 'Announcement' }).getByRole('link', {
      name: 'Scheduled maintenance',
    }).waitFor()
    await page.screenshot({ path: resolve(shots, 'operator-strip.png'), fullPage: true })

    await page.getByRole('tab', { name: 'News' }).click()
    await page.getByLabel('Header').fill('Release notes')
    await page.getByLabel('Text').fill('A short update and a video preview.')
    await page.getByLabel('Image file (optional)').setInputFiles({
      name: 'release.png', mimeType: 'image/png', buffer: png,
    })
    await page.getByLabel('YouTube link (optional)').fill('https://youtu.be/dQw4w9WgXcQ')
    await page.getByLabel('Published for everyone').check()
    await page.getByRole('button', { name: 'Save article' }).click()
    await page.getByText('Article published.').waitFor()
    await page.getByRole('button', { name: /Release notes.*Published/ }).waitFor()
    const firstPublication = await call('/api/news', { token: seed.token })
    await page.getByLabel('Text').fill('The release notes now have an updated preview.')
    await page.getByLabel('Image file (optional)').setInputFiles({
      name: 'updated-release.png', mimeType: 'image/png', buffer: png,
    })
    await page.getByRole('button', { name: 'Save article' }).click()
    let editedPublication
    for (let attempt = 0; attempt < 20; attempt += 1) {
      editedPublication = await call('/api/news', { token: seed.token })
      if (editedPublication.articles[0]?.body === 'The release notes now have an updated preview.') break
      await new Promise((done) => { setTimeout(done, 100) })
    }
    assert.equal(editedPublication.articles[0]?.publicationVersion,
      firstPublication.articles[0].publicationVersion,
      'editing a published article in the new-article editor does not create new news')
    await page.waitForFunction(() => !document.querySelector('input[type="file"][accept*="image"]')?.files?.length)
    await page.screenshot({ path: resolve(shots, 'operator-news-editor.png'), fullPage: true })

    const reader = await visit(readerContext, `/channels/${seed.channels[0].id}`)
    const readerPage = reader.page
    await readerPage.getByRole('region', { name: 'Announcement' }).waitFor()
    await readerPage.getByRole('button', { name: 'Account menu' }).click()
    await readerPage.getByRole('button', { name: 'News' }).getByLabel('1 unread news articles').waitFor()
    await readerPage.getByRole('button', { name: 'News' }).click()
    const dialog = readerPage.getByRole('dialog', { name: 'News' })
    await dialog.waitFor()
    await dialog.getByRole('heading', { name: 'Release notes' }).waitFor()
    await dialog.getByRole('button', { name: 'Play Release notes' }).waitFor()
    await readerPage.screenshot({ path: resolve(shots, 'desktop-news.png') })
    await dialog.getByRole('button', { name: 'Play Release notes' }).click()
    await dialog.locator('iframe[src*="youtube-nocookie.com/embed/dQw4w9WgXcQ"]').waitFor()
    await dialog.getByLabel('Mute notifications').check()
    await dialog.getByRole('button', { name: 'Close' }).click()
    assert.equal(new URL(readerPage.url()).pathname, `/channels/${seed.channels[0].id}`)
    await readerPage.getByRole('button', { name: 'Account menu' }).click()
    assert.equal(await readerPage.getByRole('button', { name: 'News' })
      .getByLabel('1 unread news articles').count(), 0)
    await readerPage.getByRole('button', { name: 'Account menu' }).click()

    await readerPage.getByRole('button', { name: 'Dismiss announcement' }).click()
    await readerPage.reload()
    assert.equal(await readerPage.getByRole('region', { name: 'Announcement' }).count(), 0)
    assert.equal(await page.getByRole('region', { name: 'Announcement' }).count(), 1)

    await call('/api/platform/announcements/news', {
      body: articleInput('Second publication'), method: 'POST', token: seed.token,
    })
    await readerPage.reload()
    await readerPage.getByRole('button', { name: 'Account menu' }).click()
    await readerPage.getByRole('button', { name: 'News' }).getByLabel('1 unread news articles').waitFor()
    assert.equal(await readerPage.locator('.news-account-dot').count(), 0,
      'muting keeps the counter while hiding the small notification')
    await readerPage.getByRole('button', { name: 'Account menu' }).click()

    const phone = await visit(phoneContext, `/channels/${seed.channels[0].id}`)
    const phonePage = phone.page
    await phonePage.getByRole('button', { name: 'Account menu' }).click()
    await phonePage.getByRole('button', { name: 'News' }).getByLabel('2 unread news articles').waitFor()
    await phonePage.getByRole('button', { name: 'News' }).click()
    await phonePage.waitForURL('**/news')
    await phonePage.getByRole('heading', { name: 'Second publication' }).waitFor()
    assert.equal(await phonePage.getByRole('dialog', { name: 'News' }).count(), 0)
    await phonePage.screenshot({ path: resolve(shots, 'phone-news.png') })
    await phonePage.getByRole('button', { name: /Back/ }).click()
    await phonePage.waitForURL(`**/channels/${seed.channels[0].id}`)

    const ipadContext = await browser.newContext({
      deviceScaleFactor: 2, hasTouch: true, viewport: { height: 1024, width: 768 },
    })
    await ipadContext.addInitScript((token) => {
      window.localStorage.setItem('nessie.admin.token', token)
      window.__nessieNativeShell = { platform: 'ios', formFactor: 'ipad' }
      window.__nessieNativeMessages = []
      window.ReactNativeWebView = {
        postMessage: (message) => window.__nessieNativeMessages.push(JSON.parse(message)),
      }
    }, seed.token)
    try {
      const ipad = await ipadContext.newPage()
      await ipad.goto(`${ADMIN_URL}/channels/${seed.channels[0].id}`)
      await ipad.waitForFunction(() => window.__nessieNativeMessages?.some(
        (message) => message.type === 'nessie:list-column' && message.section === 'channels'))
      await ipad.waitForFunction(() => typeof window.__nessieToggleAccountMenu === 'function')
      await ipad.evaluate(() => window.__nessieToggleAccountMenu())
      await ipad.getByRole('button', { name: 'News' }).click()
      await ipad.getByRole('dialog', { name: 'News' }).waitFor()
      await ipad.waitForFunction(() => window.__nessieNativeMessages?.some(
        (message) => message.type === 'nessie:list-column' && message.section === null))
      const columnDuringNews = await ipad.evaluate(() => window.__nessieNativeMessages
        .filter((message) => message.type === 'nessie:list-column').at(-1))
      assert.equal(columnDuringNews.section, null,
        'the native channel list and its creation plus retire while News is open')
      await ipad.getByRole('dialog', { name: 'News' }).getByRole('button', { name: 'Close' }).click()
      await ipad.waitForFunction(() => window.__nessieNativeMessages?.filter(
        (message) => message.type === 'nessie:list-column').at(-1)?.section === 'channels')
      await ipad.close()
    } finally {
      await ipadContext.close()
    }

    const visibleFeed = await call('/api/news', { token: member.token })
    await call('/api/platform/announcements/news', {
      body: articleInput('Published during reading'), method: 'POST', token: seed.token,
    })
    await call('/api/news/read', {
      body: { throughVersion: visibleFeed.articles[0].publicationVersion },
      method: 'POST', token: member.token,
    })
    const afterRead = await call('/api/news', { token: member.token })
    assert.equal(afterRead.unreadCount, 1,
      'a publication arriving after the visible feed remains unread')

    await page.getByRole('button', { name: 'New article' }).click()
    await page.getByLabel('Header').fill('Image-only update')
    await page.getByLabel('Image file (optional)').setInputFiles({
      name: 'image-only.png', mimeType: 'image/png', buffer: png,
    })
    await page.getByLabel('Published for everyone').check()
    await page.getByRole('button', { name: 'Save article' }).click()
    await page.getByText('Article published.').waitFor()
    const mediaOnly = await call('/api/news', { token: member.token })
    assert.equal(mediaOnly.articles[0].title, 'Image-only update')
    assert.equal(mediaOnly.articles[0].body, '')
    assert.match(mediaOnly.articles[0].imageUrl, /^\/api\/news\/.+\/image$/)

    assert.deepEqual(operator.errors, [], 'operator page has no uncaught errors')
    assert.deepEqual(reader.errors, [], 'reader page has no uncaught errors')
    assert.deepEqual(phone.errors, [], 'phone page has no uncaught errors')
    await phone.close()
    await reader.close()
    await operator.close()
  } finally {
    await operatorContext.close()
    await readerContext.close()
    await phoneContext.close()
  }
  console.log('announcements e2e: operator, two accounts, desktop, phone, iPad, strip and media passed')
} finally {
  await browser?.close().catch(() => {})
  await stopProcess(admin)
  await stopProcess(api)
  await prisma.$disconnect()
}
