// Numeric assertions over frozen frames. Every check is recorded, so one
// failing case still reports every other check it made and still leaves its
// screenshots behind.

export class CaseFailure extends Error {
  constructor(caseName, failures) {
    super(`${caseName}: ${failures.length} check(s) failed`)
    this.name = 'CaseFailure'
    this.failures = failures
  }
}

export const createChecks = (caseName) => {
  const checks = []
  return {
    checks,
    // Throws at the end of a case, never mid-way: the artifacts are worth
    // more than an early exit.
    close: () => {
      const failures = checks.filter((check) => !check.passed)
      if (failures.length > 0) throw new CaseFailure(caseName, failures)
    },
    equal: (label, actual, expected) => {
      checks.push({ detail: `${actual} (expected ${expected})`, label, passed: actual === expected })
    },
    near: (label, actual, expected, tolerance) => {
      const passed = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance
      checks.push({
        detail: `${round(actual)} (expected ${round(expected)} ±${tolerance})`,
        label,
        passed,
      })
    },
    ok: (label, passed, detail = '') => { checks.push({ detail, label, passed }) },
    within: (label, actual, low, high) => {
      const passed = Number.isFinite(actual) && actual > low && actual < high
      checks.push({
        detail: `${round(actual)} (expected strictly between ${round(low)} and ${round(high)})`,
        label,
        passed,
      })
    },
  }
}

const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : String(value))

const frameAt = (frames, fraction) => frames.find((frame) => frame.fraction === fraction)

// Matches each expected `{ from, to }` travel against exactly one animated
// layer, by where that layer sits at 0 % and at 100 %. Identifying layers by
// their measured geometry rather than by their `data-phone-navigation-layer`
// name is deliberate: the same assertions then read a push, a pop and a
// released swipe without a per-case name table.
export const assertTravel = (checks, { frames, prefix, tolerance = 0.01, travels }) => {
  const start = frameAt(frames, 0)
  const middle = frameAt(frames, 0.5)
  const end = frameAt(frames, 1)
  if (!start || !middle || !end) {
    checks.ok(`${prefix}: frames at 0/50/100 %`, false, 'a sample is missing')
    return
  }
  const animated = start.layers.filter((layer) => layer.animated)
  checks.equal(`${prefix}: animated layers`, animated.length, travels.length)

  const taken = new Set()
  for (const travel of travels) {
    const index = start.layers.findIndex((layer, position) => (
      layer.animated
      && !taken.has(position)
      && Math.abs(layer.offset - travel.from) <= tolerance
      && Math.abs(offsetAt(end, position) - travel.to) <= tolerance
    ))
    if (index === -1) {
      checks.ok(
        `${prefix}: ${travel.label} travels ${travel.from} → ${travel.to}`,
        false,
        `no layer matched; 0 % = ${describe(start)}, 100 % = ${describe(end)}`,
      )
      continue
    }
    taken.add(index)
    checks.near(`${prefix}: ${travel.label} at 0 %`, start.layers[index].offset, travel.from, tolerance)
    checks.near(`${prefix}: ${travel.label} at 100 %`, offsetAt(end, index), travel.to, tolerance)
    // Mid-flight means strictly between the ends, clear of each by 2 % of
    // this layer's own travel — scale-free, so it reads a full-width push and
    // a 27 px parallax settle the same way. The band stays curve-agnostic on
    // purpose: the easing is pinned by admin/test/navigation-motion.test.ts,
    // and this suite is here to prove the transition really interpolates and
    // really lands. (The curve is strongly decelerating, so half the time is
    // already ~96 % of the distance — a band tied to the viewport rather than
    // to the travel would fail on the shortest layer.)
    const inset = Math.max(0.0005, Math.abs(travel.to - travel.from) * 0.02)
    const low = Math.min(travel.from, travel.to) + inset
    const high = Math.max(travel.from, travel.to) - inset
    checks.within(`${prefix}: ${travel.label} at 50 %`, offsetAt(middle, index), low, high)
    const span = travel.to - travel.from
    checks.ok(
      `${prefix}: ${travel.label} eased progress at 50 %`,
      true,
      span === 0 ? 'n/a' : String(round((offsetAt(middle, index) - travel.from) / span)),
    )
  }
}

const offsetAt = (frame, index) => frame.layers[index]?.offset ?? Number.NaN

const describe = (frame) => frame.layers
  .map((layer) => `${layer.name}=${round(layer.offset)}`)
  .join(', ')

// The bounce itself: a stack container that scrolled sideways landed the
// slide short of its resting place. Zero at every sampled frame is the
// assertion that catches it (docs/navigation.md §2).
export const assertNoSidewaysScroll = (checks, { frames, prefix }) => {
  for (const frame of frames) {
    const at = `${prefix}: at ${frame.fraction * 100} %`
    checks.equal(`${at} viewport scrollLeft`, frame.viewportScrollLeft, 0)
    for (const layer of frame.layers) {
      checks.equal(`${at} ${layer.name} screen scrollLeft`, layer.scrollLeft, 0)
    }
  }
}
