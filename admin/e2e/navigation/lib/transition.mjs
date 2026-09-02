// The shared shape of a transition case: put the app in a known settled
// state, arm the freezer, perform the real interaction, then seek the real
// animation to 0 %, 50 % and 100 % and measure.
//
// One interaction per saved frame, deliberately. The stack closes its own
// transition on a fallback timer shortly after the animation's nominal end,
// so a single run cannot hold a frozen frame long enough for three
// screenshots — while the numbers for all three fractions are read in one
// synchronous evaluate, well inside that window, and are therefore never
// racing it.
import { armFreeze, disarmFreeze, measureFrames, seekTo, waitForFrozen, waitForStackSettled } from './freeze.mjs'
import { assertNoSidewaysScroll, assertTravel, createChecks } from './expect.mjs'
import { shot } from './page.mjs'

const SAMPLES = [
  { file: '00-start', fraction: 0 },
  { file: '01-midway', fraction: 0.5 },
  { file: '02-settled', fraction: 1 },
]

export const captureTransition = async ({ caseName, page, prepare, tolerance = 0.01, travels, trigger }) => {
  const checks = createChecks(caseName)
  const frames = []
  let first = null

  for (const sample of SAMPLES) {
    await prepare(page)
    await waitForStackSettled(page)
    await armFreeze(page)
    const triggered = (await trigger(page)) ?? {}
    await waitForFrozen(page)
    const measurement = await measureFrames(page, [0, 0.5, 1])
    first ??= measurement

    // Each run measures all three fractions; the label says which frame
    // that run went on to save, so a failure names the run that produced it.
    const prefix = `${caseName} (run for ${sample.file})`
    const expected = typeof travels === 'function'
      ? travels({ measurement, triggered })
      : travels
    checks.ok(`${prefix}: animation duration recorded`, measurement.durationsMs.every((ms) => ms > 0),
      measurement.durationsMs.join(', '))
    assertTravel(checks, { frames: measurement.frames, prefix, tolerance, travels: expected })
    assertNoSidewaysScroll(checks, { frames: measurement.frames, prefix })

    await seekTo(page, sample.fraction)
    frames.push(await shot(page, caseName, sample.file))
    await disarmFreeze(page)
  }

  checks.close()
  return { checks: checks.checks, frames, measurement: first }
}
