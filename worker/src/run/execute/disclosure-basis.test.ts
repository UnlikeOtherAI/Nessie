import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  computeReplyBasis,
  createConsumedSourceSink,
  type BasisScope,
} from './disclosure-basis.js'

const DESTINATION = {
  channelId: 'channel-1',
  organizationId: 'org-1',
  projectId: 'project-1',
  teamId: 'team-1',
}

const scope = (scopeType: string, scopeId: string): BasisScope => ({ scopeId, scopeType })

test('sink de-duplicates repeated sources', () => {
  const sink = createConsumedSourceSink()
  sink.add(scope('project', 'project-2'))
  sink.add(scope('project', 'project-2'))
  sink.addAll([scope('project', 'project-2'), scope('team', 'team-9')])

  assert.equal(sink.size(), 2)
  assert.deepEqual(sink.list(), [
    scope('project', 'project-2'),
    scope('team', 'team-9'),
  ])
})

test('sink ignores empty scope type or id', () => {
  const sink = createConsumedSourceSink()
  sink.add(scope('', 'project-2'))
  sink.add(scope('project', ''))

  assert.equal(sink.size(), 0)
})

test('sink keeps same-id sources under different audience types apart', () => {
  const sink = createConsumedSourceSink()
  sink.add(scope('project', 'shared-id'))
  sink.add(scope('team', 'shared-id'))

  assert.equal(sink.size(), 2)
})

test('a run consuming only destination-implied sources has an empty basis', () => {
  const basis = computeReplyBasis(
    [
      scope('organization', 'org-1'),
      scope('project', 'project-1'),
      scope('team', 'team-1'),
      scope('channel', 'channel-1'),
    ],
    DESTINATION,
    [],
  )

  assert.deepEqual(basis, [])
})

test('a source the destination does not imply becomes the basis', () => {
  const basis = computeReplyBasis(
    [scope('organization', 'org-1'), scope('project', 'project-2')],
    DESTINATION,
    [],
  )

  assert.deepEqual(basis, [scope('project', 'project-2')])
})

test('user-private sources are never implied by a destination', () => {
  const basis = computeReplyBasis([scope('user', 'user-1')], DESTINATION, [])

  assert.deepEqual(basis, [scope('user', 'user-1')])
})

test('a foreign organization is not implied', () => {
  const basis = computeReplyBasis([scope('organization', 'org-2')], DESTINATION, [])

  assert.deepEqual(basis, [scope('organization', 'org-2')])
})

test('implication compares the (type, id) pair, not the id alone', () => {
  // A project whose id equals the destination team's id is still privileged.
  const basis = computeReplyBasis([scope('project', 'team-1')], DESTINATION, [])

  assert.deepEqual(basis, [scope('project', 'team-1')])
})

test('the basis de-duplicates repeated privileged sources', () => {
  const basis = computeReplyBasis(
    [scope('project', 'project-2'), scope('project', 'project-2')],
    DESTINATION,
    [],
  )

  assert.deepEqual(basis, [scope('project', 'project-2')])
})

test('consuming nothing yields an empty basis', () => {
  assert.deepEqual(computeReplyBasis([], DESTINATION, []), [])
})

test('a bound agent is implied by the destination channel', () => {
  assert.deepEqual(
    computeReplyBasis([scope('agent', 'agent-1')], DESTINATION, ['agent-1']),
    [],
  )
})

test('an unbound agent remains in the reply basis', () => {
  assert.deepEqual(
    computeReplyBasis([scope('agent', 'agent-1')], DESTINATION, ['agent-2']),
    [scope('agent', 'agent-1')],
  )
})

test('a child reading its bound parent\'s documents has an unrestricted reply', () => {
  assert.deepEqual(
    computeReplyBasis([scope('agent', 'parent-agent')], DESTINATION, ['parent-agent']),
    [],
  )
})
