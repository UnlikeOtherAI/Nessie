import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ImapError,
  MailDialError,
  MailWireError,
  SmtpError,
} from '@nessie/agent-mail'

import { mailboxConnectionTestFailure } from '../src/index.js'

test('mailbox connection failures retain their structural diagnosis', () => {
  const refused = new ImapError('raw protocol refusal', 'auth')
  const smtpRefused = new SmtpError('raw protocol refusal', 535, 'auth')
  const certificate = new MailDialError('raw TLS failure', 'certificate')
  const unavailable = new MailWireError('raw socket timeout')
  const reset = Object.assign(new Error('raw reset'), { code: 'ECONNRESET' })

  assert.equal(mailboxConnectionTestFailure(refused), 'credential_rejected')
  assert.equal(mailboxConnectionTestFailure(smtpRefused), 'credential_rejected')
  assert.equal(mailboxConnectionTestFailure(certificate), 'invalid_certificate')
  assert.equal(mailboxConnectionTestFailure(unavailable), 'server_unavailable')
  assert.equal(mailboxConnectionTestFailure(reset), 'server_unavailable')
  assert.equal(mailboxConnectionTestFailure(new Error('unknown')), 'test_failed')
})
