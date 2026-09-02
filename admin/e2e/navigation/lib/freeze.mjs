// Freezing a real transition. Everything here goes through
// `document.getAnimations()`, which sees a CSS keyframe animation and a Web
// Animations one alike — the navigation stack is moving from the first to
// the second (docs/navigation/overview.md §3), and the suite must not care which.
//
// The freezer arms before the interaction and pauses every animation on a
// `[data-phone-navigation-layer]` the frame it appears; the driver then
// seeks `currentTime` to 0 %, 50 % and 100 % and measures. No sleeps, and no
// dependency on how long a frame takes.

const armInPage = () => {
  const state = { animations: [], stopped: false }
  window.__navFreeze = state
  const tick = () => {
    for (const animation of document.getAnimations()) {
      const target = animation.effect && animation.effect.target
      if (!(target instanceof Element)) continue
      if (!target.matches('[data-phone-navigation-layer]')) continue
      if (state.animations.includes(animation)) continue
      animation.pause()
      state.animations.push(animation)
    }
    if (!state.stopped) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export const armFreeze = (page) => page.evaluate(armInPage)

export const disarmFreeze = (page) => page.evaluate(() => {
  const state = window.__navFreeze
  if (!state) return
  state.stopped = true
  state.animations = []
})

export const waitForFrozen = (page, timeoutMs = 5_000) => page.waitForFunction(
  () => (window.__navFreeze?.animations.length ?? 0) > 0,
  null,
  { polling: 'raf', timeout: timeoutMs },
)

const measureInPage = (fractions) => {
  const state = window.__navFreeze
  const viewport = document.querySelector('[data-phone-navigation-viewport]')
  if (!viewport) throw new Error('no [data-phone-navigation-viewport] in the document')
  if (!state || state.animations.length === 0) throw new Error('no frozen navigation animation')
  const frames = []
  for (const fraction of fractions) {
    for (const animation of state.animations) {
      const duration = Number(animation.effect.getComputedTiming().activeDuration)
      animation.currentTime = duration * fraction
    }
    // Reading a rect flushes the style and layout the seek just invalidated,
    // so every number below belongs to this exact frame.
    const box = viewport.getBoundingClientRect()
    const layers = [...viewport.querySelectorAll('[data-phone-navigation-layer]')].map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        animated: state.animations.some((animation) => animation.effect.target === element),
        hidden: element.hasAttribute('hidden'),
        left: rect.left,
        name: element.getAttribute('data-phone-navigation-layer'),
        // Displacement as a fraction of the viewport's width: 0 is resting
        // over the viewport origin, 1 is one full width to the right.
        offset: box.width === 0 ? 0 : (rect.left - box.left) / box.width,
        route: element.getAttribute('data-phone-navigation-route'),
        scrollLeft: element.scrollLeft,
      }
    })
    frames.push({
      fraction,
      layers,
      pageScrollLefts: [...viewport.querySelectorAll('[data-phone-navigation-page]')]
        .map((element) => element.scrollLeft),
      viewportScrollLeft: viewport.scrollLeft,
      viewportWidth: box.width,
    })
  }
  return {
    durationsMs: state.animations.map(
      (animation) => Number(animation.effect.getComputedTiming().activeDuration),
    ),
    frames,
  }
}

export const measureFrames = (page, fractions) => page.evaluate(measureInPage, fractions)

export const seekTo = (page, fraction) => page.evaluate((value) => {
  const state = window.__navFreeze
  for (const animation of state.animations) {
    const duration = Number(animation.effect.getComputedTiming().activeDuration)
    animation.currentTime = duration * value
  }
  document.querySelector('[data-phone-navigation-viewport]')?.getBoundingClientRect()
}, fraction)

// Settled means: a layer is resting as `current` and nothing on a navigation
// layer is still running. It is the precondition for arming the freezer, so
// a leftover animation from the previous step can never be captured instead.
export const waitForStackSettled = (page, timeoutMs = 15_000) => page.waitForFunction(
  () => {
    const viewport = document.querySelector('[data-phone-navigation-viewport]')
    if (!viewport) return false
    if (!viewport.querySelector('[data-phone-navigation-layer="current"]')) return false
    return !document.getAnimations().some((animation) => {
      const target = animation.effect && animation.effect.target
      return target instanceof Element
        && target.matches('[data-phone-navigation-layer]')
        && animation.playState === 'running'
    })
  },
  null,
  { polling: 'raf', timeout: timeoutMs },
)

// For the two "nothing moves" cases. Over a fixed window it watches for an
// animation whose target *is* a navigation layer or one of the named region
// elements — a descendant's own animation (the tab pill sliding, a spinner)
// is not the screen moving — and reports each region's geometry at both ends
// of the window so the caller can assert it did not shift.
export const watchForMotion = (page, { selectors, windowMs }) => page.evaluate(
  async ({ duration, names }) => {
    const read = () => names.map((selector) => {
      const element = document.querySelector(selector)
      if (!element) return { rect: null, scrollLeft: null, selector }
      const rect = element.getBoundingClientRect()
      return {
        rect: { height: rect.height, left: rect.left, top: rect.top, width: rect.width },
        scrollLeft: element.scrollLeft,
        selector,
      }
    })
    const moves = (target) => target.matches('[data-phone-navigation-layer]')
      || names.some((selector) => target.matches(selector))
    const before = read()
    const seen = new Set()
    const deadline = performance.now() + duration
    await new Promise((done) => {
      const tick = () => {
        for (const animation of document.getAnimations()) {
          const target = animation.effect && animation.effect.target
          if (!(target instanceof Element) || !moves(target)) continue
          seen.add(`${target.getAttribute('data-phone-navigation-layer') ?? target.tagName}`)
        }
        if (performance.now() >= deadline) { done(); return }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return { after: read(), animated: [...seen], before }
  },
  { duration: windowMs, names: selectors },
)

export const hasPhoneViewport = (page) => page.evaluate(
  () => Boolean(document.querySelector('[data-phone-navigation-viewport]')),
)
