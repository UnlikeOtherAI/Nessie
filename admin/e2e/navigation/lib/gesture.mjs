// Real touchscreen input on Chromium; WebKit's Playwright protocol has no
// touch-drag command, so dispatch DOM touches against the real renderer there.
export const startGesture = async (page, x = 8, y = 420) => {
  const chromium = page.context().browser()?.browserType().name() === 'chromium'
  const client = chromium ? await page.context().newCDPSession(page) : null
  if (!client) await page.evaluate(({ x, y }) => {
    window.__navigationTouchTarget = document.elementFromPoint(x, y)
  }, { x, y })
  const send = async (type, at) => {
    if (client) {
      await client.send('Input.dispatchTouchEvent', {
        type: { touchstart: 'touchStart', touchmove: 'touchMove', touchend: 'touchEnd' }[type],
        touchPoints: type === 'touchend' ? [] : [{ x: at, y }],
      })
    } else {
      await page.evaluate(({ type, x, y }) => {
        const target = window.__navigationTouchTarget
        const touch = { identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y }
        const touches = type === 'touchend' ? [] : [touch]
        // Desktop WebKit has touch delivery but no constructible Touch API.
        const event = new Event(type, { bubbles: true, cancelable: true })
        Object.defineProperties(event, {
          changedTouches: { value: [touch] }, targetTouches: { value: touches }, touches: { value: touches },
        })
        target.dispatchEvent(event)
      }, { type, x: at, y })
    }
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  }
  await send('touchstart', x)
  return {
    move: (at) => send('touchmove', at),
    end: async (at) => {
      await send('touchend', at)
      await client?.detach()
    },
  }
}
