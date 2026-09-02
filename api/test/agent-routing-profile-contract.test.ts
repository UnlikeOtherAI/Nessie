import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { AgentRecordSchema } from '@nessie/schemas'

import {
  CreateAgentBodySchema,
  UpdateAgentBodySchema,
} from '../src/contracts/agents.js'

/**
 * `Agent.routingProfileId` is a server/bootstrap-only column: no client sends
 * it, no write path sets it, and the run path passes a hardcoded `null` instead
 * of reading it. The create contract used to advertise it anyway and the route
 * dropped it before `createAgentRecord`, so a caller was promised a persistence
 * that never happened. These tests pin the contract to what the server actually
 * does — the honest shape is the field's absence, on both the write and the
 * read side.
 */

test('the agent create contract does not advertise routingProfileId', () => {
  assert.equal(
    Object.keys(CreateAgentBodySchema.shape).includes('routingProfileId'),
    false,
  )
})

test('a create body carrying routingProfileId parses without it', () => {
  const parsed = CreateAgentBodySchema.safeParse({
    name: 'Router',
    routingProfileId: randomUUID(),
  })
  assert.equal(parsed.success, true)
  assert.equal(
    parsed.success ? Object.hasOwn(parsed.data, 'routingProfileId') : true,
    false,
  )
})

test('the agent update contract likewise carries no routingProfileId', () => {
  assert.equal(
    Object.keys(UpdateAgentBodySchema.shape).includes('routingProfileId'),
    false,
  )
  const parsed = UpdateAgentBodySchema.safeParse({
    name: 'Router',
    routingProfileId: randomUUID(),
  })
  assert.equal(parsed.success, true)
  assert.equal(
    parsed.success ? Object.hasOwn(parsed.data, 'routingProfileId') : true,
    false,
  )
})

test('the agent record contract does not promise a routing profile either', () => {
  assert.equal(
    Object.keys(AgentRecordSchema.shape).includes('routingProfileId'),
    false,
  )
})
