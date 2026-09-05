#!/usr/bin/env node
// Verification for the iOS native navigation bar
// (docs/plans/2026-09-05-ios-native-navigation-bar.md §13).
//
// The native bar itself is React Native and cannot be driven from a browser.
// What *can* be driven — and is where every decision actually lives — is the
// admin running inside the iOS shell: the shell is identified by two globals
// (`ReactNativeWebView` and `__nessieNativeShell`), so injecting them makes
// the page take the exact code path the iPhone app takes, and stubbing
// `postMessage` captures the bridge traffic the native bar renders from.
//
// Two things are proved here:
//
//   1. **Mobile Safari is untouched.** The same phone viewport without the
//      shell globals keeps the header the web has always drawn. This is the
//      acceptance test for the "iOS only" constraint.
//   2. **Inside the shell** the web header is gone, the `h1` the settle
//      focuses survives, and `nessie:screen-bar` carries the screen's own
//      title and Back — including through an edge swipe back to a root.
import { mkdir, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { databaseUrl } from '../navigation/lib/config.mjs'
import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { seedTeam } from '../navigation/lib/seed.mjs'
import { startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'
import { edgeSwipe, gotoChannels, gotoPath } from '../navigation/lib/page.mjs'

const SHOTS = new URL('../screenshots/ios-nav-bar/', import.meta.url).pathname

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

// The two globals the shell injects, plus a recorder in place of the native
// message channel. Installed before any script runs, because the admin reads
// them during its first render.
const installShell = (page) => page.addInitScript(() => {
  window.__nessieScreenBarMessages = []
  window.__nessieNativeShell = { formFactor: 'phone', platform: 'ios' }
  window.ReactNativeWebView = {
    postMessage: (raw) => {
      try {
        const message = JSON.parse(raw)
        if (message.type === 'nessie:screen-bar') window.__nessieScreenBarMessages.push(message)
      } catch { /* not ours */ }
    },
  }
})

const lastBar = (page) => page.evaluate(() => {
  const messages = window.__nessieScreenBarMessages ?? []
  return messages[messages.length - 1] ?? null
})

const checks = []
const check = (label, passed, detail = '') => {
  checks.push({ detail, label, passed })
  console.log(`  ${passed ? '✓' : '✗'} ${label}${passed || !detail ? '' : ` — ${detail}`}`)
}

const main = async () => {
  const database = databaseUrl()
  if (!database || !(await reachable(database))) {
    console.log('ios-nav-bar e2e: SKIPPED — no reachable DATABASE_URL')
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

    // ---- 1. Mobile Safari, unchanged ------------------------------------
    const web = await openViewportContext(browser, { name: 'phone', token: seed.token })
    const webPage = await web.newPage()
    await gotoChannels(webPage.page)
    await gotoPath(webPage.page, `/channels/${seed.channels[0].id}`)
    await webPage.page.waitForSelector('h1')
    const safari = await webPage.page.evaluate(() => {
      const heading = document.querySelector('h1')
      return {
        headingText: heading?.textContent?.trim() ?? '',
        // The web Back doorway the header has always drawn.
        hasDoorway: Boolean(document.querySelector('header button[aria-label], [aria-label^="Back"]')),
        headingVisible: Boolean(heading && !heading.className.includes('sr-only')),
      }
    })
    await webPage.page.screenshot({ path: `${SHOTS}safari-detail.png` })
    check(
      'mobile Safari keeps its visible header and Back doorway',
      safari.headingVisible && safari.hasDoorway,
      JSON.stringify(safari),
    )
    await webPage.close()
    await web.close()

    // ---- 2. Inside the iOS shell ----------------------------------------
    const shell = await openViewportContext(browser, { name: 'phone', token: seed.token })
    const app = await shell.newPage()
    // Installed on the page before any navigation, so the admin sees the
    // shell globals during its very first render rather than after one.
    await installShell(app.page)
    await gotoChannels(app.page)
    await app.page.waitForTimeout(400)
    const rootBar = await lastBar(app.page)
    await app.page.screenshot({ path: `${SHOTS}shell-root.png` })
    check(
      'a tab root publishes a bar with no Back',
      rootBar !== null && rootBar.back === null,
      JSON.stringify(rootBar),
    )

    await gotoPath(app.page, `/channels/${seed.channels[0].id}`)
    await app.page.waitForSelector('h1')
    await app.page.waitForTimeout(600)
    const detailBar = await lastBar(app.page)
    const detail = await app.page.evaluate(() => {
      const heading = document.querySelector('h1')
      return {
        headingCount: document.querySelectorAll('h1').length,
        headingText: heading?.textContent?.trim() ?? '',
        srOnly: Boolean(heading?.className.includes('sr-only')),
      }
    })
    await app.page.screenshot({ path: `${SHOTS}shell-detail.png` })
    check(
      'the shell draws no visible web header',
      detail.srOnly,
      JSON.stringify(detail),
    )
    check(
      'the settle still finds exactly one h1 with the screen title',
      detail.headingCount === 1 && detail.headingText.length > 0,
      JSON.stringify(detail),
    )
    check(
      'a detail publishes its title and a named Back',
      Boolean(detailBar && detailBar.title && detailBar.back?.label),
      JSON.stringify(detailBar),
    )
    check(
      'the bar is keyed by the stack layer, not the pathname',
      typeof detailBar?.layerKey === 'string' && detailBar.layerKey.split(':').length >= 3,
      String(detailBar?.layerKey),
    )
    check(
      'the detail names a different layer than the root it was pushed from',
      Boolean(rootBar && detailBar && rootBar.layerKey !== detailBar.layerKey),
      `${rootBar?.layerKey} vs ${detailBar?.layerKey}`,
    )

    // Rule zero: the header's actions are not decoration. Hiding the web
    // header without carrying them across would make them unreachable.
    const safariActionCount = 3 // star, overflow, account — visible in safari-detail.png
    check(
      'every header action survives into the bar rather than being dropped',
      Array.isArray(detailBar?.actions) && detailBar.actions.length >= safariActionCount,
      JSON.stringify(detailBar?.actions?.map((action) => `${action.id}:${action.kind}`)),
    )
    check(
      'each action carries the state the bar has to show',
      (detailBar?.actions ?? []).every((action) => (
        typeof action.label === 'string'
        && typeof action.selected === 'boolean'
        && typeof action.priority === 'number'
      )),
      JSON.stringify(detailBar?.actions?.[0]),
    )

    // ---- 3. The reported gesture ----------------------------------------
    await edgeSwipe(app.page)
    await app.page.waitForTimeout(900)
    const afterSwipe = await lastBar(app.page)
    await app.page.screenshot({ path: `${SHOTS}shell-after-swipe.png` })
    check(
      'a back swipe returns the bar to the root it revealed',
      Boolean(afterSwipe && afterSwipe.back === null && afterSwipe.layerKey === rootBar?.layerKey),
      JSON.stringify(afterSwipe),
    )
    if (app.errors.length > 0) console.log(`      page errors: ${app.errors.slice(0, 3).join(' | ')}`)
    await app.close()
    await shell.close()
  } finally {
    if (browser) await browser.close()
    await stopProcess(admin)
    await stopProcess(api)
  }

  const failed = checks.filter((entry) => !entry.passed)
  console.log(`\nios-nav-bar e2e: ${checks.length - failed.length}/${checks.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error(error); process.exit(1) })
