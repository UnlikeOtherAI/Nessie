import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createConsumedSourceSink } from './disclosure-basis.js'
import { runReplyIsRestricted } from './agent-message.js'
import type { RunContext } from './types.js'

// The gate reads exactly four fields off the context; the rest of a RunContext
// is irrelevant to it, so the fixture states only what the predicate consults.
const contextWith = (consumedSources: RunContext['consumedSources']): RunContext =>
  ({
    channel: {
      id: 'channel-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      teamId: 'team-1',
    },
    consumedSources,
  }) as unknown as RunContext

test('a run that has consumed nothing is unrestricted, so it streams', () => {
  assert.equal(runReplyIsRestricted(contextWith(createConsumedSourceSink())), false)
})

test('sources the destination already implies never restrict the stream', () => {
  const sink = createConsumedSourceSink()
  sink.addAll([
    { scopeId: 'org-1', scopeType: 'organization' },
    { scopeId: 'project-1', scopeType: 'project' },
    { scopeId: 'team-1', scopeType: 'team' },
    { scopeId: 'channel-1', scopeType: 'channel' },
  ])

  assert.equal(runReplyIsRestricted(contextWith(sink)), false)
})

test('the gate flips the moment a privileged source is consumed', () => {
  const sink = createConsumedSourceSink()
  const context = contextWith(sink)

  // Iteration 1: nothing privileged yet — this run's text may stream.
  assert.equal(runReplyIsRestricted(context), false)

  // Iteration 2: a tool reads a source the room does not imply.
  sink.add({ scopeId: 'user-9', scopeType: 'user' })

  assert.equal(runReplyIsRestricted(context), true)
})

test('the gate is monotone: consuming an implied source afterwards cannot re-open it', () => {
  const sink = createConsumedSourceSink()
  const context = contextWith(sink)
  sink.add({ scopeId: 'user-9', scopeType: 'user' })
  assert.equal(runReplyIsRestricted(context), true)

  // The sink is additive, so nothing consumed later can shrink the basis. This
  // is what makes the predicate safe to call per delta: a stream that has been
  // cut off never resumes mid-reply.
  sink.addAll([
    { scopeId: 'org-1', scopeType: 'organization' },
    { scopeId: 'channel-1', scopeType: 'channel' },
  ])

  assert.equal(runReplyIsRestricted(context), true)
})
