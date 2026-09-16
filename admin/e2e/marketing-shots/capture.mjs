// Cutting one piece of the running admin out onto a transparent background.
//
// The website places these on white and on navy, so a rectangular PNG with a
// CSS radius over it shows a hard corner against the darker band. The radius
// therefore has to be in the file's alpha channel, and so does the shadow:
// `box-shadow` draws around the element's *box*, so on a rounded transparent
// PNG it leaks past the corners. `filter: drop-shadow` follows the alpha shape
// instead, which is why the shadow is applied as a filter here.
//
// Chromium composites an element screenshot over whatever is painted behind
// it, so `omitBackground` alone is not enough: every ancestor between the
// target and the document still paints the admin's cream shell into the
// corners. `bare()` walks that chain and clears it. Verified by reading the
// corner pixel of the result — see `assertRounded` in run.mjs.

/** Nothing moves while a frame is being taken. */
export const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
    caret-color: transparent !important;
  }
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
`

/**
 * Leave `element` alone on the page.
 *
 * Two things have to go. Every ancestor's paint, because Chromium composites
 * the shot over what is behind the element and the shell's cream would
 * otherwise fill the corners the radius cuts away. And every *sibling* at
 * every level, because the clip is deliberately wider than the element — it
 * has to be, to hold the shadow — so the sidebar and the rail beside it land
 * in that margin. Hiding ancestors instead of their siblings would take the
 * target with them: `visibility` inherits, so the walk hides the siblings and
 * the chain itself stays visible.
 *
 * `overflow` goes too: an ancestor that clips cuts the drop shadow off in
 * mid-air.
 */
const bare = `(element) => {
  // The piece worth cutting out is usually a layout box with no background of
  // its own — the colour under it belongs to the shell. Read that colour off
  // the chain and pin it to the target BEFORE the chain is cleared, or the
  // cut-out comes back as text floating on nothing.
  const opaque = (value) => value && value !== 'transparent' && !/rgba\\(0, 0, 0, 0\\)/.test(value)
  let inherited = null
  for (let node = element; node && !inherited; node = node.parentElement) {
    const painted = getComputedStyle(node).backgroundColor
    if (opaque(painted)) inherited = painted
  }
  if (inherited && !opaque(getComputedStyle(element).backgroundColor)) {
    element.style.setProperty('background-color', inherited, 'important')
  }

  let hidden = 0
  for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
    for (const sibling of node.parentElement?.children ?? []) {
      if (sibling === node) continue
      sibling.style.setProperty('visibility', 'hidden', 'important')
      hidden += 1
    }
  }
  for (let node = element.parentElement; node; node = node.parentElement) {
    node.style.setProperty('background', 'transparent', 'important')
    node.style.setProperty('background-image', 'none', 'important')
    node.style.setProperty('box-shadow', 'none', 'important')
    node.style.setProperty('border', '0', 'important')
    node.style.setProperty('overflow', 'visible', 'important')
  }
  for (const node of [document.documentElement, document.body]) {
    node.style.setProperty('background', 'transparent', 'important')
    node.style.setProperty('background-image', 'none', 'important')
  }
  return hidden
}`

/**
 * A rounded, shadowed cut-out of one element, written straight to `path`.
 *
 * `pad` is the room left around the element for the shadow; it is part of the
 * image, so the website needs no margin of its own. The clip is taken from the
 * page rather than the locator because a locator screenshot stops at the
 * element's own box and would slice the shadow off.
 */
export const captureElement = async (page, { hide = [], inset = 0, pad = 48, path, radius = 20, selector, shadow = '0 18px 44px rgba(11, 23, 42, 0.18)' }) => {
  const target = page.locator(selector).first()
  await target.waitFor({ state: 'visible' })
  await target.scrollIntoViewIfNeeded()

  for (const other of hide) {
    await page.evaluate((css) => {
      for (const node of document.querySelectorAll(css)) node.style.setProperty('visibility', 'hidden', 'important')
    }, other)
  }

  await page.evaluate(() => { document.activeElement?.blur?.() })
  await target.evaluate(new Function(`return ${bare}`)())
  // `overflow: hidden` is what makes the radius actually clip: without it a
  // child's own square background paints over the corner and the alpha never
  // opens up.
  await target.evaluate((element, [r, s, i]) => {
    element.style.setProperty('border-radius', `${r}px`, 'important')
    element.style.setProperty('overflow', 'hidden', 'important')
    element.style.setProperty('filter', `drop-shadow(${s})`, 'important')
    // Content that starts in the element's own corner is otherwise shaved off
    // by the radius — a section heading loses its first letter.
    if (i > 0) element.style.setProperty('padding', `${i}px`, 'important')
  }, [radius, shadow, inset])

  // Measured after the styles land: a radius or filter can reflow the box.
  const box = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { height: rect.height, width: rect.width, x: rect.x, y: rect.y }
  })
  const viewport = page.viewportSize()
  const clip = {
    height: Math.min(box.height + pad * 2, viewport.height - Math.max(0, box.y - pad)),
    width: Math.min(box.width + pad * 2, viewport.width - Math.max(0, box.x - pad)),
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
  }
  if (clip.height < box.height || clip.width < box.width) {
    throw new Error(
      `${selector} is ${Math.round(box.width)}x${Math.round(box.height)} at (${Math.round(box.x)}, ${Math.round(box.y)}), which does not fit in a ${viewport.width}x${viewport.height} viewport with ${pad}px of shadow room — give the shot a taller viewport`,
    )
  }
  await page.screenshot({ clip, omitBackground: true, path, scale: 'device' })
  return clip
}

/**
 * The three hero shots are painted into the 3D iMac's screen texture, so they
 * are whole-window, opaque and 16:10 — the bezel does the rounding. Nothing
 * here strips a background.
 */
export const captureWindow = async (page, { hide = [], path }) => {
  for (const other of hide) {
    await page.evaluate((css) => {
      for (const node of document.querySelectorAll(css)) node.style.setProperty('visibility', 'hidden', 'important')
    }, other)
  }
  await page.screenshot({ path, scale: 'device' })
}
