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
