import assert from 'node:assert/strict'
import test from 'node:test'

import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  humaniseEmailLocalPart,
  memberDisplayName,
} from '../src/lib/member-display-name.js'
import { AgentOwnerCell } from '../src/components/features/agents/AgentOwnerCell.js'

/**
 * Nobody who joins through UOA by e-mail is asked for a name, so the roster,
 * the owner cell and the candidate list all read "Unnamed member" for real
 * people whose address said exactly who they were (2026-09-13 invitation e2e
 * run, F6). The label is now derived at render time; nothing is stored.
 */

;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

test('an address becomes a name', () => {
  assert.equal(humaniseEmailLocalPart('nessie-test-a@unlikeotherai.com'), 'Nessie Test A')
  assert.equal(humaniseEmailLocalPart('john.doe@example.com'), 'John Doe')
  assert.equal(humaniseEmailLocalPart('john.doe+nessie@example.com'), 'John Doe')
  assert.equal(humaniseEmailLocalPart('ada_lovelace@example.com'), 'Ada Lovelace')
  // No `@` at all: a bare local part is humanised the same way.
  assert.equal(humaniseEmailLocalPart('grace-hopper'), 'Grace Hopper')
  // The rest of each word is left as written, so an initialism survives.
  assert.equal(humaniseEmailLocalPart('rnd.team@example.com'), 'Rnd Team')
  assert.equal(humaniseEmailLocalPart('NASA.ops@example.com'), 'NASA Ops')
})

test('nothing usable answers undefined rather than a placeholder', () => {
  for (const value of [undefined, null, '', '   ', '@example.com', '...@example.com', '+tag@example.com']) {
    assert.equal(humaniseEmailLocalPart(value), undefined, `${String(value)} yields no name`)
  }
})

test('an asserted name wins, an address-shaped one does not', () => {
  assert.equal(memberDisplayName('Ada Lovelace', 'ada@example.com'), 'Ada Lovelace')
  assert.equal(memberDisplayName(undefined, 'ada.lovelace@example.com'), 'Ada Lovelace')
  // UOA fills `name` with the address for accounts that supplied none; that is
  // not an assertion about anyone's name.
  assert.equal(
    memberDisplayName('nessie-test-a@unlikeotherai.com', 'nessie-test-a@unlikeotherai.com'),
    'Nessie Test A',
  )
  // A projection with no address at all still humanises the address-shaped name.
  assert.equal(memberDisplayName('nessie-test-a@unlikeotherai.com'), 'Nessie Test A')
  assert.equal(memberDisplayName(undefined, undefined), undefined)
  // A name that merely contains a space and an address is a name.
  assert.equal(memberDisplayName('Ada <ada@example.com>'), 'Ada <ada@example.com>')
})

test('the agent owner cell shows the humanised address, never "Unnamed member"', () => {
  const html = renderToStaticMarkup(
    createElement(AgentOwnerCell, {
      owner: {
        displayName: 'nessie-test-a@unlikeotherai.com',
        ownerState: 'active' as const,
        userId: '00000000-0000-4000-8000-00000000000a',
      },
      token: null,
    }),
  )
  assert.match(html, /Nessie Test A/)
  assert.doesNotMatch(html, /Unnamed member/)
  assert.doesNotMatch(html, /unlikeotherai\.com/, 'the raw address is not the label')
})
