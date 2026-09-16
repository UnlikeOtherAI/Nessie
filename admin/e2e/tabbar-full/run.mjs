// `fullWidth` means the inline axis, and only the inline axis.
//
// `.tabbar-shell-full` once carried `flex: 1 1 auto` alongside its `width`.
// In a row that grow is inert — a `flex-basis: auto` resolving to `width: 100%`
// leaves no free space to distribute — so it read as harmless. But a flex
// container's main axis is whichever way it runs, and both mailbox asides are
// `flex-col`: there the strip grew down instead, taking every pixel the
// conversation list was not already using. A 32px strip rendered 363px tall in
// a 420px column, and the list it sits above became a sliver.
//
// This suite measures the primitive in every container shape a call site puts
// it in — the class lists in `fixture.tsx` are copied from those call sites —
// and asserts the two facts that were wrong: the shell spans its container's
// inline axis, and its block size is the strip's own, never the leftover.
//
//   pnpm --filter @nessie/admin test:e2e:tabbar-full

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const outDir = resolve(REPO_ROOT, 'e2e/screenshots/tabbar-full')

const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { height: 1000, width: 1280 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(`${ADMIN_URL}/e2e/tabbar-full/index.html`)
  await page.locator('[data-site="presence-control"] .tabbar-shell-full').waitFor()
  await page.waitForTimeout(400)
  assert.equal(errors.length, 0, `tab bar fixture errors: ${errors.join(' | ')}`)

  const sites = await page.evaluate(() => Array.from(document.querySelectorAll('[data-site]')).map((container) => {
    const shell = container.querySelector('.tabbar-shell-full')
    const style = getComputedStyle(container)
    const inlineSize = container.getBoundingClientRect().width
      - Number.parseFloat(style.paddingLeft)
      - Number.parseFloat(style.paddingRight)
    return {
      containerInlineSize: Math.round(inlineSize),
      name: container.dataset.site,
      shellHeight: Math.round(shell.getBoundingClientRect().height),
      shellWidth: Math.round(shell.getBoundingClientRect().width),
    }
  }))
  assert.ok(sites.length >= 13, `the fixture lost call sites: only ${sites.length} measured`)

  // The block size a strip of this `size` occupies when nothing constrains it.
  // Every other container must produce the same number, whatever its layout
  // mode and whatever space it has spare.
  const reference = sites.find((site) => site.name === 'presence-control')
  assert.ok(reference, 'the unconstrained reference site is missing')

  for (const site of sites) {
    assert.equal(
      site.shellWidth,
      site.containerInlineSize,
      `${site.name}: the strip must span its container's inline axis `
        + `(${site.shellWidth}px in ${site.containerInlineSize}px)`,
    )
    assert.equal(
      site.shellHeight,
      reference.shellHeight,
      `${site.name}: the strip grew along the block axis `
        + `(${site.shellHeight}px, expected ${reference.shellHeight}px)`,
    )
  }

  await mkdir(outDir, { recursive: true })
  await page.screenshot({ fullPage: true, path: resolve(outDir, 'call-sites.png') })
  console.log(`tab bar full-width: ${sites.length} call sites, every strip ${reference.shellHeight}px tall and inline-full`)
  console.log(`tab bar full-width: screenshot in ${outDir}`)
  await context.close()
} finally {
  await browser.close()
  await stopProcess(admin)
}
