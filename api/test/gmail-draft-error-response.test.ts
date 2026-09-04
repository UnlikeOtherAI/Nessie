import assert from 'node:assert/strict'
import test from 'node:test'

import { GmailDraftError } from '@nessie/team-admin'
import { gmailDraftErrorResponse } from '../src/routes/gmail-drafts.js'

test('the shared Gmail draft route failure response never exposes provider diagnostics', () => {
  const providerDetail = [
    'Bearer credential-private-token',
    'HTTP 502 from gmail.provider-private.test',
    'recipient-private@example.test',
    'subject-private-token',
    'body-private-token',
  ].join(' | ')
  const response = gmailDraftErrorResponse(new GmailDraftError('PROVIDER_FAILED', providerDetail))
  const browserBody = JSON.stringify({ error: { code: response.code, message: response.message } })

  assert.equal(response.statusCode, 502)
  assert.equal(response.code, 'PROVIDER_FAILED')
  assert.equal(
    response.message,
    'Gmail could not complete this request. Check the connected account and try again.',
  )
  for (const token of providerDetail.split(' | ')) assert.doesNotMatch(browserBody, new RegExp(token))
})

test('other typed Gmail draft errors retain their useful existing copy', () => {
  const response = gmailDraftErrorResponse(new GmailDraftError('DRAFT_CHANGED'))

  assert.equal(response.statusCode, 409)
  assert.equal(response.code, 'DRAFT_CHANGED')
  assert.match(response.message, /draft changed/)
})
