#!/usr/bin/env node
// The desktop shell's double-tap, and the window it opens
// (docs/plans/2026-09-16-documents-finder-ui/browser-ui.md §7).
//
// Three facts, none of which a unit test can show:
//
//   1. The web keeps its one tap. A document opens into the pane beside the
//      browser on the click that selects it, exactly as before.
//   2. On the desktop shell the first tap selects **and nothing else**, and
//      the second one opens. This is the regression that would be invisible
//      otherwise: a gesture change looks identical in a screenshot of a
//      settled screen, and only the *absence* of an open after one tap says
//      the rule is live.
//   3. `/documents/<spaceId>/<pageId>` — the address the shell points a new
//      window at — renders that document with no admin shell around it, and
//      says so plainly when the document is not there.
//
// A browser has no Tauri behind it, so the shell command is refused here and
// the double-tap falls back to opening in place. That is the fallback under
// test as much as the gesture is: a desktop build older than the command
// answers exactly the same way, and a double-tap must never do nothing.
//
// The shell is simulated by publishing `__nessieDesktopPlatform` before the
// admin loads, which is precisely what the real init script does
// (desktop/src-tauri/src/shell.rs). It says `macos` because the Windows and
// Linux frames go on to call Tauri's own window API, which a browser cannot
// answer — the open gesture is identical on all three.
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { chromium } from 'playwright-core'

import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'
import { call, seedTeam } from '../navigation/lib/seed.mjs'

const SHOTS = resolve(REPO_ROOT, 'e2e', 'screenshots', 'document-window')
const BODY = 'The body a document window has to show.'

const main = async () => {
  await rm(SHOTS, { force: true, recursive: true })
  await mkdir(SHOTS, { recursive: true })

  const api = await startApi()
  let admin
  let browser
  try {
    admin = await startAdmin()
    const seed = await seedTeam(api)
    const suffix = Date.now().toString(36)
    const space = await call('/api/knowledge-base/spaces', {
      body: { name: `Document window ${suffix}`, projectId: seed.project.id },
      method: 'POST',
      token: seed.token,
    })
    const document = await call(`/api/knowledge-base/spaces/${space.id}/pages`, {
      body: { body: `<p>${BODY}</p>`, kind: 'document', title: `Quarterly plan ${suffix}` },
      method: 'POST',
      token: seed.token,
    })

    browser = await chromium.launch({ headless: true })
    const open = async ({ desktop }) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      await context.addInitScript((token) => {
        localStorage.setItem('nessie.admin.token', token)
      }, seed.token)
      if (desktop) {
        await context.addInitScript(() => {
          Object.defineProperty(window, '__nessieDesktopPlatform', { value: 'macos' })
        })
      }
      return context.newPage()
    }
    const row = (tab) => tab.locator(`[data-finder-row="${document.id}"]`)
    // The pane's own actions: present only once a document is open, and never
    // on a row in the browser.
    const opened = (tab) => tab.getByRole('button', { name: 'Attachments' })
    const browseTo = async (tab) => {
      await tab.goto(`${ADMIN_URL}/knowledge-base/spaces/${space.id}`, { waitUntil: 'domcontentloaded' })
      await row(tab).waitFor()
    }

    const web = await open({ desktop: false })
    await browseTo(web)
    await row(web).click()
    await opened(web).waitFor({ timeout: 15_000 })
    await web.screenshot({ path: resolve(SHOTS, 'web-one-tap-opens.png') })
    console.log('document-window e2e: the web still opens on one tap')

    const desktop = await open({ desktop: true })
    await browseTo(desktop)
    await row(desktop).click()
    // Long enough that an open would have landed. The assertion is the
    // absence, so it has to outlast the render it is denying.
    await desktop.waitForTimeout(1_500)
    assert.equal(
      await opened(desktop).count(),
      0,
      'the first tap on the desktop shell must select without opening',
    )
    assert.equal(
      await row(desktop).getAttribute('aria-selected'),
      'true',
      'the first tap still selects the row it landed on',
    )
    await desktop.screenshot({ path: resolve(SHOTS, 'desktop-one-tap-selects.png') })
    console.log('document-window e2e: one tap selects, and opens nothing')

    await row(desktop).dblclick()
    await opened(desktop).waitFor({ timeout: 15_000 })
    await desktop.screenshot({ path: resolve(SHOTS, 'desktop-double-tap-opens.png') })
    console.log('document-window e2e: the second tap opens (here, through the fallback)')

    const windowTab = await open({ desktop: true })
    await windowTab.goto(`${ADMIN_URL}/documents/${space.id}/${document.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await windowTab.getByText(BODY).waitFor({ timeout: 20_000 })
    assert.equal(
      await windowTab.locator('.admin-shell').count(),
      0,
      'a document window renders no admin shell',
    )
    assert.equal(
      await windowTab.locator('#admin-shell-main').count(),
      0,
      'a document window renders no shell main region',
    )
    assert.equal(
      await windowTab.getByRole('navigation', { name: 'Main navigation' }).count(),
      0,
      'a document window renders no sidebar rail',
    )
    // The window names itself, which is what the taskbar and the window
    // switcher read after the shell's own first title.
    assert.match(await windowTab.title(), new RegExp(`Quarterly plan ${suffix}`))
    await windowTab.screenshot({ path: resolve(SHOTS, 'document-window.png') })
    console.log('document-window e2e: the window holds the document and nothing else')

    const missing = await open({ desktop: true })
    await missing.goto(`${ADMIN_URL}/documents/${space.id}/page_gone`, {
      waitUntil: 'domcontentloaded',
    })
    // Not a spinner that never stops: a document that is not there is its own
    // fact, distinct from a fetch still in flight and from one that failed.
    await missing.getByText('This document isn’t here.').waitFor({ timeout: 20_000 })
    await missing.screenshot({ path: resolve(SHOTS, 'document-window-missing.png') })
    console.log('document-window e2e: a document that is not there says so')

    console.log('document-window e2e: passed')
  } finally {
    await browser?.close()
    if (admin) await stopProcess(admin)
    await stopProcess(api)
  }
}

await main()
