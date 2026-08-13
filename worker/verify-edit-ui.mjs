// Verifies the edit-following viewport: drives a mid-document edit and samples
// where the change sits in the scroll container while it is being written.
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const OUT = process.env.OUT_DIR
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
})
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
await page.addInitScript((token) => {
  localStorage.setItem('nessie.admin.token', token)
}, process.env.NESSIE_TOKEN)

await page.goto(`http://127.0.0.1:5455/channels/${process.env.CHANNEL_ID}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForTimeout(6000)

const driver = spawn('node', ['seed-and-edit.mjs'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
})

/** Where the edit cursor sits relative to the scroll viewport. */
const probe = () =>
  page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return null
    const scroller = Array.from(dialog.querySelectorAll('*')).find((el) => (
      el.scrollHeight > el.clientHeight + 8
    ))
    if (!scroller) return { dialog: true, scroller: false }
    return {
      atBottom: Math.abs(
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      ) < 4,
      chars: (dialog.textContent ?? '').length,
      clientHeight: scroller.clientHeight,
      dialog: true,
      scrollFraction: scroller.scrollHeight > scroller.clientHeight
        ? Number((scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight)).toFixed(3))
        : 0,
      scrollHeight: scroller.scrollHeight,
      scrollTop: Math.round(scroller.scrollTop),
      scroller: true,
    }
  })

for (let i = 0; i < 8; i += 1) {
  await page.waitForTimeout(1400)
  const snapshot = await probe()
  console.log(`t+${((i + 1) * 1.4).toFixed(1)}s`, JSON.stringify(snapshot))
  if (i === 2) await page.screenshot({ path: `${OUT}/e1-mid-edit.png` })
  if (i === 5) await page.screenshot({ path: `${OUT}/e2-later-edit.png` })
}

await new Promise((resolve) => driver.on('exit', resolve))
await page.waitForTimeout(2000)
await page.screenshot({ path: `${OUT}/e3-edit-final.png` })
console.log('final', JSON.stringify(await probe()))
await browser.close()
