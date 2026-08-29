import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppTrustLevel } from '@nessie/schemas'

import {
  appTrustBadge,
  showsTrustBadgeOnCard,
} from '../src/components/features/apps/app-trust.js'

/**
 * How much the instance vouches for an app, said in one chip. The chip must
 * read the same on the card and in the detail hero, so clicking through never
 * changes the story about who published the thing.
 */

const LEVELS: readonly AppTrustLevel[] = ['nessie', 'verified', 'community', 'unknown', 'blocked']

test('the badge carries an icon identity, a word, and a sentence saying what the word means', () => {
  assert.deepEqual(appTrustBadge('nessie'), {
    iconId: 'shield',
    label: 'Nessie',
    description: 'Built and reviewed by Nessie.',
    toneClass: 'bg-[color:var(--accent-soft)] text-[color:var(--thinking)]',
  })
  assert.deepEqual(appTrustBadge('blocked'), {
    iconId: 'blocked',
    label: 'Blocked',
    description: 'Turned off for this organisation.',
    toneClass: 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
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

test('every tone is a theme token, so a chip is legible on every theme rather than one', () => {
  for (const level of LEVELS) {
    const { toneClass } = appTrustBadge(level)
    const colours = [...toneClass.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1])
    assert.ok(colours.length > 0, level)
    for (const colour of colours) {
      assert.match(colour ?? '', /^color:var\(--[a-z0-9-]+\)$/, `${level}: ${colour}`)
    }
  }
})

test('the Nessie chip avoids --accent-strong, which sinks into the panel on dark themes', () => {
  // `--thinking` is the accent-family foreground each theme already tuned to
  // sit on `--accent-soft`.
  assert.ok(!appTrustBadge('nessie').toneClass.includes('--accent-strong'))
})

test('only Unknown is withheld from the card — printing it on every custom app is noise', () => {
  assert.equal(showsTrustBadgeOnCard('unknown'), false)
  for (const level of LEVELS.filter((entry) => entry !== 'unknown')) {
    assert.equal(showsTrustBadgeOnCard(level), true, level)
  }
})
