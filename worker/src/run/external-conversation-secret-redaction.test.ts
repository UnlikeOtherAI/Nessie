import assert from 'node:assert/strict'
import test from 'node:test'

import { sanitizeExternalTurnOutcome } from './external-conversation.js'

test('external conversation replies and cards are safe before any sink', () => {
  const secret = `sk-proj-${'aB3_'.repeat(8)}`
  const safe = sanitizeExternalTurnOutcome({
    agentStatus: 'idle',
    content: secret,
    runStatus: 'completed',
    uiCards: [{ kind: 'integration', status: 'warning', summary: secret, title: 'Sensitive' }],
  })

  assert.equal(JSON.stringify(safe).includes(secret), false)
  assert.match(safe.content, /\[REDACTED_SECRET\]/u)
  assert.match(JSON.stringify(safe.uiCards), /\[REDACTED_SECRET\]/u)
})
