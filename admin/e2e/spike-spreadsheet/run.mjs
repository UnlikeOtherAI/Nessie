#!/usr/bin/env node
// Spike C (render) and Spike D (touch) driver.
//
// Headless Chromium against the throwaway page at
// `admin/src/routes/__spike-spreadsheet/index.html`. No API and no database:
// the spike proves the widget, the model bridge, the redraw patch, the theme
// mapping and the touch gestures, none of which need a server.
//
//   NAV_E2E_ADMIN_PORT=5561 node admin/e2e/spike-spreadsheet/run.mjs
//
// The repo's admin port is 5455; `NAV_E2E_ADMIN_PORT` moves the suite off it
// when another worktree owns it (CLAUDE.md -> "E2E on scratch ports").
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const adminRoot = resolve(import.meta.dirname, '..', '..')
const repoRoot = resolve(adminRoot, '..')
const shots = resolve(repoRoot, 'docs', 'plans', '2026-09-15-spreadsheets-ironcalc', 'spike-cd')
const port = Number(process.env.NAV_E2E_ADMIN_PORT?.trim() || 5455)
const url = `http://127.0.0.1:${port}/src/routes/__spike-spreadsheet/index.html`
const adopt = process.env.SPIKE_ADOPT_SERVER === '1'
const findings = []
const record = (name, value) => { findings.push({ name, value }); console.log(`  ${name}: ${JSON.stringify(value)}`) }

const waitFor = async (probe) => {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try { if (await probe()) return } catch { /* poll */ }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error('server did not become ready')
}

const startVite = () => spawn('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
  cwd: adminRoot, detached: true, stdio: 'ignore',
})
const stop = async (child) => {
  if (!child?.pid || child.exitCode !== null) return
  await new Promise((done) => {
    child.once('exit', done)
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    setTimeout(done, 5_000)
  })
}

const openWorkbook = async (page) => {
  await page.getByTestId('open-spreadsheet').click()
  await page.waitForFunction(() => window.__spike?.ready === true, null, { timeout: 60_000 })
  await page.locator('canvas.ic-worksheet-sheet-canvas').waitFor()
}

// Spike C -----------------------------------------------------------------
const spikeRender = async (browser) => {
  const context = await browser.newContext({ viewport: { height: 860, width: 1280 } })
  const page = await context.newPage()
  const seen = []
  page.on('response', (r) => seen.push({ type: r.request().resourceType(), url: r.url() }))
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(url, { waitUntil: 'networkidle' })

  const isIronCalc = (u) => /ironcalc|wasm_bg/i.test(u)
  record('lazy.beforeOpen', seen.filter((r) => isIronCalc(r.url)).length)
  await openWorkbook(page)
  record('lazy.afterOpen', seen.filter((r) => isIronCalc(r.url)).map((r) => r.url.replace(/^.*\/(?=[^/]+$)/, '')))

  // 1. It renders, and the seeded formula evaluated.
  record('render.formula.B4', await page.evaluate(() => window.__spike.cell(4, 2)))
  assert.equal(await page.evaluate(() => window.__spike.cell(4, 2)), '200')

  // 2. Editing a cell through the widget's own keyboard path.
  const b2 = await page.evaluate(() => window.__spike.cellPoint(2, 2))
  // `force` because IronCalc's own cell-outline div sits over the canvas; the
  // widget's handlers are delegated to the sheet container either way.
  await page.locator('canvas.ic-worksheet-sheet-canvas').click({ force: true, position: b2 })
  await page.keyboard.type('220')
  await page.locator('.ic-worksheet-editor-wrapper textarea').waitFor()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__spike.cell(2, 2) === '220')
  record('render.edit.B2', await page.evaluate(() => window.__spike.cell(2, 2)))
  record('render.edit.recalculated.B4', await page.evaluate(() => window.__spike.cell(4, 2)))
  assert.equal(await page.evaluate(() => window.__spike.cell(4, 2)), '300')

  // 3. The bridge saw that edit as an intent and drained the send queue.
  const flushed = await page.evaluate(() => window.__spike.flushes.map((f) => ({
    diffBytes: f.diffs.length, methods: f.intents.map((i) => i.method),
  })))
  record('bridge.flushes', flushed)
  assert.ok(flushed.some((f) => f.methods.includes('setUserInput') && f.diffBytes > 0))
  record('bridge.wrappedMethods', await page.evaluate(() => window.__spike.recorded.length))
  record('bridge.ownProperties', await page.evaluate(
    () => Object.getOwnPropertyNames(window.__spike).length > 0
      && typeof window.__spike.cell === 'function',
  ))
  record('bridge.presenceFrames', await page.evaluate(() => window.__spike.presence.length))

  // 4. Undo / redo.
  await page.evaluate(() => window.__spike.undo())
  record('render.undo.B2', await page.evaluate(() => window.__spike.cell(2, 2)))
  assert.equal(await page.evaluate(() => window.__spike.cell(2, 2)), '120')
  await page.evaluate(() => window.__spike.redo())
  record('render.redo.B2', await page.evaluate(() => window.__spike.cell(2, 2)))
  assert.equal(await page.evaluate(() => window.__spike.cell(2, 2)), '220')

  // 5. Insert row: a structural op the formula follows.
  await page.evaluate(() => window.__spike.insertRow(2))
  record('render.insertRow.A3', await page.evaluate(() => window.__spike.cell(3, 1)))
  record('render.insertRow.total', await page.evaluate(() => window.__spike.cell(5, 2)))
  assert.equal(await page.evaluate(() => window.__spike.cell(3, 1)), 'North')
  assert.equal(await page.evaluate(() => window.__spike.cell(5, 2)), '300')

  // 6. The collaboration bridge: a second model's diffs applied to the mounted
  //    one inside pauseEvaluation ... resumeEvaluation/evaluate, then the
  //    patched redraw().
  const peer = await page.evaluate(() => window.__spike.applyPeerBatch('B3', '999'))
  record('collab.applyExternalDiffs', peer)
  assert.ok(peer.diffBytes > 0, 'peer produced no diffs')
  assert.equal(peer.after, '999')
  assert.deepEqual(peer.echoedBytes, [0],
    'applyExternalDiffs refilled the local send queue')

  // Engine byte stability. `toBytes()` is NOT a canonical serialisation in
  // 0.8.x: two models forked from the same bytes serialise differently, so
  // model equality has to be asserted on values, never on bytes.
  const pair = await page.evaluate(() => window.__spike.pairProbe())
  record('engine.byteStability', pair)
  assert.equal(pair.valuesEqual, true, 'the same diffs produced different values')
  assert.equal(pair.selfEqual, true)
  // The patch earns its place here: the same batch applied WITHOUT redraw()
  // leaves the canvas stale, and redraw() paints it.
  const painted = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas.ic-worksheet-sheet-canvas')
    const frame = () => new Promise((done) => requestAnimationFrame(done))
    const start = canvas.toDataURL()
    window.__spike.applyPeerBatch('D2', 'painted-by-peer', false)
    await frame(); await frame()
    const withoutRedraw = canvas.toDataURL()
    window.__spike.redraw()
    await frame(); await frame()
    const withRedraw = canvas.toDataURL()
    return {
      staleWithoutRedraw: withoutRedraw === start,
      repaintedByRedraw: withRedraw !== withoutRedraw,
    }
  })
  record('collab.redrawIsRequired', painted)
  assert.equal(painted.staleWithoutRedraw, true, 'the canvas repainted without redraw()')
  assert.equal(painted.repaintedByRedraw, true, 'redraw() did not repaint the canvas')

  // 7. Theme, light and dark.
  await page.evaluate(() => window.__spike.setTheme('daylight'))
  await page.waitForTimeout(250)
  await page.screenshot({ path: resolve(shots, 'desktop-light.png') })
  record('theme.light', await page.evaluate(() => {
    const root = getComputedStyle(document.querySelector('.ic-root'))
    return {
      grid: root.getPropertyValue('--palette-sheet-grid-color').trim(),
      outline: root.getPropertyValue('--palette-sheet-outline-color').trim(),
      surface: root.getPropertyValue('--palette-common-white').trim(),
    }
  }))
  await page.evaluate(() => window.__spike.setTheme('midnight'))
  await page.waitForTimeout(250)
  await page.evaluate(() => window.__spike.redraw())
  await page.waitForTimeout(250)
  await page.screenshot({ path: resolve(shots, 'desktop-dark.png') })
  record('theme.dark', await page.evaluate(() => {
    const root = getComputedStyle(document.querySelector('.ic-root'))
    return {
      grid: root.getPropertyValue('--palette-sheet-grid-color').trim(),
      outline: root.getPropertyValue('--palette-sheet-outline-color').trim(),
      surface: root.getPropertyValue('--palette-common-white').trim(),
    }
  }))
  record('render.pageErrors', errors)
  assert.deepEqual(errors, [])
  await context.close()
}

// Spike D -----------------------------------------------------------------
const spikeTouch = async (browser) => {
  const context = await browser.newContext({
    hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 },
  })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'daylight' })
  await openWorkbook(page)
  const canvas = page.locator('canvas.ic-worksheet-sheet-canvas')
  const box = await canvas.boundingBox()
  const at = async (row, column) => {
    const point = await page.evaluate(([r, c]) => window.__spike.cellPoint(r, c), [row, column])
    return { x: box.x + point.x, y: box.y + point.y }
  }

  // 1. Tap selects a cell.
  const a2 = await at(2, 1)
  await page.touchscreen.tap(a2.x, a2.y)
  await page.waitForTimeout(150)
  record('touch.tapSelects', await page.evaluate(() => window.__spike.selection()))

  // 2. Double-tap opens the editor and an <input>/<textarea> takes focus.
  //    The pause keeps the select tap above out of the double-tap sequence.
  await page.waitForTimeout(700)
  await page.touchscreen.tap(a2.x, a2.y)
  await page.touchscreen.tap(a2.x, a2.y)
  const editor = page.locator('.ic-worksheet-editor-wrapper textarea')
  await editor.waitFor({ timeout: 5_000 })
  record('touch.editorFocused', await page.evaluate(
    () => document.activeElement?.tagName.toLowerCase(),
  ))
  await editor.press('ControlOrMeta+a')
  await page.keyboard.type('Nord')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  record('touch.enterCommits', await page.evaluate(() => window.__spike.cell(2, 1)))
  assert.equal(await page.evaluate(() => window.__spike.cell(2, 1)), 'Nord')
  await page.screenshot({ path: resolve(shots, 'phone-light.png') })

  // 3. A real finger drag still scrolls, i.e. the overlay does not steal the
  //    gesture. Playwright's touchscreen only taps, so the swipe goes through
  //    CDP as a genuine touch sequence the compositor handles.
  const cdp = await context.newCDPSession(page)
  const swipe = async (from, dy, steps = 12) => {
    const send = (type, y) => cdp.send('Input.dispatchTouchEvent', {
      touchPoints: type === 'touchEnd' ? [] : [{ x: from.x, y }], type,
    })
    await send('touchStart', from.y)
    for (let i = 1; i <= steps; i += 1) await send('touchMove', from.y + (dy * i) / steps)
    await send('touchEnd', from.y + dy)
  }
  const wrapper = page.locator('.ic-worksheet-wrapper')
  const before = await wrapper.evaluate((el) => el.scrollTop)
  await swipe(await at(8, 3), -260)
  await page.waitForTimeout(400)
  const after = await wrapper.evaluate((el) => el.scrollTop)
  record('touch.dragScrolls', { after, before })
  assert.ok(after > before, 'a plain touch drag did not scroll the sheet')
  await wrapper.evaluate((el) => { el.scrollTop = 0 })
  await page.waitForTimeout(300)

  // 4. IronCalc's own drag does NOT select a range (the gap this closes).
  const start = await at(2, 2); const finish = await at(5, 4)
  await page.evaluate(() => window.__spike.selection())
  await page.touchscreen.tap(start.x, start.y)
  await page.waitForTimeout(100)
  const plainDrag = await page.evaluate(async ([sx, sy, ex, ey]) => {
    const target = document.querySelector('canvas.ic-worksheet-sheet-canvas')
    const send = (type, x, y) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'touch',
    }))
    send('pointerdown', sx, sy)
    for (let i = 1; i <= 6; i += 1) send('pointermove', sx + ((ex - sx) * i) / 6, sy + ((ey - sy) * i) / 6)
    send('pointerup', ex, ey)
    await new Promise((done) => setTimeout(done, 60))
    return window.__spike.selection()
  }, [start.x, start.y, finish.x, finish.y])
  record('touch.plainDragSelectsRange', plainDrag)
  assert.equal(plainDrag[0], plainDrag[2], 'upstream usePointer unexpectedly selected a range')

  // 5. The prototype: long-press then drag selects a range and leaves handles.
  const longPress = await page.evaluate(async ([sx, sy, ex, ey]) => {
    const target = document.querySelector('canvas.ic-worksheet-sheet-canvas')
    const send = (type, x, y) => {
      const event = new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 9, pointerType: 'touch',
      })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    send('pointerdown', sx, sy)
    await new Promise((done) => setTimeout(done, 450))
    const entered = window.__spike.touchMode()
    let prevented = false
    for (let i = 1; i <= 6; i += 1) {
      prevented = send('pointermove', sx + ((ex - sx) * i) / 6, sy + ((ey - sy) * i) / 6) || prevented
    }
    const container = document.querySelector('.ic-worksheet-sheet-container')
    const touchAction = getComputedStyle(container).touchAction
    const range = window.__spike.selection()
    send('pointerup', ex, ey)
    await new Promise((done) => setTimeout(done, 60))
    return {
      entered,
      handles: document.querySelectorAll('[data-spike-touch-handle]:not([style*="display: none"])').length,
      prevented,
      range,
      released: window.__spike.touchMode(),
      touchAction,
    }
  }, [start.x, start.y, finish.x, finish.y])
  record('touch.longPressRange', longPress)
  assert.ok(longPress.entered, 'long press did not enter selection mode')
  assert.notEqual(longPress.range[0], longPress.range[2], 'long-press drag selected no range')
  assert.equal(longPress.touchAction, 'none')
  assert.ok(longPress.prevented, 'touchmove was not prevented while selecting')
  assert.equal(longPress.handles, 2)
  assert.equal(longPress.released, false)

  // 6. The same gesture as a REAL touch sequence through CDP, which is what
  //    the compositor sees: hold, then drag. The range must follow the finger
  //    and the sheet must not scroll while it does.
  await page.evaluate(() => window.__spike.redraw())
  const held = await (async () => {
    const from = await at(3, 2)
    const to = await at(7, 4)
    const scrollBefore = await wrapper.evaluate((el) => el.scrollTop)
    await cdp.send('Input.dispatchTouchEvent', { touchPoints: [{ x: from.x, y: from.y }], type: 'touchStart' })
    await page.waitForTimeout(500)
    const entered = await page.evaluate(() => window.__spike.touchMode())
    for (let i = 1; i <= 10; i += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        touchPoints: [{
          x: from.x + ((to.x - from.x) * i) / 10,
          y: from.y + ((to.y - from.y) * i) / 10,
        }],
        type: 'touchMove',
      })
    }
    const range = await page.evaluate(() => window.__spike.selection())
    const scrollDuring = await wrapper.evaluate((el) => el.scrollTop)
    await cdp.send('Input.dispatchTouchEvent', { touchPoints: [], type: 'touchEnd' })
    await page.waitForTimeout(200)
    return { entered, range, scrollBefore, scrollDuring }
  })()
  record('touch.realLongPressDrag', held)
  assert.equal(held.entered, true, 'a real held touch did not enter selection mode')
  assert.notEqual(held.range[0], held.range[2], 'a real long-press drag selected no range')
  assert.equal(held.scrollDuring, held.scrollBefore, 'the sheet scrolled while selecting')
  await page.screenshot({ path: resolve(shots, 'phone-selection.png') })

  await page.evaluate(() => { document.documentElement.dataset.theme = 'midnight'; window.__spike.setTheme('midnight') })
  await page.waitForTimeout(250)
  await page.evaluate(() => window.__spike.redraw())
  await page.waitForTimeout(250)
  await page.screenshot({ path: resolve(shots, 'phone-dark.png') })
  await context.close()
}

const main = async () => {
  await mkdir(shots, { recursive: true })
  const server = adopt ? undefined : startVite()
  let browser
  try {
    await waitFor(async () => (await fetch(url)).ok)
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH?.trim() || undefined })
    console.log('Spike C — render')
    await spikeRender(browser)
    console.log('Spike D — touch')
    await spikeTouch(browser)
    await writeFile(resolve(shots, 'findings.json'), `${JSON.stringify(findings, null, 2)}\n`)
    console.log(`\nWrote ${findings.length} findings and four screenshots to ${shots}`)
  } finally {
    await browser?.close()
    await stop(server)
  }
}

await main()
