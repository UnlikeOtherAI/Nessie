import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALL_ASSIGNEES,
  assigneeFilterOptions,
  matchesAssigneeFilter,
  parseAssigneeFilter,
  remoteAssigneeValue,
} from '../src/components/features/projects/kanban/board-assignee-filter'
import type { BoardTaskRecord } from '../src/facades/boards/hooks'

const ME = '11111111-1111-4111-8111-111111111111'
const COLLEAGUE = '22222222-2222-4222-8222-222222222222'

const task = (over: Partial<BoardTaskRecord> = {}): BoardTaskRecord =>
  ({
    id: 'task',
    assigneeUserId: null,
    assigneeAgentId: null,
    externalLink: null,
    columnId: null,
    position: null,
    ...over,
  }) as unknown as BoardTaskRecord

// The sync writes `remoteAssigneeDisplay` only when no identity link resolved
// (board-source-apply.ts), so these two shapes are the mapped/unmapped split.
const unmapped = (externalId: string, displayName: string) =>
  task({
    externalLink: {
      provider: 'linear',
      remoteAssigneeExternalId: externalId,
      remoteAssigneeDisplay: displayName,
    },
  } as unknown as Partial<BoardTaskRecord>)

const mappedRemote = (userId: string) =>
  task({
    assigneeUserId: userId,
    externalLink: {
      provider: 'linear',
      remoteAssigneeExternalId: 'lin_mapped',
      remoteAssigneeDisplay: null,
    },
  } as unknown as Partial<BoardTaskRecord>)

test('"all" keeps every card', () => {
  for (const candidate of [task(), task({ assigneeUserId: ME }), unmapped('lin_1', 'Ada')]) {
    assert.equal(matchesAssigneeFilter(candidate, ALL_ASSIGNEES, ME), true)
  }
})

test('"me" keeps only the viewer\'s own cards', () => {
  assert.equal(matchesAssigneeFilter(task({ assigneeUserId: ME }), 'me', ME), true)
  assert.equal(matchesAssigneeFilter(task({ assigneeUserId: COLLEAGUE }), 'me', ME), false)
  assert.equal(matchesAssigneeFilter(task(), 'me', ME), false)
})

test('"me" matches nothing while the session is still unknown', () => {
  assert.equal(matchesAssigneeFilter(task({ assigneeUserId: ME }), 'me', null), false)
})

test('a provider person nobody is mapped to is not "unassigned"', () => {
  // The card already names them, so treating them as unassigned would claim
  // the work has no owner when the provider says otherwise.
  assert.equal(matchesAssigneeFilter(unmapped('lin_1', 'Ada'), 'unassigned', ME), false)
  assert.equal(matchesAssigneeFilter(task(), 'unassigned', ME), true)
  assert.equal(
    matchesAssigneeFilter(task({ assigneeAgentId: 'agent' } as never), 'unassigned', ME),
    false,
  )
})

test('an unmapped provider person is filtered by their provider id, not their name', () => {
  const ada = unmapped('lin_1', 'Ada Lovelace')
  const otherAda = unmapped('lin_2', 'Ada Lovelace')
  const filter = remoteAssigneeValue('linear', 'lin_1')
  assert.equal(matchesAssigneeFilter(ada, filter, ME), true)
  assert.equal(matchesAssigneeFilter(otherAda, filter, ME), false)
})

test('two providers sharing an external id stay separate people', () => {
  const fromLinear = unmapped('7', 'Seven')
  assert.equal(matchesAssigneeFilter(fromLinear, remoteAssigneeValue('github', '7'), ME), false)
  assert.equal(matchesAssigneeFilter(fromLinear, remoteAssigneeValue('linear', '7'), ME), true)
})

test('a mapped remote person is filtered as the Nessie user, never as a remote option', () => {
  const options = assigneeFilterOptions([mappedRemote(COLLEAGUE)], [])
  assert.deepEqual(options.remote, [])
  assert.equal(matchesAssigneeFilter(mappedRemote(COLLEAGUE), `user:${COLLEAGUE}`, ME), true)
})

test('options offer the whole team plus every unmapped person holding a card', () => {
  const people = [{ id: COLLEAGUE, displayName: 'Grace' }]
  const options = assigneeFilterOptions(
    [unmapped('lin_2', 'Zoe'), unmapped('lin_1', 'Ada'), unmapped('lin_1', 'Ada'), task()],
    people,
  )
  // Everyone assignable, whether or not they hold a card here.
  assert.deepEqual(options.people, people)
  // Deduplicated by provider identity, and ordered for a person reading a list.
  assert.deepEqual(options.remote.map((option) => option.label), ['Ada', 'Zoe'])
})

test('an unrecognised or stale filter falls back to showing everything', () => {
  assert.equal(parseAssigneeFilter(null), ALL_ASSIGNEES)
  assert.equal(parseAssigneeFilter('nonsense'), ALL_ASSIGNEES)
  assert.equal(parseAssigneeFilter('me'), 'me')
  assert.equal(parseAssigneeFilter(`user:${ME}`), `user:${ME}`)
})
