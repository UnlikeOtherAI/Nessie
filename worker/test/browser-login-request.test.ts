import assert from 'node:assert/strict'
import test from 'node:test'

import { browserLoginCardDeadline } from '../src/run/browser-cloud/login-request.js'

test('the login card uses the grant deadline after a short deployment TTL', () => {
  const requestedDeadline = new Date('2026-09-07T12:15:00.000Z')
  const hardDeploymentDeadline = new Date('2026-09-07T12:05:00.000Z')

  const cardDeadline = browserLoginCardDeadline({ expiresAt: hardDeploymentDeadline })

  assert.equal(cardDeadline.getTime(), hardDeploymentDeadline.getTime())
  assert.notEqual(cardDeadline.getTime(), requestedDeadline.getTime())
})
