import assert from 'node:assert/strict'
import test from 'node:test'

import {
  agentMailboxAuditMetadata,
  connectedMailboxAuditMetadata,
} from '../src/services/mailbox-audit.js'

const expectContentFree = (metadata: unknown): void => {
  const serialized = JSON.stringify(metadata)
  for (const forbidden of [
    'person@example.com',
    'replacement-secret',
    'imap.example.com',
    'smtp.example.com',
    'mail-user',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `audit metadata exposed ${forbidden}`)
  }
}

test('mailbox lifecycle audit metadata is structural and content-free', () => {
  const userConnection = connectedMailboxAuditMetadata('user')
  const teamConnection = connectedMailboxAuditMetadata('team')
  const created = agentMailboxAuditMetadata.created('agent-id')
  const updated = agentMailboxAuditMetadata.updated('always_ask')
  const retired = agentMailboxAuditMetadata.retired()

  assert.deepEqual(userConnection, { scope: 'user' })
  assert.deepEqual(teamConnection, { scope: 'team' })
  assert.deepEqual(created, { agentId: 'agent-id' })
  assert.deepEqual(updated, { sendPolicy: 'always_ask' })
  assert.deepEqual(retired, { addressRetired: true })
  for (const metadata of [userConnection, teamConnection, created, updated, retired]) {
    expectContentFree(metadata)
  }
})
