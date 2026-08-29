import assert from 'node:assert/strict'
import test from 'node:test'

import * as queryKeys from '../src/lib/query-keys.js'

/**
 * The prefix rule, enforced instead of asserted.
 *
 * query-keys.ts exists so "invalidating a family's root reaches the whole
 * family" is checkable in one place. A prose list of exceptions in its header
 * is the same thing that rotted everywhere else — it drifts the moment someone
 * adds a key and does not read it. So the rule is a test, and every deliberate
 * exception is data with a reason attached.
 *
 * Adding a key outside its family root fails this test. Removing the need for a
 * listed exception fails it too, so the list cannot outlive its reasons.
 */

// key = `${family}.${member}`. The reason is why nesting would cost more than
// the staleness it fixes — expense, or a shape the parent's consumers misread.
const ROOT_EXCEPTIONS: Record<string, string> = {
  'projectKeys.insights':
    'A velocity/burndown report — one query per completed iteration plus a task-event scan. '
    + 'Nothing that invalidates ["projects"] (rename, delete, membership, board style) can change it.',
  'taskKeys.assignees':
    'AssignableUser[], not TaskRecord[]. The board\'s optimistic sweep over ["tasks"] rewrites every '
    + 'match as TaskRecord[], so nesting would hand it a foreign shape.',
  'taskKeys.documents':
    'Task documents are invalidated by their own mutations (facades/knowledge/task-docs-hooks.ts); '
    + 'no task mutation changes them, and the board sweep over ["tasks"] would misread the shape.',
  'dashboardKeys.embed':
    'An embed is addressed by its own public token, not by the dashboard id, so a dashboard '
    + 'invalidation has no id to reach it with.',
  'dashboardKeys.sources':
    'The org-wide widget source catalogue, not a projection of any one dashboard.',
  'knowledgeKeys.versions':
    'Immutable history. A page edit appends, so the list is refetched by its own mutation rather '
    + 'than by every page invalidation.',
  'knowledgeKeys.attachments':
    'Attachment bytes are immutable and their list changes only through upload/delete, which '
    + 'invalidate it directly.',
}

const isKeyArray = (value: unknown): value is readonly unknown[] => Array.isArray(value)

/** Call a factory with placeholder arguments; optional params default themselves. */
const emit = (member: unknown): readonly unknown[] | null => {
  if (isKeyArray(member)) return member
  if (typeof member !== 'function') return null
  const args = Array.from({ length: member.length }, () => 'x')
  const produced = (member as (...rest: unknown[]) => unknown)(...args)
  return isKeyArray(produced) ? produced : null
}

const families = Object.entries(queryKeys).filter(
  (entry): entry is [string, Record<string, unknown>] =>
    entry[0].endsWith('Keys') && typeof entry[1] === 'object' && entry[1] !== null,
)

test('every key family is reachable from its own root', () => {
  assert.ok(families.length > 20, 'expected the module to export the admin key families')

  const escapes: string[] = []
  for (const [familyName, family] of families) {
    const root = family.all
    if (!isKeyArray(root)) continue

    for (const [memberName, member] of Object.entries(family)) {
      if (memberName === 'all') continue
      const key = emit(member)
      if (!key) continue

      const qualified = `${familyName}.${memberName}`
      const nested = root.every((segment, index) => key[index] === segment)
      if (!nested && !(qualified in ROOT_EXCEPTIONS)) {
        escapes.push(`${qualified} -> ${JSON.stringify(key)} is not under ${JSON.stringify(root)}`)
      }
    }
  }

  assert.deepEqual(
    escapes,
    [],
    'These keys escape their family root. Nest them, or add them to ROOT_EXCEPTIONS with the reason '
      + 'nesting costs more than the staleness it fixes:\n' + escapes.join('\n'),
  )
})

test('no exception outlives its reason', () => {
  const stale: string[] = []
  for (const qualified of Object.keys(ROOT_EXCEPTIONS)) {
    const [familyName, memberName] = qualified.split('.')
    const family = (queryKeys as Record<string, unknown>)[familyName ?? '']
    if (typeof family !== 'object' || family === null) {
      stale.push(`${qualified}: family no longer exists`)
      continue
    }
    const record = family as Record<string, unknown>
    const root = record.all
    const key = emit(record[memberName ?? ''])
    if (!key) {
      stale.push(`${qualified}: member no longer exists`)
      continue
    }
    if (isKeyArray(root) && root.every((segment, index) => key[index] === segment)) {
      stale.push(`${qualified}: now nested under its root — delete the exception`)
    }
  }

  assert.deepEqual(stale, [], stale.join('\n'))
})

test('every family root is the exact prefix its own children are built from', () => {
  // A child that re-spells its root's string is a second definition of the
  // prefix, which is the drift this module removes. Spot-check the families
  // whose roots exist only as a spread base.
  assert.deepEqual(
    queryKeys.appKeys.detail('slug').slice(0, queryKeys.appKeys.all.length),
    [...queryKeys.appKeys.all],
  )
  assert.deepEqual(
    queryKeys.dashboardKeys.widgetDataView('w-1', '').slice(0, 3),
    ['dashboards', 'widget-data', 'w-1'],
  )
  assert.deepEqual(
    queryKeys.workflowKeys.run('r-1').slice(0, queryKeys.workflowKeys.runs.length),
    [...queryKeys.workflowKeys.runs],
  )
})
