import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BREAKPOINT_NAMES,
  deriveBand,
  deriveSnapshot,
  parseCssLengthToPx,
  readBreakpointThresholds,
  type BreakpointName,
} from '../src/hooks/useViewport'

// Thresholds equal to the Tailwind defaults that styles.css's @theme static block
// declares; the store itself reads the emitted tokens, so the test pins the contract.
const THRESHOLDS = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 }
const NO_CAPABILITIES = { hover: false, coarsePointer: false }

const atWidth = (width: number) => (name: BreakpointName) => width >= THRESHOLDS[name]

test('band is base below the sm minimum', () => {
  const snapshot = deriveSnapshot(atWidth(639), NO_CAPABILITIES)
  assert.equal(snapshot.band, 'base')
  assert.deepEqual(snapshot.atLeast, { sm: false, md: false, lg: false, xl: false, '2xl': false })
})

test('band boundaries are inclusive minimums, so no gap exists at the edge', () => {
  assert.equal(deriveSnapshot(atWidth(639), NO_CAPABILITIES).band, 'base')
  assert.equal(deriveSnapshot(atWidth(640), NO_CAPABILITIES).band, 'sm')
  assert.equal(deriveSnapshot(atWidth(767), NO_CAPABILITIES).band, 'sm')
  assert.equal(deriveSnapshot(atWidth(768), NO_CAPABILITIES).band, 'md')
  assert.equal(deriveSnapshot(atWidth(1023), NO_CAPABILITIES).band, 'md')
  assert.equal(deriveSnapshot(atWidth(1024), NO_CAPABILITIES).band, 'lg')
  assert.equal(deriveSnapshot(atWidth(1279), NO_CAPABILITIES).band, 'lg')
  assert.equal(deriveSnapshot(atWidth(1280), NO_CAPABILITIES).band, 'xl')
  assert.equal(deriveSnapshot(atWidth(1535), NO_CAPABILITIES).band, 'xl')
  assert.equal(deriveSnapshot(atWidth(1536), NO_CAPABILITIES).band, '2xl')
})

test('every named minimum at or under the width reports atLeast', () => {
  const snapshot = deriveSnapshot(atWidth(1_300), NO_CAPABILITIES)
  assert.equal(snapshot.band, 'xl')
  assert.deepEqual(snapshot.atLeast, { sm: true, md: true, lg: true, xl: true, '2xl': false })
})

test('deriveBand picks the highest matching minimum only', () => {
  assert.equal(
    deriveBand({ sm: true, md: true, lg: false, xl: false, '2xl': false }),
    'md',
  )
  assert.equal(deriveBand({ sm: false, md: false, lg: false, xl: false, '2xl': false }), 'base')
})

test('capabilities pass through untouched by band derivation', () => {
  const snapshot = deriveSnapshot(atWidth(2_000), { hover: true, coarsePointer: true })
  assert.equal(snapshot.band, '2xl')
  assert.deepEqual(snapshot.capabilities, { hover: true, coarsePointer: true })
})

test('parseCssLengthToPx reads px and rem (root font size 16)', () => {
  assert.equal(parseCssLengthToPx('48rem'), 768)
  assert.equal(parseCssLengthToPx(' 40rem '), 640)
  assert.equal(parseCssLengthToPx('1024px'), 1_024)
  assert.equal(parseCssLengthToPx('2.5rem'), 40)
  assert.equal(parseCssLengthToPx(''), null)
  assert.equal(parseCssLengthToPx('48em'), null)
  assert.equal(parseCssLengthToPx('nonsense'), null)
})

test('readBreakpointThresholds parses every named token', () => {
  const tokens: Record<string, string> = {
    '--breakpoint-sm': '40rem',
    '--breakpoint-md': '48rem',
    '--breakpoint-lg': '64rem',
    '--breakpoint-xl': '80rem',
    '--breakpoint-2xl': '96rem',
  }
  assert.deepEqual(readBreakpointThresholds((name) => tokens[name] ?? ''), THRESHOLDS)
})

test('readBreakpointThresholds reports a missing token as null (dev fails loud)', () => {
  const tokens: Record<string, string> = {
    '--breakpoint-sm': '40rem',
    '--breakpoint-md': '',
    '--breakpoint-lg': '64rem',
    '--breakpoint-xl': '80rem',
    '--breakpoint-2xl': '96rem',
  }
  assert.equal(readBreakpointThresholds((name) => tokens[name] ?? ''), null)
})

test('the breakpoint scale is exactly the five Tailwind defaults', () => {
  assert.deepEqual([...BREAKPOINT_NAMES], ['sm', 'md', 'lg', 'xl', '2xl'])
})

test('named one-off media lanes pass through the snapshot untouched', () => {
  // The 600x600 tablet gate is two-dimensional, so it rides a named lane owned
  // by navigation/mobile-shell.ts rather than the width-only band scale.
  const snapshot = deriveSnapshot(atWidth(768), NO_CAPABILITIES, { tabletMin: true })
  assert.equal(snapshot.band, 'md')
  assert.deepEqual(snapshot.media, { tabletMin: true })
})

test('media lanes default to an empty record', () => {
  assert.deepEqual(deriveSnapshot(atWidth(500), NO_CAPABILITIES).media, {})
})
