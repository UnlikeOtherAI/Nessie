import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutorCodingSessionsFacts } from '@nessie/schemas'
import { codingBridgeArguments, codingSessionDescriptors } from './coding-session-tools.js'

const facts = { agents: ['terminal'], rootNames: ['projects'] } as ExecutorCodingSessionsFacts
const send = (args: Record<string, unknown>) => codingBridgeArguments('terminal_session_write', {
  sessionId: 'session', ...args,
}, facts)

test('terminal keys become actual control bytes while command text stays exact', () => {
  assert.equal(send({ key: 'Submit' }).message, '\u001b[13;1u')
  assert.equal(send({ key: 'Enter' }).message, '\r')
  assert.equal(send({ key: 'CtrlC' }).message, '\u0003')
  const command = 'Write-Output "C:\\reports\\new"'
  assert.deepEqual(send({ data: command }), { message: command, sessionId: 'session', terminal: true })
  assert.equal(send({ data: '\\r' }).message, '\\r', 'literal escapes in commands are never rewritten')
})

test('ambiguous or unsupported key input cannot reach the executor', () => {
  for (const args of [{}, { key: 'unsupported' }, { key: 'Enter', data: 'command' }, { data: '' }]) {
    assert.throws(() => send(args), /either terminal text/)
  }
  const descriptor = codingSessionDescriptors(facts).find((tool) => tool.toolName === 'terminal_session_write')!
  assert.match(descriptor.description, /key="Submit"/)
  assert.deepEqual(descriptor.inputSchema.oneOf, [{ required: ['data'] }, { required: ['key'] }])
})
