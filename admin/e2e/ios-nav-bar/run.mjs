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
import { clickChannelRow, edgeSwipe, gotoChannels, gotoPath } from '../navigation/lib/page.mjs'

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
        // The screen's own actions, read off the DOM, so the bar is measured
        // against the real thing rather than a number written in a comment.
        // The marker excludes the header chrome beside them — the overflow
        // trigger and the account menu are not page actions. A narrow viewport
        // may have folded some into the overflow popover, which is not in the
        // DOM until opened, so this is a subset and the assertion below is
        // "every one of these reached the bar", not an equality.
        actionIds: [...document.querySelectorAll('header [data-page-header-action]')]
          .map((node) => node.getAttribute('data-page-header-action'))
          .filter((id) => typeof id === 'string' && id.length > 0),
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
    const safariActionIds = [...new Set(safari.actionIds)].sort()
    check(
      'the Safari header exposes actions to compare the bar against',
      safariActionIds.length > 0,
      JSON.stringify(safariActionIds),
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
      'a tab root publishes a bar naming a layer, with no Back',
      // Not merely `back === null`: the bridge posts that for *no* descriptor
      // too, so without the layer key this passes when nothing published.
      rootBar !== null && rootBar.back === null && typeof rootBar.layerKey === 'string',
      JSON.stringify(rootBar),
    )

    // A real push from the root, not a second page load: the layer comparison
    // below is only meaningful if both layers came from one document.
    await clickChannelRow(app.page, seed.channels[0].label ?? seed.channels[0].slug)
    await app.page.waitForTimeout(900)
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
      'the pushed detail names a different layer than the root beneath it',
      Boolean(rootBar && detailBar && rootBar.layerKey !== detailBar.layerKey),
      `${rootBar?.layerKey} vs ${detailBar?.layerKey}`,
    )

    // Rule zero: the header's actions are not decoration. Hiding the web
    // header without carrying them across would make them unreachable. The
    // count to beat is the same screen's own actions in Safari, read from the
    // DOM there rather than written down here.
    const barActionIds = (detailBar?.actions ?? []).map((entry) => entry.id).sort()
    check(
      'every action the web header rendered survives into the bar',
      safariActionIds.every((id) => barActionIds.includes(id)),
      `safari ${JSON.stringify(safariActionIds)} vs bar ${JSON.stringify(barActionIds)}`,
    )

    // ---- 3. The reported gesture ----------------------------------------
    await edgeSwipe(app.page)
    await app.page.waitForTimeout(900)
    const afterSwipe = await lastBar(app.page)
    await app.page.screenshot({ path: `${SHOTS}shell-after-swipe.png` })
    check(
      'a back swipe returns the bar to the root layer it revealed',
      Boolean(afterSwipe && afterSwipe.back === null && afterSwipe.layerKey === rootBar?.layerKey),
      JSON.stringify(afterSwipe),
    )
    check(
      'the root it returns to carries no detail actions',
      (afterSwipe?.actions ?? []).length === 0,
      JSON.stringify(afterSwipe?.actions?.map((entry) => entry.id)),
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
