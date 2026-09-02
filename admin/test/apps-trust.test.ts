import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppTrustLevel } from '@nessie/schemas'

import {
  appTrustBadge,
  showsTrustBadgeOnCard,
} from '../src/components/features/apps/app-trust.js'
import type { PillTone } from '../src/components/primitives/Pill.js'

/**
 * How much the instance vouches for an app, said in one chip. The chip must
 * read the same on the card and in the detail hero, so clicking through never
 * changes the story about who published the thing.
 */

const LEVELS: readonly AppTrustLevel[] = ['nessie', 'verified', 'community', 'unknown', 'blocked']

const PILL_TONES: readonly PillTone[] = [
  'accent',
  'danger',
  'info',
  'muted',
  'outline',
  'success',
  'warning',
]

test('the badge carries an icon identity, a word, and a sentence saying what the word means', () => {
  assert.deepEqual(appTrustBadge('nessie'), {
    iconId: 'shield',
    label: 'Nessie',
    description: 'Built and reviewed by Nessie.',
    tone: 'accent',
  })
  assert.deepEqual(appTrustBadge('blocked'), {
    iconId: 'blocked',
    label: 'Blocked',
    description: 'Turned off for this organisation.',
    tone: 'danger',
  })
})

test('every trust level is distinguishable — same-looking chips would say nothing', () => {
  const labels = LEVELS.map((level) => appTrustBadge(level).label)
  const iconIds = LEVELS.map((level) => appTrustBadge(level).iconId)
  assert.equal(new Set(labels).size, LEVELS.length)
  assert.equal(new Set(iconIds).size, LEVELS.length)
  for (const level of LEVELS) {
    // The label is a word; the title is what makes it mean something.
    assert.ok(appTrustBadge(level).description.endsWith('.'), level)
  }
})

test('every tone is one of the shared Pill tones, so a chip is legible on every theme rather than one', () => {
  for (const level of LEVELS) {
    const { tone } = appTrustBadge(level)
    assert.ok(PILL_TONES.includes(tone), `${level}: ${tone}`)
  }
})

test('the Nessie chip uses the accent tone — the exact pair Pill avoids sinking into the panel on dark themes', () => {
  // `Pill`'s own `accent` tone renders on `--thinking`, the accent-family
  // foreground every theme already tuned to sit on `--accent-soft`, rather
  // than the raw `--accent`/`--accent-strong` fill that disappears into a
  // dark panel — that guarantee now lives once, in `Pill`, not re-typed here.
  assert.equal(appTrustBadge('nessie').tone, 'accent')
})

test('only Unknown is withheld from the card — printing it on every custom app is noise', () => {
  assert.equal(showsTrustBadgeOnCard('unknown'), false)
  for (const level of LEVELS.filter((entry) => entry !== 'unknown')) {
    assert.equal(showsTrustBadgeOnCard(level), true, level)
  }
})
