import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  NAV_MOTION,
  runStackTransition,
  stackDurationMs,
  stackPoses,
} from '../src/navigation/motion'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('a forward push travels the top layer home and parks the lower layer at the parallax offset', () => {
  const poses = stackPoses('forward', 1)
  assert.equal(poses.top.from, 'translate3d(100.00%, 0, 0)')
  assert.equal(poses.top.to, 'translate3d(0.00%, 0, 0)')
  assert.equal(poses.bottom.from, 'translate3d(0.00%, 0, 0)')
  assert.equal(poses.bottom.to, 'translate3d(-28.00%, 0, 0)')
})

test('a pop reveals the lower layer from wherever the top layer was released', () => {
  const poses = stackPoses('back', 0.4)
  assert.equal(poses.top.from, 'translate3d(40.00%, 0, 0)')
  assert.equal(poses.top.to, 'translate3d(100.00%, 0, 0)')
  assert.equal(poses.bottom.from, 'translate3d(-16.80%, 0, 0)')
  assert.equal(poses.bottom.to, 'translate3d(0.00%, 0, 0)')
})

test('duration scales with remaining travel, floors at the settle minimum, and is zero under reduced motion', () => {
  assert.equal(stackDurationMs('forward', 1, false), NAV_MOTION.durationMs)
  assert.equal(stackDurationMs('back', 0, false), NAV_MOTION.durationMs)
  assert.equal(stackDurationMs('back', 0.5, false), NAV_MOTION.durationMs / 2)
  assert.equal(stackDurationMs('back', 0.95, false), NAV_MOTION.minSettleMs)
  assert.equal(stackDurationMs('forward', 0.1, false), NAV_MOTION.minSettleMs)
  assert.equal(stackDurationMs('forward', 1, true), 0)
  assert.equal(stackDurationMs('back', 0.5, true), 0)
})

test('the route push and the swipe settle read the same duration and curve', () => {
  const styles = readSource('../src/styles.css')
  assert.match(styles, new RegExp(`--nav-duration: ${NAV_MOTION.durationMs}ms;`))
  assert.match(styles, new RegExp(`--nav-parallax: ${Math.round(NAV_MOTION.parallax * 100)}%;`))
  assert.ok(
    styles.includes(`--nav-easing: ${NAV_MOTION.easing};`),
    'the CSS easing token mirrors NAV_MOTION.easing',
  )
  // The curve cannot overshoot: both control points stay inside [0, 1].
  const match = NAV_MOTION.easing.match(/cubic-bezier\(([^)]+)\)/)
  assert.ok(match)
  const [, y1, , y2] = match[1].split(',').map((value) => Number(value.trim()))
  assert.ok(y1 !== undefined && y1 >= 0 && y1 <= 1)
  assert.ok(y2 !== undefined && y2 >= 0 && y2 <= 1)
})

test('without a Web Animations API the transition commits immediately', async () => {
  const run = runStackTransition({
    top: null,
    bottom: null,
    direction: 'forward',
    reducedMotion: false,
  })
  assert.equal(run.durationMs, NAV_MOTION.durationMs)
  await run.finished
  run.cancel()
})

test('with an animation timeline the run finishes when the top layer finishes and cancel stops both', async () => {
  type Fake = { onfinish: (() => void) | null; cancelled: boolean; cancel: () => void }
  const make = (): Fake => {
    const fake: Fake = { onfinish: null, cancelled: false, cancel: () => { fake.cancelled = true } }
    return fake
  }
  const top = make()
  const bottom = make()
  const layer = (fake: Fake) => ({ animate: () => fake }) as unknown as Element
  const run = runStackTransition({
    top: layer(top),
    bottom: layer(bottom),
    direction: 'back',
    progress: 0.3,
    reducedMotion: false,
  })
  let done = false
  void run.finished.then(() => { done = true })
  await Promise.resolve()
  assert.equal(done, false)
  top.onfinish?.()
  await Promise.resolve()
  assert.equal(done, true)
  run.cancel()
  assert.equal(top.cancelled, true)
  assert.equal(bottom.cancelled, true)
})
