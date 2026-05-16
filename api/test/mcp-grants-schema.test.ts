import assert from 'node:assert/strict'
import test from 'node:test'

import { CreateGrantBodySchema } from '../src/routes/mcp.js'

/**
 * Regression coverage for task #21.
 *
 * The Slice-C audit flagged inconsistent UUID validation on grant route
 * principal IDs. These tests lock in `z.string().uuid()` on `roleId` and
 * `agentId` so a future "fix" that drops the `.uuid()` constraint trips a
 * loud failure here instead of leaking malformed strings to Prisma.
 */

const VALID_ROLE = '00000000-0000-4000-8000-0000000000aa'
const VALID_AGENT = '00000000-0000-4000-8000-0000000000bb'

test('CreateGrantBodySchema accepts a valid UUID roleId', () => {
  const parsed = CreateGrantBodySchema.safeParse({ roleId: VALID_ROLE })
  assert.equal(parsed.success, true)
})

test('CreateGrantBodySchema accepts a valid UUID agentId', () => {
  const parsed = CreateGrantBodySchema.safeParse({ agentId: VALID_AGENT })
  assert.equal(parsed.success, true)
})

test('CreateGrantBodySchema rejects a non-UUID roleId', () => {
  const parsed = CreateGrantBodySchema.safeParse({ roleId: 'not-a-uuid' })
  assert.equal(parsed.success, false)
  if (!parsed.success) {
    const issue = parsed.error.issues.find((i) => i.path.join('.') === 'roleId')
    assert.ok(issue, 'expected a validation issue on roleId')
  }
})

test('CreateGrantBodySchema rejects a non-UUID agentId', () => {
  const parsed = CreateGrantBodySchema.safeParse({ agentId: 'still-not-a-uuid' })
  assert.equal(parsed.success, false)
  if (!parsed.success) {
    const issue = parsed.error.issues.find((i) => i.path.join('.') === 'agentId')
    assert.ok(issue, 'expected a validation issue on agentId')
  }
})

test('CreateGrantBodySchema rejects when both roleId and agentId are supplied', () => {
  const parsed = CreateGrantBodySchema.safeParse({
    roleId: VALID_ROLE,
    agentId: VALID_AGENT,
  })
  assert.equal(parsed.success, false)
})

test('CreateGrantBodySchema rejects when neither principal id is supplied', () => {
  const parsed = CreateGrantBodySchema.safeParse({})
  assert.equal(parsed.success, false)
})

test('CreateGrantBodySchema allows null roleId paired with valid agentId', () => {
  const parsed = CreateGrantBodySchema.safeParse({
    roleId: null,
    agentId: VALID_AGENT,
  })
  assert.equal(parsed.success, true)
})
