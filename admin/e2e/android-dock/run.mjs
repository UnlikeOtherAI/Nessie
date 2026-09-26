#!/usr/bin/env node
// Verification for the Android shell's bottom edge.
//
// The dock itself is React Native and cannot be driven from a browser. What
// can be driven — and is where the defect lived — is the admin running inside
// the Android shell: the shell is identified by two globals
// (`ReactNativeWebView` and `__nessieNativeShell`), and its bottom clearance
// arrives as one custom property on the document element
// (`--nessie-native-bottom-overlay`, mobile/src/lib/native-shell.ts), so
// installing both makes the page take exactly the code path the tablet takes.
//
// Three things are proved here:
//
//   1. **Nothing above the dock stops early.** `main` keeps its full height,
//      so the chat tool rail and the page beside it reach the window's own
//      floor instead of ending a dock-and-a-taskbar above it.
//   2. **What the dock covers is held clear** — the composer, and the rail's
//      last control — by exactly the clearance the shell published, never that
//      plus the WebView's own `env(safe-area-inset-bottom)` on top.
//   3. **The web is untouched.** The same viewport without the shell globals
//      carries none of it.
import { mkdir, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { databaseUrl } from '../navigation/lib/config.mjs'
import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { seedTeam } from '../navigation/lib/seed.mjs'
import { startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'
import { gotoChannels, gotoPath } from '../navigation/lib/page.mjs'

// `fileURLToPath`, not `URL.pathname`: the latter hands Windows a path with a
// leading slash before the drive letter, which `mkdir` refuses.
const SHOTS = fileURLToPath(new URL('../screenshots/android-dock/', import.meta.url))

// The dock at rest plus a system-bar inset the shell has already accounted
// for: mobile's ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE (86) + 28.
const CLEARANCE = 114

const reachable = (url) => new Promise((resolve) => {
  let target
  try { target = new URL(url) } catch { resolve(false); return }
  const socket = connect({ host: target.hostname || '127.0.0.1', port: Number(target.port || 5432) })
  const finish = (value) => { socket.destroy(); resolve(value) }
  socket.setTimeout(3_000)
  socket.once('connect', () => finish(true))
  socket.once('timeout', () => finish(false))
  socket.once('error', () => finish(false))
})

// Everything the installed Android shell puts on the page before the admin's
// first render: the two globals, and the dock's clearance as the live custom
// property the shell republishes — not the stylesheet's resting value, which
// is only what a first paint gets.
const installShell = (page, clearance) => page.addInitScript((value) => {
  window.__nessieNativeShell = { bottomInset: 28, formFactor: 'phone', platform: 'android' }
  window.ReactNativeWebView = { postMessage: () => {} }
  const publish = () => {
    document.documentElement.style.setProperty('--nessie-native-bottom-overlay', `${value}px`)
  }
  if (document.documentElement) publish()
  else document.addEventListener('DOMContentLoaded', publish)
}, clearance)

const measure = (page) => page.evaluate(() => {
  const number = (value) => Math.round(parseFloat(value) || 0)
  const frame = document.querySelector('.admin-frame')
  const main = document.querySelector('.admin-shell > main')
  // The shell rail belongs to the web; the native shell replaces it with the
  // dock, and the navy column beside the conversation is the secondary nav.
  const column = document.querySelector('.admin-shell > .resizable-sidebar > aside')
  const surface = main?.firstElementChild ?? null
  const toolRail = document.querySelector('[aria-label="Agent tools"]')
  // The composer container is the element that owns the bottom padding; the
  // form itself sits inside it.
  const composer = document.querySelector('form')?.parentElement ?? null
  const pageBody = document.querySelector('.admin-page-body')
  const bottomOf = (element) => (element ? Math.round(element.getBoundingClientRect().bottom) : null)
  return {
    androidShell: Boolean(frame?.classList.contains('has-native-android-shell')),
    composerPaddingBottom: composer ? number(getComputedStyle(composer).paddingBottom) : null,
    mainPaddingBottom: main ? number(getComputedStyle(main).paddingBottom) : null,
    pageBodyBottom: bottomOf(pageBody),
    pageBodyPaddingBottom: pageBody ? number(getComputedStyle(pageBody).paddingBottom) : null,
    columnBottom: bottomOf(column),
    columnPaddingBottom: column ? number(getComputedStyle(column).paddingBottom) : null,
    surfaceBottom: bottomOf(surface),
    toolRailBottom: bottomOf(toolRail),
    viewportBottom: window.innerHeight,
  }
})

const checks = []
const check = (label, passed, detail = '') => {
  checks.push({ detail, label, passed })
  console.log(`  ${passed ? '✓' : '✗'} ${label}${passed || !detail ? '' : ` — ${detail}`}`)
}

const main = async () => {
  const database = databaseUrl()
  if (!database || !(await reachable(database))) {
    console.log('android-dock e2e: SKIPPED — no reachable DATABASE_URL')
    process.exit(0)
  }
  await rm(SHOTS, { force: true, recursive: true })
  await mkdir(SHOTS, { recursive: true })

  let api = null
  let admin = null
  let browser = null
  try {
    api = await startApi()
    admin = await startAdmin()
    const seed = await seedTeam(api)
    browser = await launchBrowser()
    const channelPath = `/channels/${seed.channels[0].id}`

    // ---- 1. Inside the Android shell ------------------------------------
    const shell = await openViewportContext(browser, { name: 'desktop', token: seed.token })
    const app = await shell.newPage()
    await installShell(app.page, CLEARANCE)
    await gotoChannels(app.page)
    await gotoPath(app.page, channelPath)
    await app.page.waitForSelector('form')
    await app.page.waitForTimeout(400)
    const android = await measure(app.page)
    await app.page.screenshot({ path: `${SHOTS}android-channel.png` })

    // The native avatar stays above a loaded conversation. Its press must
    // still reach the shared menu and its real account-settings doorway.
    await app.page.waitForFunction(() => typeof window.__nessieToggleAccountMenu === 'function')
    await app.page.evaluate(() => window.__nessieToggleAccountMenu())
    const accountMenu = app.page.getByRole('menu', { name: 'Account menu', exact: true })
    await accountMenu.waitFor({ state: 'visible' })
    await app.page.screenshot({ path: `${SHOTS}android-channel-account-menu.png` })
    await accountMenu.getByRole('link', { name: 'Your settings', exact: true }).click()
    await app.page.waitForURL('**/settings/profile')
    check('the native account control opens settings from a loaded chat', true)
    await gotoPath(app.page, channelPath)
    await app.page.waitForSelector('form')

    check('the page knows it is in the Android shell', android.androidShell, JSON.stringify(android))
    check(
      'the content region keeps its full height, reserving nothing for the dock',
      android.mainPaddingBottom === 0,
      `main padding-bottom ${android.mainPaddingBottom}px`,
    )
    check(
      'the surface inside it reaches the window floor',
      android.surfaceBottom !== null
        && Math.abs(android.surfaceBottom - android.viewportBottom) <= 1,
      `surface ${android.surfaceBottom} vs viewport ${android.viewportBottom}`,
    )
    if (android.toolRailBottom !== null) {
      check(
        'the chat tool rail reaches the window floor',
        Math.abs(android.toolRailBottom - android.viewportBottom) <= 1,
        `rail ${android.toolRailBottom} vs viewport ${android.viewportBottom}`,
      )
    }
    check(
      'the composer clears the dock by exactly what the shell published',
      android.composerPaddingBottom === 14 + CLEARANCE,
      `composer padding-bottom ${android.composerPaddingBottom}px, expected ${14 + CLEARANCE}px`,
    )
    check(
      'the navy column paints to the floor while its last row stays above the dock',
      android.columnBottom !== null
        && Math.abs(android.columnBottom - android.viewportBottom) <= 1
        && android.columnPaddingBottom === CLEARANCE,
      JSON.stringify({ bottom: android.columnBottom, padding: android.columnPaddingBottom }),
    )
    // A settings page, where the body is a scroller of its own rather than a
    // conversation: the surface still reaches the floor, and the scrolling body
    // is what ends above the dock.
    await gotoPath(app.page, '/admin/security?tab=audit')
    await app.page.waitForSelector('.admin-page-body')
    await app.page.waitForTimeout(400)
    const settings = await measure(app.page)
    await app.page.screenshot({ path: `${SHOTS}android-settings.png` })
    check(
      'a settings body scrolls its last row clear of the dock without shortening the page',
      settings.pageBodyBottom !== null
        && Math.abs(settings.pageBodyBottom - settings.viewportBottom) <= 1
        && settings.pageBodyPaddingBottom === 20 + CLEARANCE,
      JSON.stringify({
        bottom: settings.pageBodyBottom,
        padding: settings.pageBodyPaddingBottom,
        viewport: settings.viewportBottom,
      }),
    )
    if (app.errors.length > 0) console.log(`      page errors: ${app.errors.slice(0, 3).join(' | ')}`)
    await app.close()
    await shell.close()

    // ---- 2. The same screen on the web, untouched ------------------------
    const web = await openViewportContext(browser, { name: 'desktop', token: seed.token })
    const webPage = await web.newPage()
    await gotoChannels(webPage.page)
    await gotoPath(webPage.page, channelPath)
    await webPage.page.waitForSelector('form')
    await webPage.page.waitForTimeout(400)
    const browserView = await measure(webPage.page)
    await webPage.page.screenshot({ path: `${SHOTS}web-channel.png` })
    check(
      'the web carries no Android shell mode and no dock clearance',
      !browserView.androidShell && browserView.composerPaddingBottom === 14,
      JSON.stringify(browserView),
    )
    await webPage.close()
    await web.close()
  } finally {
    if (browser) await browser.close()
    await stopProcess(admin)
    await stopProcess(api)
  }

  const failed = checks.filter((entry) => !entry.passed)
  console.log(`\nandroid-dock e2e: ${checks.length - failed.length}/${checks.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error(error); process.exit(1) })
