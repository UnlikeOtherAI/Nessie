import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseSessionClientType,
  SESSION_CLIENT_HEADER,
} from '../src/services/session-client.ts'

test('native session client metadata accepts the fixed shell vocabulary only', () => {
  assert.equal(SESSION_CLIENT_HEADER, 'x-nessie-session-client')
  assert.equal(parseSessionClientType('native-desktop'), 'native-desktop')
  assert.equal(parseSessionClientType('native-ios'), 'native-ios')
  assert.equal(parseSessionClientType('browser-safari'), null)
  assert.equal(parseSessionClientType(['native-ios']), null)
})
