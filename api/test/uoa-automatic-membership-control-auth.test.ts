import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'

import {
  reserveUoaAutomaticMembershipControlRequest,
  verifyUoaAutomaticMembershipControlSignature,
} from '../src/services/uoa-automatic-membership-control-auth.js'
import {
  hasExactUoaTeamBindings,
  isUoaControlActionAllowed,
  UoaControlPayloadSchemas,
} from '../src/services/uoa-automatic-membership-control-contract.js'

const secret = 'control-secret'
const timestamp = '1760000000000'
const body = { request_id: 'e2f7e39d-0c4a-46bb-a9e0-0c953497d65b', action: 'list' }
const signature = createHmac('sha256', secret).update(`${timestamp}.${JSON.stringify(body)}`).digest('hex')

test('UOA control HMAC accepts only the exact parsed body in the allowed clock window', () => {
  assert.equal(
    verifyUoaAutomaticMembershipControlSignature(secret, timestamp, signature, body, Number(timestamp)),
    true,
  )
  assert.equal(
    verifyUoaAutomaticMembershipControlSignature(
      secret, timestamp, signature, { ...body, action: 'create' }, Number(timestamp),
    ),
    false,
  )
  assert.equal(
    verifyUoaAutomaticMembershipControlSignature(
      secret, String(Number(timestamp) + 60_001), signature, body, Number(timestamp),
    ),
    false,
  )
  assert.equal(
    verifyUoaAutomaticMembershipControlSignature(undefined, timestamp, signature, body, Number(timestamp)),
    false,
  )
})

test('UOA control replay reservation expires an old request and rejects concurrent duplicates', async () => {
  const calls: string[] = []
  const expired = await reserveUoaAutomaticMembershipControlRequest({
    async deleteMany() { calls.push('delete') },
    async create() { calls.push('create') },
  }, {
    requestId: body.request_id, requestDigest: 'digest', organizationId: 'org', uoaActorSub: 'sub', action: 'list',
    now: new Date('2026-01-01T00:00:00.000Z'), ttlMs: 300_000,
  })
  const duplicate = await reserveUoaAutomaticMembershipControlRequest({
    async deleteMany() {},
    async create() { throw Object.assign(new Error('duplicate'), { code: 'P2002' }) },
  }, {
    requestId: body.request_id, requestDigest: 'digest', organizationId: 'org', uoaActorSub: 'sub', action: 'list', ttlMs: 300_000,
  })
  assert.deepEqual(calls, ['delete', 'create'])
  assert.equal(expired, true)
  assert.equal(duplicate, false)
})

test('UOA control rejects cross-org team mapping and invalid action payloads', () => {
  assert.equal(hasExactUoaTeamBindings(['team-a'], ['team-a']), true)
  assert.equal(hasExactUoaTeamBindings(['team-a'], ['team-b']), false)
  assert.equal(hasExactUoaTeamBindings(['team-a', 'team-a'], ['team-a']), false)
  assert.equal(isUoaControlActionAllowed('teams', 'team'), false)
  assert.equal(isUoaControlActionAllowed('teams', 'organisation'), true)
  assert.equal(UoaControlPayloadSchemas.create.safeParse({ domain: 'example.com', unexpected: true }).success, false)
  assert.equal(
    UoaControlPayloadSchemas.create.safeParse({ domain: 'example.com', team_ids: ['uoa-team'] }).success,
    true,
  )
  assert.equal(UoaControlPayloadSchemas.release.safeParse({ rule_id: body.request_id }).success, true)
})
