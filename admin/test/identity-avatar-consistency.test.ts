import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  identityInitials,
  identityRingRadius,
  identityTileRadius,
} from '../src/components/primitives/identity-shape.js'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return walk(path)
    return entry.name.endsWith('.tsx') || entry.name.endsWith('.ts') ? [path] : []
  })

test('the corner radius scales with the tile', () => {
  // The whole point: one class could not do this. `--radius-md` is re-declared
  // on `:root`, so `rounded-md` was a flat 10px — a circle at 18px and a square
  // at 96px.
  assert.equal(identityTileRadius(18), 5)
  assert.equal(identityTileRadius(24), 7)
  assert.equal(identityTileRadius(96), 27)
  // 36px is the message-feed avatar and keeps exactly what it had.
  assert.equal(identityTileRadius(36), 10)
  // Never round enough to read as a circle, at any size.
  for (const size of [12, 16, 18, 20, 24, 28, 32, 36, 46, 64, 96, 128]) {
    assert.ok(identityTileRadius(size) < size / 2, `${size} rounds to a circle`)
  }
  // Monotonic, so a bigger tile is never more sharply cornered than a smaller.
  for (let size = 8; size < 200; size += 1) {
    assert.ok(identityTileRadius(size + 1) >= identityTileRadius(size))
  }
})

test('a ring drawn around a tile follows the tile', () => {
  assert.equal(identityRingRadius(36), identityTileRadius(36))
  assert.equal(identityRingRadius(36, 1), identityTileRadius(36) + 1)
})

test('initials cap at two letters and survive a name that yields none', () => {
  assert.equal(identityInitials('Ondrej Rafaj'), 'OR')
  assert.equal(identityInitials('KiloResearcher'), 'K')
  assert.equal(identityInitials('a b c d'), 'AB')
  assert.equal(identityInitials('   '), 'N')
  assert.equal(identityInitials('', 'W'), 'W')
  // A name whose first character is astral must not be cut mid-surrogate.
  assert.equal(identityInitials('𝔄da Lovelace'), '𝔄L')
})

test('nothing outside IdentityTile draws an identity picture', () => {
  // The defect this replaced: twelve radii across seventeen hand-rolled tiles,
  // so the same agent was a purple circle in one panel and a portrait in the
  // next. A new inline tile is the fork coming back — fail here instead.
  const offenders = walk(SRC)
    .filter((path) => !path.endsWith('IdentityTile.tsx'))
    .flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      const hits: string[] = []
      if (/background:\s*agentGradient/.test(source)) hits.push('agentGradient tile')
      if (/getDmStyle|dmGradients/.test(source)) hits.push('DM gradient palette')
      return hits.map((hit) => `${path.slice(SRC.length + 1)}: ${hit}`)
    })
  assert.deepEqual(offenders, [])
})

test('the identity palette has exactly one source', () => {
  // Prose may name it; only one module may import it. Two readers is how the
  // sidebar's flat purple and the channel's palette colour drifted apart.
  const importers = walk(SRC).filter((path) =>
    /import\s[^\n]*AGENT_AVATAR_BACKGROUND_COLORS/.test(readFileSync(path, 'utf8')),
  )
  assert.deepEqual(
    importers.map((path) => path.slice(SRC.length + 1)),
    ['components/shared/AgentAvatar.tsx'],
  )
})

test('the native chrome uses the same shape contract as the web', () => {
  // The Expo app does not build against the admin bundle, so the contract is
  // duplicated. A drift here is a native header whose tiles disagree with the
  // WebView an inch below it.
  const web = readFileSync(join(SRC, 'components/primitives/identity-shape.ts'), 'utf8')
  const native = readFileSync(
    fileURLToPath(new URL('../../mobile/src/lib/identity-shape.ts', import.meta.url)),
    'utf8',
  )
  const radius = /Math\.max\(3, Math\.round\(size \* 0\.28\)\)/
  assert.match(web, radius)
  assert.match(native, radius)

  // And the same initials, so a person without a picture is not "OR" in the
  // WebView and "O" in the header above it.
  const initials = /\.slice\(0, 2\)[\s\S]*?\[\.\.\.part\]\[0\]\?\.toUpperCase\(\)/
  assert.match(web, initials)
  assert.match(native, initials)
})

test('the native chrome draws one identity tile, not a circle beside a square', () => {
  const nativeDir = fileURLToPath(new URL('../../mobile/src/components', import.meta.url))
  const offenders = readdirSync(nativeDir)
    .filter((name) => name.endsWith('.tsx'))
    .filter((name) => {
      const source = readFileSync(join(nativeDir, name), 'utf8')
      // A radius derived from the size is the circle formula; the shared
      // contract is the only thing allowed to decide a tile's corner.
      return /borderRadius:\s*(?:avatarDiameter|size|diameter)\s*\/\s*2/.test(source)
    })
  assert.deepEqual(offenders, [])
})
