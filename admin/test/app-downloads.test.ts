import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'

import {
  AppDownloads,
  APP_DOWNLOADS,
  EXECUTOR_DOWNLOADS,
  LATEST_RELEASE_DOWNLOAD_BASE,
  LATEST_RELEASE_PAGE,
  downloadUrl,
} from '@nessie/sign-in-surface'

/**
 * One list, two doorways: the admin sign-in renders this block and the
 * nessie.works landing reads the same module, so a renamed release asset changes
 * in one place. The Nessie Executor images joined it because a Mac that runs only
 * an executor needs a download of its own — and because two tiles both reading
 * "Mac" under one heading is how a person ends up with the wrong product.
 */

;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/login',
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')

const renderDownloads = async (): Promise<string> => {
  const globals = {
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MouseEvent: dom.window.MouseEvent,
    navigator: dom.window.navigator,
    window: dom.window,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(h(AppDownloads))
  })
  const html = container.innerHTML
  await act(async () => root.unmount())
  container.remove()
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as Record<string, unknown>)[key]
  }
  return html
}

test('every download points at a release asset on the one base', () => {
  for (const download of [
    ...Object.values(APP_DOWNLOADS),
    ...Object.values(EXECUTOR_DOWNLOADS),
  ]) {
    assert.equal(downloadUrl(download), `${LATEST_RELEASE_DOWNLOAD_BASE}/${download.asset}`)
    assert.match(downloadUrl(download), /^https:\/\/github\.com\/UnlikeOtherAI\/Nessie\/releases\/latest\/download\//)
  }
})

/**
 * The asset names are the release workflow's, and a typo here is a 404 for every
 * person who clicks. They are asserted literally rather than derived, so a rename
 * has to happen in both places on purpose.
 */
test('the executor images are named exactly as the release publishes them', () => {
  assert.equal(EXECUTOR_DOWNLOADS.macAppleSilicon.asset, 'Nessie-Executor-macOS-Apple-Silicon.dmg')
  assert.equal(EXECUTOR_DOWNLOADS.macIntel.asset, 'Nessie-Executor-macOS-Intel.dmg')
})

test('the executor downloads are on screen and labelled as the executor', async () => {
  const html = await renderDownloads()
  for (const download of Object.values(EXECUTOR_DOWNLOADS)) {
    assert.match(html, new RegExp(downloadUrl(download).replace(/[/.]/g, '\\$&')))
  }
  // Labelled as a different product from the chat app above it, and said once in
  // words rather than left to a person to infer from two identical tiles.
  assert.match(html, /Mac executor/)
  assert.match(html, /only runs an executor/)
})

test('the chat app downloads are untouched beside them', async () => {
  const html = await renderDownloads()
  for (const download of Object.values(APP_DOWNLOADS)) {
    assert.match(html, new RegExp(downloadUrl(download).replace(/[/.]/g, '\\$&')))
  }
})

/**
 * People download from our surface. GitHub is where the files live, so the link
 * exists — once, quietly, underneath — and never as the way to get an app.
 */
test('the release page is linked once, under the downloads', async () => {
  const html = await renderDownloads()
  // The whole href, not a substring: the release page's URL is a prefix of every
  // asset URL, so counting the bare address counts every download as well.
  const releaseHref = `href="${LATEST_RELEASE_PAGE}"`
  const links = html.match(new RegExp(releaseHref.replace(/[/."]/g, '\\$&'), 'g')) ?? []
  assert.equal(links.length, 1)
  assert.match(html, /Checksums and earlier releases on GitHub/)
  const lastDownloadAt = Math.max(
    ...Object.values(EXECUTOR_DOWNLOADS).map((download) => html.indexOf(downloadUrl(download))),
    ...Object.values(APP_DOWNLOADS).map((download) => html.indexOf(downloadUrl(download))),
  )
  assert.ok(html.indexOf(releaseHref) > lastDownloadAt, 'the quiet link sits after the downloads')
})
