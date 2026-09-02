// Run from the repo root after `pnpm install`:
//   node docs/done/2026-09-01-navigation-motion-system/repro.mjs
// Needs Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH or the executablePath below).
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const DURATION = 3000


const run = async (browser, scenario) => {
  const page = await browser.newPage({ viewport: { width: 393, height: 720 }, deviceScaleFactor: 1 })
  await page.goto(`file://${path.join(here, 'repro.html')}`)
  const { scrollLeftAfterMount } = await page.evaluate(
    (s) => window.push(s), { ...scenario, durationMs: DURATION },
  )
  const t0 = Date.now()
  // A React commit somewhere in the incoming page (queries resolving, feed
  // pinning to bottom) flushes layout mid-animation; simulate one at ~90%.
  let scrollLeftMid = 'no flush'
  if (scenario.flushAt !== null) {
    await page.waitForTimeout(DURATION * scenario.flushAt)
    scrollLeftMid = await page.evaluate(() => window.flushLayout())
  }
  const tMid = Date.now() - t0
  await page.waitForTimeout(DURATION - (Date.now() - t0) + 40)
  const finish = await page.evaluate(() => window.finish())
  await page.close()
  return {
    scenario: scenario.name,
    scrollLeftAfterMount,
    scrollLeftAtMidFlush: `${scrollLeftMid}px @ ${tMid}ms`,
    scrollLeftAfterFinish: finish.scrollLeftAfterFinish,
  }
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const results = []
for (const scenario of [
  { name: 'hidden+siv, flush@40%', scrollIntoView: true, clip: false, flushAt: 0.4 },
  { name: 'hidden+siv, flush@60%', scrollIntoView: true, clip: false, flushAt: 0.6 },
  { name: 'hidden+siv, no flush', scrollIntoView: true, clip: false, flushAt: null },
  { name: 'hidden, control', scrollIntoView: false, clip: false, flushAt: 0.4 },
  { name: 'clip+siv, flush@40%', scrollIntoView: true, clip: true, flushAt: 0.4 },
]) {
  results.push(await run(browser, scenario))
}
await browser.close()
console.table(results)
