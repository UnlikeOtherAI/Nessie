import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_GOOGLE_CAPABILITIES,
  GOOGLE_CAPABILITIES,
  GOOGLE_IDENTITY_SCOPES,
  GoogleCapabilityListSchema,
  capabilityIsGranted,
  getGoogleCapability,
  scopesForCapabilities,
  usableCapabilities,
} from '../google-capabilities.js'

const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly'
const CONTACTS = 'https://www.googleapis.com/auth/contacts.readonly'
const DIRECTORY = 'https://www.googleapis.com/auth/directory.readonly'

describe('google capability catalog', () => {
  it('gives every capability at least one scope and unique ids', () => {
    const ids = GOOGLE_CAPABILITIES.map((capability) => capability.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const capability of GOOGLE_CAPABILITIES) {
      assert.ok(capability.scopes.length > 0, `${capability.id} has no scope`)
      assert.ok(capability.explains.length > 0)
    }
  })

  it('always includes the identity scopes so a non-Gmail connection can be identified', () => {
    // A calendar-only connection has no Gmail scope, so identity has to come
    // from the OIDC id_token; that only works if these are always requested.
    const scopes = scopesForCapabilities(['calendar.read'])
    for (const identityScope of GOOGLE_IDENTITY_SCOPES) {
      assert.ok(scopes.includes(identityScope), `missing ${identityScope}`)
    }
  })

  it('de-duplicates scopes across capabilities', () => {
    const scopes = scopesForCapabilities(['gmail.read', 'gmail.read'])
    assert.equal(new Set(scopes).size, scopes.length)
  })

  it('requires ALL of a multi-scope capability, not any', () => {
    // contacts.read needs contacts + directory. A user who un-ticked one on
    // Google's consent screen must not read as granted.
    assert.equal(capabilityIsGranted('contacts.read', [CONTACTS]), false)
    assert.equal(capabilityIsGranted('contacts.read', [DIRECTORY]), false)
    assert.equal(
      capabilityIsGranted('contacts.read', [CONTACTS, DIRECTORY]),
      true,
    )
  })

  it('treats an empty granted list as granting nothing', () => {
    for (const capability of GOOGLE_CAPABILITIES) {
      assert.equal(capabilityIsGranted(capability.id, []), false)
    }
  })

  it('excludes a locally blocked capability even when Google granted it', () => {
    const usable = usableCapabilities({
      grantedScopes: [GMAIL_READONLY],
      disabledCapabilities: ['gmail.read'],
    })
    assert.deepEqual(usable, [])
  })

  it('lists a granted, unblocked capability', () => {
    const usable = usableCapabilities({
      grantedScopes: [GMAIL_READONLY],
      disabledCapabilities: [],
    })
    assert.deepEqual(usable, ['gmail.read'])
  })

  it('keeps free/busy on its own scope, not the calendar read scope', () => {
    const freebusy = getGoogleCapability('calendar.freebusy')
    const read = getGoogleCapability('calendar.read')
    assert.notDeepEqual(freebusy.scopes, read.scopes)
    assert.equal(
      capabilityIsGranted('calendar.freebusy', [...read.scopes]),
      false,
    )
  })

  it('does not let gmail.send satisfy the drafting capability', () => {
    // users.drafts.create/send accept gmail.compose or gmail.modify only.
    const send = getGoogleCapability('gmail.send')
    assert.equal(capabilityIsGranted('gmail.compose', [...send.scopes]), false)
  })

  it('rejects an unknown capability id', () => {
    assert.equal(GoogleCapabilityListSchema.safeParse(['nope']).success, false)
    assert.equal(GoogleCapabilityListSchema.safeParse([]).success, false)
    assert.equal(
      GoogleCapabilityListSchema.safeParse(['gmail.read']).success,
      true,
    )
    assert.throws(() =>
      getGoogleCapability('nope' as never),
    )
  })

  it('defaults to the pre-catalog behaviour', () => {
    assert.deepEqual([...DEFAULT_GOOGLE_CAPABILITIES], [
      'gmail.read',
      'meet.create',
    ])
  })
})
