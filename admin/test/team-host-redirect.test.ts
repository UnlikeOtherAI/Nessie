import assert from 'node:assert/strict'
import test from 'node:test'

import { teamHostRedirectUrl } from '../src/layouts/admin-shell/team-host-redirect.js'

const hostUrl = 'https://general.nessie-works.nessie.works'

test('a browser follows the switch to the team host', () => {
  assert.equal(
    teamHostRedirectUrl({ currentHost: 'app.nessie.works', hostUrl, inNativeShell: false }),
    `${hostUrl}/channels`,
  )
})

test('a native shell stays on its origin after the switch', () => {
  assert.equal(
    teamHostRedirectUrl({ currentHost: 'app.nessie.works', hostUrl, inNativeShell: true }),
    null,
  )
})

test('the same host, no address, or a malformed address navigates in-app', () => {
  assert.equal(
    teamHostRedirectUrl({
      currentHost: 'general.nessie-works.nessie.works',
      hostUrl,
      inNativeShell: false,
    }),
    null,
  )
  assert.equal(
    teamHostRedirectUrl({ currentHost: 'app.nessie.works', hostUrl: null, inNativeShell: false }),
    null,
  )
  assert.equal(
    teamHostRedirectUrl({ currentHost: 'app.nessie.works', hostUrl: 'not a url', inNativeShell: false }),
    null,
  )
})
