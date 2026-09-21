import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { buildMailboxActorContext } from '../src/control/mailbox-actor-context.js'

test('task-set handoff retains the captured UOA proof without borrowing peer-delegation authority', () => {
  const id = randomUUID()
  const identity = { organizationId: 'uoa-org', teamId: 'uoa-team', subject: 'human-subject', tokenVersion: 7 }
  const input = { actorId: id, actorType: 'user' as const, channelId: id, organizationId: id,
    projectId: id, targetAgentId: id, teamId: id, taskSetId: id, threadId: id, uoaIdentity: identity }
  const context = buildMailboxActorContext(input)
  assert.equal(context.actionContext.purpose, 'task_set.delivery')
  assert.equal(context.actionContext.correlationId, `task-set:${id}`)
  assert.equal(context.actionContext.effectiveUserId, id)
  assert.deepEqual(context.actionContext.uoaIdentity, identity)
  assert.throws(() => buildMailboxActorContext({ ...input, actorType: 'agent' }), /original human/)
  const ordinary = buildMailboxActorContext({ ...input, taskSetId: undefined, actorType: 'agent' })
  assert.equal(ordinary.actionContext.uoaIdentity, undefined)
  assert.equal(ordinary.actionContext.effectiveUserId, undefined)
})
